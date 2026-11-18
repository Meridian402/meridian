// THE POOL WATCH. Read-only. No capital moves anywhere in this file.
//
// A short list of pools the operator wants eyes on, sampled every hour and
// written to a ledger, so a venue is judged on days of tape and not on one
// snapshot. It exists because of how the last venues were picked: a one-day
// scan says "this pool paid LPs $2,000 today", and one day is a pump, a bounce
// or a burst as often as it is a business.
//
// Each run re-reads the last LOOKBACK_H hours of Swap logs for the watched pool
// ids only (a filtered sweep, a few dozen calls), folds them into COMPLETE
// hours, and appends the hours it has not written yet. An hour is complete
// thirty minutes after it ends, because the markout of its last swaps needs
// that long to be known. Re-reading the window instead of keeping a cursor
// makes a run idempotent and lets a missed hour (the Mac asleep) backfill
// itself for up to a day.
//
// Same yardstick the desk already trusts (flowScan.scoreFlow): fees are flow
// times the pool's LP fee, markout is the price drift over the next thirty
// minutes against the side LPs just took, LP net is the difference. What that
// number does NOT contain is the inventory a seat is left holding when a token
// trends for a day; the ledger keeps open/high/low/close per hour so that can
// be read next to it.
//
// Self-contained on purpose, like the flow scanner: its own ledger and state,
// no export any deployment path consumes. This is sight. Whether a dollar
// follows it is a separate decision.
import { parseAbiItem, type Address, type Hex } from "viem";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getScanClient } from "../venues/signer.js";
import { dataPath } from "../dataDir.js";
import { seatLiquidity } from "../launch/watchCore.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";

const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;
const HOUR = 3600;
export const MARKOUT_HORIZON_S = 30 * 60;
const LEDGER = "pool-watch.jsonl";
const STATE = "pool-watch-state.json";
const LOOKBACK_H = Number(process.env.POOL_WATCH_LOOKBACK_H ?? 26);
const SEAT_USD = Number(process.env.POOL_WATCH_SEAT_USD ?? 1000);
const SEAT_WIDTH = Number(process.env.POOL_WATCH_SEAT_WIDTH ?? 1.25); // price / 1.25 .. price * 1.25

const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export interface WatchedPool {
  id: Hex;
  symbol: string;
  token: Address;
  quote: "USDG" | "ETH";
  /** The pool key's own fee in pips. The Swap event's fee also carries the
   *  protocol's cut, which LPs never see, so it is not used for income. */
  lpFee: number;
  /** False for hooked launch curves: watched for context, closed to an outside LP. */
  enterable: boolean;
  note: string;
}

/** Added 2026-11-16 on the operator's word ("keep close eyes on the orbio /
 *  hookr / priors / hbtc pools") after a one-day scan ranked them among the
 *  better-paying meme pools an outside LP can enter. To watch another pool, add
 *  it here: the id is the PoolManager pool id, the fee is the pool key's fee. */
