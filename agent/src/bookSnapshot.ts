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
import { memeBandsLive } from "./memeGuard.js";
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
    const working = bands.reduce((s, b) => s + b.valueUsd + b.feesUsd, 0);
    return { ts: Date.now(), book: Math.round((banked + working) * 100) / 100, banked: Math.round(banked * 100) / 100, working: Math.round(working * 100) / 100 };
  } catch {
    return null;
  }
}

/** The book series over a window, oldest-first, lightly downsampled so the
 *  chart never has to render thousands of points. */
export function readBookHistory(windowMs = 24 * 3600e3, maxPoints = 300): BookPoint[] {
  if (!existsSync(BOOK_PATH)) return [];
  const cutoff = Date.now() - windowMs;
  const pts: BookPoint[] = [];
  for (const line of readFileSync(BOOK_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as BookPoint;
      if (p.ts >= cutoff && Number.isFinite(p.book)) pts.push(p);
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
    const p = await computeBookNow();
    if (p) appendLedger("book-snapshots.jsonl", p);
  };
  const timer = setInterval(() => void snap(), 2 * 60 * 1000);
  timer.unref?.();
  void snap();
  return timer;
}
