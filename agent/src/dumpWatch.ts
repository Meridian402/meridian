// Dump early-warning, server-side. Runs 24/7 in the desk (unlike the
// session-scoped Claude watcher). For every seat pool we hold, it reads the
// pool's recent on-chain swap flow and flags the earliest leading signal of a
// dump: ONE-SIDED selling that is DOMINANT and ACCELERATING while price rolls
// over — minutes before price breaks the band and the reactive break-exit
// fires. ALERT ONLY by design: heavy selling is often absorbed (a false
// positive), and auto-exiting on it would sell the bottom and re-buy higher —
// the churn/ratchet loss the desk already learned. It logs + records + exposes
// state; a human/operator decides. Wiring an auto-de-risk is a later step,
// only after the signal is validated against real dumps.
import { parseAbiItem, type Hex } from "viem";
import { getScanClient } from "./venues/signer.js";
import { usdgPoolIdFor, tokenIsCurrency0 } from "./venues/stockPools.js";
import { openPositionsOnChain } from "./venues/lpPositions.js";
import { appendLedger } from "./ledger.js";

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const WATCH_MS = Number(process.env.MERIDIAN_DUMP_WATCH_MS ?? 120_000);
const LOOKBACK = BigInt(process.env.MERIDIAN_DUMP_LOOKBACK_BLOCKS ?? 1800); // ~last several minutes
const SELL_SHARE = Number(process.env.MERIDIAN_DUMP_SELL_SHARE ?? 0.66);
const ACCEL = Number(process.env.MERIDIAN_DUMP_ACCEL ?? 1.6);
const VEL_PCT = Number(process.env.MERIDIAN_DUMP_VEL_PCT ?? -3);
const MIN_SWAPS = Number(process.env.MERIDIAN_DUMP_MIN_SWAPS ?? 8);

export interface DumpReading {
  symbol: string;
  at: number;
  swaps: number;
  recentSellSharePct: number;
  accel: number;
  velPct: number;
  pressure: boolean;
  reason: string;
}

const latest = new Map<string, DumpReading>();
const alerted = new Map<string, boolean>();

export function dumpWatchState(): DumpReading[] {
  return [...latest.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** PURE: the dump-pressure decision from split-window flow + velocity.
 *  Pressure requires all three — dominant sell share, accelerating sell
 *  volume, and price rolling over — so absorbed selling (heavy but with
 *  buyers, price flat/up) does NOT trip it. Exported for tests. */
export function dumpVerdict(
  recentSell: number,
  recentBuy: number,
  olderSell: number,
  velPct: number,
): { pressure: boolean; reason: string; sharePct: number; accel: number } {
  const share = recentSell / Math.max(recentSell + recentBuy, 1);
  const accel = recentSell / Math.max(olderSell, 1);
  const flags: string[] = [];
  if (share >= SELL_SHARE) flags.push(`sell-share ${(share * 100).toFixed(0)}%`);
  if (accel >= ACCEL && recentSell > recentBuy) flags.push(`selling ${accel.toFixed(1)}x accelerating`);
  if (velPct <= VEL_PCT) flags.push(`price ${velPct.toFixed(1)}%`);
  const pressure = share >= SELL_SHARE && accel >= ACCEL && recentSell > recentBuy && velPct <= VEL_PCT;
  return { pressure, reason: flags.join(", ") || "calm", sharePct: Math.round(share * 100), accel: Math.round(accel * 100) / 100 };
}

async function scanSymbol(symbol: string): Promise<DumpReading | null> {
  const id = usdgPoolIdFor(symbol);
  if (!id) return null;
  const client = getScanClient();
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({
    address: POOL_MANAGER,
    event: swapEvent,
    args: { id: id as Hex },
    fromBlock: head - LOOKBACK,
    toBlock: head,
  });
  if (logs.length < MIN_SWAPS) {
    const r: DumpReading = { symbol, at: Date.now(), swaps: logs.length, recentSellSharePct: 0, accel: 0, velPct: 0, pressure: false, reason: "too thin to judge" };
    latest.set(symbol, r);
    return r;
  }
  const c0 = tokenIsCurrency0(symbol);
  const rows = logs.map((l) => {
    const a0 = l.args.amount0 as bigint;
    const a1 = l.args.amount1 as bigint;
    const sp = Number(l.args.sqrtPriceX96 as bigint);
    const sell = c0 ? a0 > 0n : a1 > 0n; // the meme token entering the pool = a sell of it
    const usdgRaw = c0 ? a1 : a0; // the USDG leg
    const usdg = Number(usdgRaw < 0n ? -usdgRaw : usdgRaw) / 1e6;
    const p = (sp / 2 ** 96) ** 2; // currency1 per currency0
    const memePx = c0 ? p : p > 0 ? 1 / p : 0; // meme priced in USDG
    return { sell, usdg, memePx };
  });
  const n = rows.length;
  const half = Math.floor(n / 2);
  const older = rows.slice(0, half);
  const recent = rows.slice(half);
  const sum = (rs: typeof rows, want: boolean) => rs.filter((r) => r.sell === want).reduce((s, r) => s + r.usdg, 0);
  const rSell = sum(recent, true);
  const rBuy = sum(recent, false);
  const oSell = sum(older, true);
  const velPct = recent[0].memePx > 0 ? (recent[recent.length - 1].memePx / recent[0].memePx - 1) * 100 : 0;
  const v = dumpVerdict(rSell, rBuy, oSell, velPct);
  const r: DumpReading = { symbol, at: Date.now(), swaps: n, recentSellSharePct: v.sharePct, accel: v.accel, velPct: Math.round(velPct * 10) / 10, pressure: v.pressure, reason: v.reason };
  latest.set(symbol, r);
  return r;
}

async function tick(): Promise<void> {
  try {
    const positions = await openPositionsOnChain();
    const symbols = [...new Set(positions.map((p) => p.symbol.toUpperCase()))].filter((s) => usdgPoolIdFor(s));
    for (const s of symbols) {
      try {
        const r = await scanSymbol(s);
        if (!r) continue;
        if (r.pressure && !alerted.get(s)) {
          alerted.set(s, true);
          console.error(`[dumpWatch] EARLY WARNING on ${s}: ${r.reason} over ${r.swaps} swaps — one-sided selling accelerating with price rolling over. ALERT ONLY; verify before de-risking.`);
          appendLedger("dump-watch.jsonl", { ts: r.at, ...r });
        } else if (!r.pressure && alerted.get(s)) {
          alerted.set(s, false);
          console.error(`[dumpWatch] ${s} pressure cleared (${r.reason})`);
        }
      } catch (e) {
        console.error(`[dumpWatch] ${s} scan failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
  } catch (e) {
    console.error(`[dumpWatch] tick failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }
}

export function startDumpWatch(): NodeJS.Timeout | undefined {
  if (process.env.MERIDIAN_DUMP_WATCH === "off") {
    console.log("[dumpWatch] off (MERIDIAN_DUMP_WATCH=off)");
    return;
  }
  console.log(
    `[dumpWatch] armed: leading sell-flow watch on held seat pools every ${Math.round(WATCH_MS / 1000)}s (alert-only; fires when sell-share>=${SELL_SHARE}, accel>=${ACCEL}x, and price<=${VEL_PCT}%)`,
  );
  const t = setInterval(() => void tick(), WATCH_MS);
  t.unref?.();
  void tick();
  return t;
}