export const WATCHED: WatchedPool[] = [
  { id: "0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef", symbol: "ORBIO", token: "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", quote: "USDG", lpFee: 8000, enterable: true, note: "Orbio.so side pool" },
  { id: "0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92", symbol: "ORBIO", token: "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", quote: "USDG", lpFee: 9000, enterable: false, note: "Orbio.so hooked launch market, context only" },
  { id: "0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf", symbol: "HOOKR", token: "0x18e674231a58c239dc7daedcffe15ec3a24cff5c", quote: "ETH", lpFee: 2500, enterable: true, note: "Hookr.fun main pool" },
  { id: "0x0b362d89fcae933d150e735d28c70e13469a4e14d3b3a36ac05eb5a1a77f2474", symbol: "HOOKR", token: "0x18e674231a58c239dc7daedcffe15ec3a24cff5c", quote: "USDG", lpFee: 10000, enterable: true, note: "Hookr.fun USDG pool" },
  { id: "0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8", symbol: "PRIORS", token: "0xedbf91223639800bcd5756815caf908df3b890be", quote: "USDG", lpFee: 10000, enterable: true, note: "Priors Agents, 2% creator tax on the token" },
  { id: "0xac9e954695a0297f761822e248a3f8c2fd3834e79f2351fd987b565e78457dba", symbol: "HBTC", token: "0x8db244f6bf052571f4e0c6065b700e714092d4b6", quote: "USDG", lpFee: 10000, enterable: true, note: "Hooked Bitcoin, unvetted token" },
  // Added 2026-11-18. The operator's criterion for going live is "high volume and a steady range",
  // and of the pools that have both on this chain these two are the ones the desk can actually
  // enter: plain Uniswap v4, no hook. SPY is the S&P 500 ETF token.
  { id: "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907", symbol: "SPY", token: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", quote: "USDG", lpFee: 500, enterable: true, note: "S&P 500 ETF token; $4.6M a day on $778k the day it was added; tick spacing 5, no hook" },
  { id: "0xe1ae6a4c6ccc9f037389a8d50a4f577bde1a9fe01d85d88ecbbd39955ce53288", symbol: "SPY", token: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", quote: "USDG", lpFee: 100, enterable: true, note: "S&P 500 ETF token; $2.4M a day on $241k; tick spacing 1, no hook" },
];

export const labelOf = (p: Pick<WatchedPool, "symbol" | "quote" | "lpFee" | "enterable">): string =>
  `${p.symbol}/${p.quote} ${p.lpFee / 10000}%${p.enterable ? "" : " (hooked)"}`;

export interface WatchSwap {
  t: number; // unix seconds
  usd: number; // the quote leg, in dollars
  px: number; // token price in dollars
  sqrtP: number; // sqrtPriceX96 / 2^96
  L: number; // active liquidity after the swap
  sender: string;
}

/** PURE: the 30-minute markout of each swap, aligned to the (time-sorted)
 *  input. Positive means the price kept moving against the LPs who took the
 *  other side. Identical in formula to flowScan.scoreFlow, kept per swap so it
 *  can be booked to the hour the swap happened in; the test pins the two
 *  together. */
export function markouts(sorted: readonly WatchSwap[]): number[] {
  const out = new Array<number>(sorted.length).fill(0);
  let j = 0;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    const dir = Math.sign(s.px - sorted[i - 1].px);
    if (dir === 0) continue;
    if (j < i) j = i;
    const target = s.t + MARKOUT_HORIZON_S;
    while (j + 1 < sorted.length && sorted[j + 1].t <= target) j++;
    if (j === i) continue; // nothing traded inside the horizon
    const ret = (sorted[j].px - s.px) / s.px;
    if (!Number.isFinite(ret) || Math.abs(ret) > 0.5) continue; // a 50%+ move is a different regime, not markout
    out[i] = dir * ret * s.usd;
  }
  return out;
}

export interface HourRow {
  hourStart: number;
  swaps: number;
  traders: number;
  volumeUsd: number;
  feesUsd: number;
  markoutUsd: number;
  lpNetUsd: number;
  pxOpen: number;
  pxClose: number;
  pxHigh: number;
  pxLow: number;
  sqrtPClose: number;
  liquidity: number;
}

export interface Carry {
  px: number;
  sqrtP: number;
  L: number;
}

/** PURE: fold a tape into the hours [fromHour, toHour). An hour with no swaps
 *  still gets a row, zero flow with the last known price and liquidity carried
 *  forward, so a pool going quiet reads as a quiet row and not as missing data.
 *  Hours before anything is known about the pool are skipped. */
export function hourRows(swaps: readonly WatchSwap[], feeRate: number, fromHour: number, toHour: number, carryIn: Carry | null = null): HourRow[] {
  const sorted = [...swaps].sort((a, b) => a.t - b.t);
  const mk = markouts(sorted);
  const rows: HourRow[] = [];
  let i = 0;
  let carry: Carry | null = carryIn;
  while (i < sorted.length && sorted[i].t < fromHour) {
    carry = { px: sorted[i].px, sqrtP: sorted[i].sqrtP, L: sorted[i].L };
    i++;
  }
  for (let h = fromHour; h < toHour; h += HOUR) {
    const start = i;
    while (i < sorted.length && sorted[i].t < h + HOUR) i++;
    if (i === start) {
      if (!carry) continue;
      rows.push({ hourStart: h, swaps: 0, traders: 0, volumeUsd: 0, feesUsd: 0, markoutUsd: 0, lpNetUsd: 0, pxOpen: carry.px, pxClose: carry.px, pxHigh: carry.px, pxLow: carry.px, sqrtPClose: carry.sqrtP, liquidity: carry.L });
      continue;
    }
    let vol = 0, markout = 0, hi = -Infinity, lo = Infinity;
    const traders = new Set<string>();
    for (let k = start; k < i; k++) {
      const s = sorted[k];
      vol += s.usd;
      markout += mk[k];
      if (s.px > hi) hi = s.px;
      if (s.px < lo) lo = s.px;
      traders.add(s.sender);
    }
    const open = carry ? carry.px : sorted[start].px;
    const last = sorted[i - 1];
    const fees = vol * feeRate;
    rows.push({ hourStart: h, swaps: i - start, traders: traders.size, volumeUsd: vol, feesUsd: fees, markoutUsd: markout, lpNetUsd: fees - markout, pxOpen: open, pxClose: last.px, pxHigh: Math.max(hi, open), pxLow: Math.min(lo, open), sqrtPClose: last.sqrtP, liquidity: last.L });
    carry = { px: last.px, sqrtP: last.sqrtP, L: last.L };
  }
  return rows;
}

/** PURE: what a balanced seat of `seatUsd` centred on the price would be next
 *  to the pool's active liquidity, and the quote resting within 2% below the
 *  price. `quotePerUsd` is 1 for a USDG pool and 1e12 / ethUsd for an ETH pool
 *  (seatLiquidity assumes a 6-decimal money leg). */
export function seatView(seatUsd: number, width: number, sqrtP: number, liquidity: number, quoteIs0: boolean, quotePerUsd: number): { sharePct: number; depth2pctUsd: number } {
  if (!(sqrtP > 0) || !(quotePerUsd > 0) || !(liquidity >= 0)) return { sharePct: 0, depth2pctUsd: 0 };
  const seat = seatLiquidity(seatUsd * quotePerUsd, sqrtP, width, quoteIs0);
  const perDollar = seatLiquidity(quotePerUsd, sqrtP, 1.0204, quoteIs0);
  return { sharePct: (seat / (liquidity + seat)) * 100, depth2pctUsd: perDollar > 0 ? (0.5 * liquidity) / perDollar : 0 };
}

export interface LedgerHour extends HourRow {
  ts: number;
  kind: "hour";
  id: string;
  symbol: string;
  quote: string;
  feePct: number;
  enterable: boolean;
  hour: string;
  depth2pctUsd: number;
  seatSharePct: number;
  seatNetUsd: number;
  /** Set by watchers on other chains (see bnbTrack.ts). */
  chain?: string;
  dex?: string;
}

export interface WindowSum {
  hours: number;
  swaps: number;
  volumeUsd: number;
  feesUsd: number;
  markoutUsd: number;
  lpNetUsd: number;
  seatNetUsd: number;
  movePct: number;
  rangePct: number;
}

/** PURE: totals over the last `hours` rows of one pool's chronological ledger. */
export function windowSum(rows: readonly LedgerHour[], hours: number): WindowSum {
  const w = rows.slice(-hours);
  const z: WindowSum = { hours: w.length, swaps: 0, volumeUsd: 0, feesUsd: 0, markoutUsd: 0, lpNetUsd: 0, seatNetUsd: 0, movePct: 0, rangePct: 0 };
  if (!w.length) return z;
  let hi = -Infinity, lo = Infinity;
  for (const r of w) {
    z.swaps += r.swaps;
    z.volumeUsd += r.volumeUsd;
    z.feesUsd += r.feesUsd;
    z.markoutUsd += r.markoutUsd;
    z.lpNetUsd += r.lpNetUsd;
    z.seatNetUsd += r.seatNetUsd;
    if (r.pxHigh > hi) hi = r.pxHigh;
    if (r.pxLow < lo) lo = r.pxLow;
  }
  z.movePct = w[0].pxOpen > 0 ? (w[w.length - 1].pxClose / w[0].pxOpen - 1) * 100 : 0;
  z.rangePct = lo > 0 ? (hi / lo - 1) * 100 : 0;
  return z;
}

/** PURE: the things worth a second look, read off one pool's ledger. */
export function watchFlags(rows: readonly LedgerHour[]): string[] {
  const flags: string[] = [];
  if (rows.length < 7) return flags;
  const last = rows[rows.length - 1];
  const sixAgo = rows[rows.length - 7];
  const dayAgo = rows[Math.max(0, rows.length - 25)];
  const move6 = sixAgo.pxClose > 0 ? (last.pxClose / sixAgo.pxClose - 1) * 100 : 0;
  if (move6 <= -20) flags.push(`price ${move6.toFixed(0)}% in 6h`);
  if (move6 >= 30) flags.push(`price +${move6.toFixed(0)}% in 6h`);
  if (dayAgo.liquidity > 0) {
    const dl = (last.liquidity / dayAgo.liquidity - 1) * 100;
    if (dl <= -50) flags.push(`liquidity ${dl.toFixed(0)}% in ${Math.min(24, rows.length - 1)}h (LPs leaving)`);
    if (dl >= 100) flags.push(`liquidity +${dl.toFixed(0)}% in ${Math.min(24, rows.length - 1)}h (crowding)`);
  }
  const recent = windowSum(rows, 6);
  if (rows.length >= 12) {
    const prior = windowSum(rows.slice(0, -6), 6);
    if (prior.volumeUsd >= 2000 && recent.volumeUsd < prior.volumeUsd * 0.3) flags.push(`volume fading: $${Math.round(recent.volumeUsd).toLocaleString()} in 6h vs $${Math.round(prior.volumeUsd).toLocaleString()} the 6h before`);
  }
  if (recent.swaps < 6) flags.push(`quiet: ${recent.swaps} swaps in 6h`);
  const day = windowSum(rows, 24);
  if (day.lpNetUsd < 0) flags.push(`LPs net negative over ${day.hours}h ($${Math.round(day.lpNetUsd).toLocaleString()})`);
  return flags;
}

// ---- runner ---------------------------------------------------------------------------------

interface WatchState {
  lastHour: Record<string, number>;
  carry: Record<string, Carry>;
  decimals: Record<string, number>;
  ethUsd?: number;
  lastRunAt?: number;
}

function loadState(): WatchState {
  try {
    const s = JSON.parse(readFileSync(dataPath(STATE), "utf8")) as Partial<WatchState>;
    return { lastHour: s.lastHour ?? {}, carry: s.carry ?? {}, decimals: s.decimals ?? {}, ethUsd: s.ethUsd, lastRunAt: s.lastRunAt };
  } catch {
    return { lastHour: {}, carry: {}, decimals: {} };
  }
}

/** One pool's hours per id, oldest first, from an hour ledger written by this
 *  watcher or by a sibling on another chain. */
export function readHourLedger(file: string): Map<string, LedgerHour[]> {
  const by = new Map<string, LedgerHour[]>();
  const p = dataPath(file);
  if (!existsSync(p)) return by;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LedgerHour;
      if (r.kind !== "hour") continue;
      let arr = by.get(r.id);
      if (!arr) by.set(r.id, (arr = []));
      arr.push(r);
    } catch {
      /* one bad line must not lose the ledger */
    }
  }
  for (const arr of by.values()) arr.sort((a, b) => a.hourStart - b.hourStart);
  return by;
}

