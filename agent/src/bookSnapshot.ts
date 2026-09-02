// The book snapshot series that drives the live chart. The old equity
// snapshotter (performance.ts) marks the USDG/stock era and runs every 30
// minutes; this marks the CURRENT book on a tight 2-minute cadence so the
// chart moves accurately and continuously for every visitor, instead of each
// browser drawing its own sparse local history.
//
// It computes exactly what the site headline computes: banked (both wallets'
// ETH + WETH) plus working (bands and their accrued fees). One writer, gated
// on the signer, same one-process discipline as everything on the house wallet.
import { existsSync, readFileSync } from "node:fs";
import { parseAbiItem, type Address } from "viem";
import { appendLedger } from "./ledger.js";
import { registerLoop, beat } from "./liveness.js";
import { dataPath } from "./dataDir.js";
import { getPublicClient, getAgentSigner } from "./venues/signer.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { memeBandsLive, looseInventoryUsd, noteBookMark } from "./memeGuard.js";
import { notePortfolioMark } from "./portfolioBreaker.js";
import { lpPositionsWithValue, uncollectedFeesUsd } from "./venues/lpPositions.js";
import { TREASURY_WALLET } from "./merd/wallets.js";

const EXECUTION: Address = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const BOOK_PATH = dataPath("book-snapshots.jsonl");
const balOf = parseAbiItem("function balanceOf(address) view returns (uint256)");

export interface BookPoint {
  ts: number;
  book: number;
  banked: number;
  working: number;
  /** Fees accruing in open bands right now. */
  accruingUsd: number;
  /** Cumulative fee income: the running integral of positive accrual changes.
   *  Monotonic by construction, so a collect moving fees accrued -> banked
   *  never reads as a loss. This is the desk EARNING, cent by cent, distinct
   *  from the mark-to-market book which wobbles with ETH price and inventory. */
  feesUsd: number;
}

/** Mark the whole book now: banked (wallet + treasury ETH/WETH) + working
 *  (bands + accrued fees). Returns null if the reads fail, so a bad sample is
 *  never recorded as a real dip. */
