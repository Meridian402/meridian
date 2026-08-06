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
import { dataPath } from "./dataDir.js";
import { getPublicClient, getAgentSigner } from "./venues/signer.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { memeBandsLive, looseInventoryUsd, noteBookMark } from "./memeGuard.js";
import { TREASURY_WALLET } from "./merd/wallets.js";

const EXECUTION: Address = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
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
    const [tEth, xEth, tWeth, xWeth, ethUsd, bands] = await Promise.all([
      client.getBalance({ address: TREASURY_WALLET }),
      client.getBalance({ address: EXECUTION }),
      client.readContract({ address: WETH, abi: [balOf], functionName: "balanceOf", args: [TREASURY_WALLET] }),
      client.readContract({ address: WETH, abi: [balOf], functionName: "balanceOf", args: [EXECUTION] }),
      fetchEthUsd(),
      memeBandsLive(),
    ]);
    if (!ethUsd) return null;
    const banked = ((Number(tEth) + Number(xEth) + Number(tWeth) + Number(xWeth)) / 1e18) * ethUsd;
    const accruing = bands.reduce((s, b) => s + b.feesUsd, 0);
    // Loose venue tokens count too: a sweep remainder is still the book's
    // money, and forgetting it made 2026-08-05's marks read $290 low.
    const loose = await looseInventoryUsd(ethUsd);
    const working = bands.reduce((s, b) => s + b.valueUsd, 0) + accruing + loose;
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
const QUARANTINED: [number, number][] = [[1785972000000, 1785973400000]];

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
    } catch (err) {
      console.error(`[bookSnap] write failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  };
  const timer = setInterval(() => void snap(), 2 * 60 * 1000);
  timer.unref?.();
  void snap();
  return timer;
}