export const readWatchLedger = (): Map<string, LedgerHour[]> => readHourLedger(LEDGER);

/** The one-line summary a run prints for a pool. */
export function summaryLine(label: string, rows: readonly LedgerHour[], seatUsd: number): string {
  if (!rows.length) return `${label}: no trades seen yet`;
  const d = windowSum(rows, 24);
  const tailRow = rows[rows.length - 1];
  const flags = watchFlags(rows);
  return (
    `${label}: ${d.hours}h vol $${Math.round(d.volumeUsd).toLocaleString()}, LP net $${Math.round(d.lpNetUsd).toLocaleString()}, price ${d.movePct >= 0 ? "+" : ""}${d.movePct.toFixed(1)}% (range ${d.rangePct.toFixed(0)}%), ` +
    `depth $${tailRow.depth2pctUsd.toLocaleString()}, $${seatUsd} seat ${tailRow.seatSharePct.toFixed(2)}% ~$${d.seatNetUsd.toFixed(2)}${flags.length ? ` | FLAG ${flags.join("; ")}` : ""}`
  );
}

const quoteIs0 = (p: WatchedPool): boolean => (p.quote === "ETH" ? true : BigInt(USDG) < BigInt(p.token));

export async function runOnce(log: (line: string) => void = (l) => console.log(l)): Promise<{ appended: number }> {
  const state = loadState();
  // the scan client's inferred type is far too deep for tsc inside getLogs; this file only needs these three calls
  const client = getScanClient() as unknown as {
    getBlockNumber(): Promise<bigint>;
    getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
    getLogs(a: unknown): Promise<Array<{ blockNumber: bigint; args: { id: Hex; sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint } }>>;
    readContract(a: unknown): Promise<unknown>;
  };
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const probe = await client.getBlock({ blockNumber: head - 200_000n });
  const bps = 200_000 / (headTs - Number(probe.timestamp));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;
  const fromBlock = head - BigInt(Math.round(LOOKBACK_H * HOUR * bps));

  let ethUsd = NaN;
  try {
    ethUsd = await fetchEthUsd();
  } catch {
    /* fall back to the last one that worked */
  }
  if (!(ethUsd > 0)) ethUsd = state.ethUsd ?? NaN;
  if (ethUsd > 0) state.ethUsd = ethUsd;

  for (const p of WATCHED) {
    if (state.decimals[p.token] != null) continue;
    try {
      const d = await client.readContract({ address: p.token, abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" });
      state.decimals[p.token] = Number(d);
    } catch {
      state.decimals[p.token] = 18;
    }
  }

  const ids = WATCHED.map((p) => p.id);
  const raw = new Map<string, Array<{ t: number; a0: bigint; a1: bigint; sp: bigint; L: bigint; sender: string }>>();
  let from = fromBlock;
  let step = 20_000n;
  let errors = 0;
  while (from <= head) {
    const to = from + step - 1n > head ? head : from + step - 1n;
    try {
      const logs = await client.getLogs({ address: POOL_MANAGER, event: swapEvent, args: { id: ids }, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const id = l.args.id.toLowerCase();
        let arr = raw.get(id);
        if (!arr) raw.set(id, (arr = []));
        arr.push({ t: blockTs(l.blockNumber), a0: l.args.amount0, a1: l.args.amount1, sp: l.args.sqrtPriceX96, L: l.args.liquidity, sender: l.args.sender.toLowerCase() });
      }
      from = to + 1n;
      if (step < 20_000n) step *= 2n;
    } catch (err) {
      errors++;
      if (step > 500n) step /= 2n;
      if (errors > 40) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  const nowSec = Date.now() / 1000;
  const toHour = Math.floor((nowSec - MARKOUT_HORIZON_S) / HOUR) * HOUR; // hours whose markout is already knowable
  const windowStart = Math.ceil(blockTs(fromBlock) / HOUR) * HOUR;
  let appended = 0;
  for (const p of WATCHED) {
    const id = p.id.toLowerCase();
    if (p.quote === "ETH" && !(ethUsd > 0)) {
      log(`[poolWatch] ${labelOf(p)}: no ETH price this run, skipped`);
      continue;
    }
    const q0 = quoteIs0(p);
    const qDec = p.quote === "USDG" ? 6 : 18;
    const qUsd = p.quote === "USDG" ? 1 : ethUsd;
    const tDec = state.decimals[p.token] ?? 18;
    const swaps: WatchSwap[] = [];
    for (const x of raw.get(id) ?? []) {
      const usd = (Math.abs(Number(q0 ? x.a0 : x.a1)) / 10 ** qDec) * qUsd;
      const sqrtP = Number(x.sp) / Q96;
      const ratio = sqrtP ** 2; // currency1 per currency0, raw
      const px = (q0 ? 1 / ratio : ratio) * 10 ** (tDec - qDec) * qUsd;
      if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(usd)) continue;
      swaps.push({ t: x.t, usd, px, sqrtP, L: Number(x.L), sender: x.sender });
    }
    const last = state.lastHour[id];
    const fromHour = last != null ? Math.max(last + HOUR, windowStart) : windowStart;
    if (last != null && fromHour > last + HOUR) log(`[poolWatch] ${labelOf(p)}: gap, ${Math.round((fromHour - last - HOUR) / HOUR)}h were outside the ${LOOKBACK_H}h window and are not recorded`);
    const rows = hourRows(swaps, p.lpFee / 1e6, fromHour, toHour, last != null ? (state.carry[id] ?? null) : null);
    const quotePerUsd = p.quote === "USDG" ? 1 : 1e12 / ethUsd;
    for (const r of rows) {
      const v = seatView(SEAT_USD, SEAT_WIDTH, r.sqrtPClose, r.liquidity, q0, quotePerUsd);
      const row: LedgerHour = { ts: (r.hourStart + HOUR) * 1000, kind: "hour", id, symbol: p.symbol, quote: p.quote, feePct: p.lpFee / 10000, enterable: p.enterable, hour: new Date(r.hourStart * 1000).toISOString().slice(0, 13) + ":00Z", ...r, depth2pctUsd: Math.round(v.depth2pctUsd), seatSharePct: Math.round(v.sharePct * 1e5) / 1e5, seatNetUsd: Math.round((v.sharePct / 100) * r.lpNetUsd * 100) / 100 };
      appendFileSync(dataPath(LEDGER), JSON.stringify(row) + "\n");
      appended++;
    }
    if (rows.length) {
      const tail = rows[rows.length - 1];
      state.lastHour[id] = tail.hourStart;
      state.carry[id] = { px: tail.pxClose, sqrtP: tail.sqrtPClose, L: tail.liquidity };
    }
  }
  state.lastRunAt = Date.now();
  writeFileSync(dataPath(STATE), JSON.stringify(state, null, 1));

  const ledger = readWatchLedger();
  for (const p of WATCHED) log(`[poolWatch] ${summaryLine(labelOf(p), ledger.get(p.id.toLowerCase()) ?? [], SEAT_USD)}`);
  return { appended };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** The report block for one pool: its recorded span, then the windows. */
export function reportPool(label: string, note: string, rows: readonly LedgerHour[], log: (line: string) => void): void {
  log("");
  log(`${label}  (${note})`);
  if (!rows.length) {
    log("  nothing recorded yet");
    return;
  }
  const tail = rows[rows.length - 1];
  log(`  recorded ${rows.length}h, ${rows[0].hour} to ${tail.hour}; price $${tail.pxClose.toPrecision(4)}, depth within 2% ${money(tail.depth2pctUsd)}, seat share ${tail.seatSharePct.toFixed(2)}%`);
  log("  window   swaps      volume    LP fees    markout     LP net   seat est    price   range");
  let shown = 0;
  for (const [window, h] of [["1h", 1], ["6h", 6], ["24h", 24], ["72h", 72], ["7d", 168]] as const) {
    if (shown >= rows.length) continue; // a longer window with no more data behind it says nothing new
    shown = h;
    const w = windowSum(rows, h);
    log(
      `  ${window.padEnd(6)} ${String(w.swaps).padStart(6)} ${money(w.volumeUsd).padStart(11)} ${money(w.feesUsd).padStart(10)} ${money(w.markoutUsd).padStart(10)} ${money(w.lpNetUsd).padStart(10)} ${("$" + w.seatNetUsd.toFixed(2)).padStart(10)} ${((w.movePct >= 0 ? "+" : "") + w.movePct.toFixed(1) + "%").padStart(8)} ${(w.rangePct.toFixed(0) + "%").padStart(7)}${w.hours < h ? `   (${w.hours}h of data)` : ""}`,
    );
  }
  const flags = watchFlags(rows);
  log(flags.length ? `  FLAGS: ${flags.join("; ")}` : "  no flags");
}

export const reportHeader = (seatUsd: number, width: number): string =>
  `a $${seatUsd} seat at price / ${width} .. price x ${width}; LP net = fees minus 30-minute markout, for ALL of a pool's LPs`;

export function report(log: (line: string) => void = (l) => console.log(l)): void {
  const ledger = readWatchLedger();
  log(`pool watch report: ${reportHeader(SEAT_USD, SEAT_WIDTH)}`);
  for (const p of WATCHED) reportPool(labelOf(p), p.note, ledger.get(p.id.toLowerCase()) ?? [], log);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes("--report")) {
    report();
  } else {
    runOnce()
      .then((r) => {
        console.log(`[poolWatch] ${new Date().toISOString().slice(0, 16)}Z: appended ${r.appended} hour rows`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`[poolWatch] run failed: ${String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200)}`);
        process.exit(1);
      });
  }
}