export async function computeBookNow(): Promise<BookPoint | null> {
  const client = getPublicClient();
  try {
    const [tEth, xEth, tWeth, xWeth, tUsdg, xUsdg, ethUsd, bands] = await Promise.all([
      client.getBalance({ address: TREASURY_WALLET }),
      client.getBalance({ address: EXECUTION }),
      client.readContract({ address: WETH, abi: [balOf], functionName: "balanceOf", args: [TREASURY_WALLET] }),
      client.readContract({ address: WETH, abi: [balOf], functionName: "balanceOf", args: [EXECUTION] }),
      client.readContract({ address: USDG, abi: [balOf], functionName: "balanceOf", args: [TREASURY_WALLET] }),
      client.readContract({ address: USDG, abi: [balOf], functionName: "balanceOf", args: [EXECUTION] }),
      fetchEthUsd(),
      memeBandsLive(),
    ]);
    if (!ethUsd) return null;
    // Banked is CASH in both wallets, all three cash assets: ETH, WETH, and
    // USDG (a dollar each). USDG was invisible until 2026-08-14 — the night
    // the desk's first USDG-quoted position opened, ~$226 of real money
    // (position + USDG float) fell out of this gauge and the book "dropped".
    // A gauge that only sees ETH stops being a gauge the day the desk holds
    // dollars.
    const banked = ((Number(tEth) + Number(xEth) + Number(tWeth) + Number(xWeth)) / 1e18) * ethUsd + (Number(tUsdg) + Number(xUsdg)) / 1e6;
    // USDG-quoted LP positions (the stock/RWA sleeve, e.g. PONS) are working
    // capital exactly like the meme bands: value marked to live pool state,
    // plus fees accrued inside and not yet collected. Same read the proof
    // endpoint serves; lpPositionsWithValue THROWS on a failed chain read, so
    // a bad cycle nulls the whole mark rather than printing a fake dip.
    const usdgPositions = await lpPositionsWithValue();
    let usdgPosValue = 0;
    let usdgPosFees = 0;
    for (const p of usdgPositions) {
      usdgPosValue += p.valueUsd;
      usdgPosFees += await uncollectedFeesUsd(p).catch(() => 0);
    }
    const accruing = bands.reduce((s, b) => s + b.feesUsd, 0) + usdgPosFees;
    // Loose venue tokens count too: a sweep remainder is still the book's
    // money, and forgetting it made 2026-08-05's marks read $290 low.
    const loose = await looseInventoryUsd(ethUsd);
    const working = bands.reduce((s, b) => s + b.valueUsd, 0) + usdgPosValue + accruing + loose;
    // Cumulative fee income = prior cumulative + the positive change in
    // accrual since the last snapshot. A drop in accrual (a collect/sweep
    // moving it to the bank) adds nothing and subtracts nothing: that income
    // was already counted as it accrued, so the line holds instead of dipping.
    const prev = readBookHistory(48 * 3600e3, 100_000).slice(-1)[0];
    const feesUsd = prev ? prev.feesUsd + Math.max(0, accruing - prev.accruingUsd) : accruing;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ts: Date.now(),
      book: r2(banked + working),
      banked: r2(banked),
      working: r2(working),
      accruingUsd: r2(accruing),
      feesUsd: r2(feesUsd),
    };
  } catch (err) {
    // Silent nulls hid a dead snapshotter for hours on 2026-08-05; a failed
    // mark is loud now, and still never recorded.
    console.error(`[bookSnap] mark failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  }
}

/** The book series over a window, oldest-first, lightly downsampled so the
 *  chart never has to render thousands of points. */
/** Marks recorded by a KNOWN-BROKEN gauge, quarantined at read time so no
 *  chart or consumer ever renders them as market events. 2026-08-05 ~20:21
 *  to ~20:42: the snapshotter did not count loose wallet tokens and printed
 *  a $290-deep crater that never happened. The raw lines stay in the ledger
 *  (we do not rewrite history); they are just never served as truth. */
export const QUARANTINED: [number, number][] = [
  [1785972000000, 1785973400000],
  // 2026-08-10 23:00Z - 2026-08-11 02:00Z: the operator's buyback night.
  // Wallet approvals, treasury-to-execution shuffles, the swap and the burn,
  // snapshots catching money mid-flight repeatedly (one mark read ~$480 low
  // and tripped the old one-mark breaker), and the flatten that followed. A
  // first pass quarantined 00:20-00:45Z and the distorted trough survived
  // just outside it; a second pass took the 00:00-01:00Z hour and the ET
  // re-bucketing of 2026-08-15 then merged the surviving shoulder marks into
  // one Eastern day, printing a phantom $537 "record drawdown" for Aug 10.
  // Third pass: the whole operator-moves evening goes, 7pm to 10pm Eastern.
  // Nothing in it is a reading of the book.
  [1786402800000, 1786413600000],
  // 2026-08-14 01:55-10:00Z: the night the USDG sleeve armed, recorded by a
  // gauge that could not see dollars. The first ETH->USDG conversion at ~01:56
  // printed as a $127 "loss" (the dollars were real, the gauge was ETH-only),
  // and everything after — the rotor absorbing the operator's WETH, the wedged
  // lock, three restarts, the meme flatten, the PONS open and the surplus sell
  // — is money mid-flight read by that same blind gauge, ~$226 low by the end.
  // The gauge learned to count USDG (cash and LP positions) at the end of this
  // window; marks from then on are whole-book readings.
  [1786672500000, 1786701600000],
  // 2026-08-16 01:25-01:55Z: the NATIVE/USDG bridge pool was displaced to
  // ~$484/ETH for twenty minutes (thin venue, later arbed back) and the
  // gauge's single-source price marked the whole book at quarter value: a
  // phantom $1,658 "drawdown" that fired the breaker's stage-2 halt on a
  // book that had lost nothing. fetchEthUsd is despiked as of this window's
  // close; these marks were priced by a broken ruler, not the market.
  [1786843500000, 1786845300000],
];

export function readBookHistory(windowMs = 24 * 3600e3, maxPoints = 300): BookPoint[] {
  if (!existsSync(BOOK_PATH)) return [];
  const cutoff = Date.now() - windowMs;
  const pts: BookPoint[] = [];
  for (const line of readFileSync(BOOK_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as BookPoint;
      if (p.ts >= cutoff && Number.isFinite(p.book) && !QUARANTINED.some(([a, b]) => p.ts >= a && p.ts <= b)) pts.push(p);
    } catch {
      /* skip a bad line */
    }
  }
  pts.sort((a, b) => a.ts - b.ts);
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out: BookPoint[] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[Math.floor(i)]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]); // always keep the latest
  return out;
}

/** One writer, 2-minute cadence. Gated on the signer so exactly the guard host
 *  records; read-only hosts serve the pushed file. */
export function startBookSnapshotter(): NodeJS.Timeout | undefined {
  if (!getAgentSigner()) return undefined;
  const snap = async () => {
    try {
      const p = await computeBookNow();
      if (!p) return;
      appendLedger("book-snapshots.jsonl", p);
      noteBookMark(p.book); // the circuit breaker rides every good mark
      notePortfolioMark(p.book, p.working); // and so does the portfolio breaker, scaled to total working
    } catch (err) {
      console.error(`[bookSnap] write failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  };
  registerLoop("bookSnapshot", 2 * 60 * 1000);
  const timer = setInterval(() => void snap().finally(() => beat("bookSnapshot")), 2 * 60 * 1000);
  timer.unref?.();
  void snap();
  return timer;
}
