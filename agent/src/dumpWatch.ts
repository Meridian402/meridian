// Dump early-warning, server-side. Runs 24/7 in the desk (unlike the
// session-scoped Claude watcher). For every seat pool we hold, it reads the
// pool's recent on-chain swap flow and flags the earliest leading signal of a
// dump: ONE-SIDED selling that is DOMINANT and ACCELERATING while price rolls
// over, minutes before price breaks the band and the reactive break-exit
// fires.
//
// ARMED 2026-08-28 (operator decision, after the midday CASHCAT dump cost
// ~$200 riding a 15.6% leg under the alert-only contract): the SHARP signal
// now acts. When pressure prints on a held pool, the pilot guard flattens
// that venue's seats to cash on its next tick and new entries into the venue
// are refused for a lockout window. The signal spent 08-26 -> 08-28 validated
// against live tape (one real dump caught, absorbed selling correctly
// ignored), which was the stated bar for this step. The three-condition
// verdict is unchanged; false positives cost one ~$5 round-trip, a true
// positive un-acted-on measured ~$200. MERIDIAN_DUMP_AUTO_EXIT=off restores
// alert-only. The SLOW-BLEED layer below stays alert-only: a grind is a
// judgment call, a one-sided accelerating dump is not.
// SLOW-BLEED LAYER (added 2026-08-26 after the CASHCAT grind): the sharp-dump
// verdict above watches MINUTES and correctly stayed silent through a two-day
// stairstep decline — every 2-minute window looked calm while the price walked
// down 20%. The bleed detector watches HOURS: a rolling price series per held
// symbol, firing on a persistent grind (real drawdown from the window's peak,
// mostly-negative steps, sellers persistently present). Same contract as the
// sharp signal: ALERT ONLY, a human decides.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseAbiItem, type Hex } from "viem";
import { getScanClient } from "./venues/signer.js";
import { usdgPoolIdFor, tokenIsCurrency0 } from "./venues/stockPools.js";
import { openPositionsOnChain, ENGINE_SYMBOLS } from "./venues/lpPositions.js";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";

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

// ---------------------------------------------------------------------------
// The armed step: exit verdict + re-entry lockout.
// ---------------------------------------------------------------------------
const AUTO_EXIT = (process.env.MERIDIAN_DUMP_AUTO_EXIT ?? "on") !== "off";
const EXIT_LOCKOUT_MS = Number(process.env.MERIDIAN_DUMP_EXIT_LOCKOUT_MIN ?? 90) * 60_000;
// A reading older than two scan intervals is a stopped watch, not a signal.
// Acting on stale pressure would sell into whatever happened AFTER the scan
// died, which is exactly the blind trade this whole file exists to prevent.
const READING_FRESH_MS = 2 * WATCH_MS + 60_000;

export function dumpAutoExitArmed(): boolean {
  return AUTO_EXIT;
}

/** The most recent sharp reading for one symbol, if the watch has produced one. */
export function latestDumpReading(symbol: string): DumpReading | undefined {
  return latest.get(symbol.toUpperCase());
}

/** PURE: should an armed guard flatten this venue's seats now? Exported for
 *  tests. Requires the signal to be armed, present, fresh, and printing
 *  pressure; anything less keeps the alert-only behavior. */
export function dumpExitVerdict(
  reading: DumpReading | undefined,
  nowMs: number,
  armed = AUTO_EXIT,
  freshMs = READING_FRESH_MS,
): { act: boolean; reason: string } {
  if (!armed) return { act: false, reason: "auto-exit disarmed (MERIDIAN_DUMP_AUTO_EXIT=off)" };
  if (!reading) return { act: false, reason: "no dump reading for this symbol yet" };
  if (!reading.pressure) return { act: false, reason: reading.reason };
  const age = nowMs - reading.at;
  if (age > freshMs) return { act: false, reason: `pressure reading is stale (${Math.round(age / 1000)}s old); not acting on a dead watch` };
  return { act: true, reason: `dump pressure live: ${reading.reason} over ${reading.swaps} swaps` };
}

// Lockout survives restarts on disk: a dump-exit followed by a crash-loop
// redeploy must not wake up amnesiac and buy straight back into the dump.
const LOCKOUT_PATH = dataPath("dump-lockout.json");
let lockouts: Record<string, number> | null = null;

function loadLockouts(): Record<string, number> {
  if (lockouts) return lockouts;
  try {
    lockouts = existsSync(LOCKOUT_PATH) ? (JSON.parse(readFileSync(LOCKOUT_PATH, "utf8")) as Record<string, number>) : {};
  } catch {
    lockouts = {};
  }
  return lockouts;
}

/** Called by the guard right after a dump-exit lands: no new entries into
 *  this venue until the lockout rolls off. A zero lockout disables. */
export function recordDumpExit(symbol: string, nowMs = Date.now()): void {
  if (EXIT_LOCKOUT_MS <= 0) return;
  const l = loadLockouts();
  l[symbol.toUpperCase()] = nowMs + EXIT_LOCKOUT_MS;
  try {
    writeFileSync(LOCKOUT_PATH, JSON.stringify(l, null, 2));
  } catch (err) {
    console.error(`[dumpWatch] lockout save failed (in-memory only until restart): ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  appendLedger("dump-watch.jsonl", { ts: nowMs, kind: "dump-exit-lockout", symbol: symbol.toUpperCase(), untilTs: nowMs + EXIT_LOCKOUT_MS });
}

/** PURE: why a mint into this venue is refused right now, or null when it is
 *  allowed. Two independent vetoes: an active post-exit lockout, and LIVE
 *  pressure on the tape this minute (no lockout needed to refuse buying into
 *  a dump that is still printing). Exported for tests. */
export function mintRefusal(
  lockUntilMs: number | undefined,
  reading: DumpReading | undefined,
  nowMs: number,
  freshMs = READING_FRESH_MS,
): string | null {
  if (lockUntilMs && nowMs < lockUntilMs) {
    return `dump-exit lockout: this venue was flattened on live dump pressure; no re-entry for another ${Math.ceil((lockUntilMs - nowMs) / 60_000)}m (MERIDIAN_DUMP_EXIT_LOCKOUT_MIN=0 disables)`;
  }
  if (reading?.pressure && nowMs - reading.at <= freshMs) {
    return `dump pressure is live on this pool right now (${reading.reason}); not opening into a printing dump`;
  }
  return null;
}

/** The live gate openInPool consults before any entry. */
export function dumpMintRefusal(symbol: string, nowMs = Date.now()): string | null {
  return mintRefusal(loadLockouts()[symbol.toUpperCase()], latest.get(symbol.toUpperCase()), nowMs);
}

/** When this venue's post-dump-exit lockout ends, if one is active. The dump
 *  bid runs INSIDE this window on purpose: the lockout forbids re-entering at
 *  spot, not standing below the fall with a resting bid. */
export function dumpLockoutUntil(symbol: string, nowMs = Date.now()): number | undefined {
  const until = loadLockouts()[symbol.toUpperCase()];
  return until && nowMs < until ? until : undefined;
}

// ---------------------------------------------------------------------------
// Slow bleed: hours-scale grind detection.
// ---------------------------------------------------------------------------
const BLEED_PCT = Number(process.env.MERIDIAN_BLEED_PCT ?? 6); // drawdown from window peak that qualifies
const BLEED_MIN_HOURS = Number(process.env.MERIDIAN_BLEED_MIN_HOURS ?? 3);
const BLEED_WINDOW_HOURS = Number(process.env.MERIDIAN_BLEED_WINDOW_HOURS ?? 8);
const BLEED_NEG_SHARE = Number(process.env.MERIDIAN_BLEED_NEG_SHARE ?? 0.55); // share of down-steps = "grind, not spike"
const BLEED_SELL_PCT = Number(process.env.MERIDIAN_BLEED_SELL_PCT ?? 50); // sellers persistently present
const BLEED_MIN_SAMPLES = Number(process.env.MERIDIAN_BLEED_MIN_SAMPLES ?? 20);
const BLEED_SAMPLES_PATH = dataPath("bleed-samples.json");

export interface BleedSample {
  ts: number;
  px: number;
  sellSharePct: number;
}

export interface BleedReading {
  symbol: string;
  at: number;
  bleeding: boolean;
  drawdownPct: number;
  hours: number;
  negSharePct: number;
  avgSellPct: number;
  reason: string;
}

// Samples survive restarts on disk; without that, every deploy would blind the
// detector for BLEED_MIN_HOURS — and deploys are exactly when attention lapses.
const bleedSeries = new Map<string, BleedSample[]>();
const bleedLatest = new Map<string, BleedReading>();
const bleedAlerted = new Map<string, boolean>();
let bleedLoaded = false;

function loadBleedSeries(): void {
  if (bleedLoaded) return;
  bleedLoaded = true;
  try {
    if (existsSync(BLEED_SAMPLES_PATH)) {
      const raw = JSON.parse(readFileSync(BLEED_SAMPLES_PATH, "utf8")) as Record<string, BleedSample[]>;
      for (const [sym, arr] of Object.entries(raw)) if (Array.isArray(arr)) bleedSeries.set(sym, arr);
    }
  } catch {
    /* fresh series re-seed */
  }
}
function saveBleedSeries(): void {
  try {
    writeFileSync(BLEED_SAMPLES_PATH, JSON.stringify(Object.fromEntries(bleedSeries)));
  } catch {
    /* a failed save only costs restart continuity */
  }
}

export function bleedWatchState(): BleedReading[] {
  return [...bleedLatest.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * PURE: the slow-bleed decision over an hours-scale sample window. Bleeding
 * requires all three — a real drawdown from the window's PEAK, a majority of
 * negative steps (a grind, not one spike that recovered), and sellers
 * persistently present on average. A short or thin window never fires.
 * Exported for tests.
 */
export function bleedVerdict(
  samples: readonly BleedSample[],
  nowMs: number,
  opts?: { bleedPct?: number; minHours?: number; windowHours?: number; negShare?: number; sellPct?: number; minSamples?: number },
): { bleeding: boolean; reason: string; drawdownPct: number; hours: number; negSharePct: number; avgSellPct: number } {
  const bleedPct = opts?.bleedPct ?? BLEED_PCT;
  const minHours = opts?.minHours ?? BLEED_MIN_HOURS;
  const windowMs = (opts?.windowHours ?? BLEED_WINDOW_HOURS) * 3_600_000;
  const negShareBar = opts?.negShare ?? BLEED_NEG_SHARE;
  const sellBar = opts?.sellPct ?? BLEED_SELL_PCT;
  const minSamples = opts?.minSamples ?? BLEED_MIN_SAMPLES;

  const win = samples.filter((s) => s.ts >= nowMs - windowMs && s.px > 0);
  const flat = { bleeding: false, drawdownPct: 0, hours: 0, negSharePct: 0, avgSellPct: 0 };
  if (win.length < minSamples) return { ...flat, reason: "window too thin to judge" };
  const hours = (win[win.length - 1].ts - win[0].ts) / 3_600_000;
  if (hours < minHours) return { ...flat, hours: Math.round(hours * 10) / 10, reason: "window too short to judge" };

  const peak = Math.max(...win.map((s) => s.px));
  const last = win[win.length - 1].px;
  const drawdownPct = (last / peak - 1) * 100;
  let neg = 0;
  for (let i = 1; i < win.length; i++) if (win[i].px < win[i - 1].px) neg++;
  const negShare = neg / (win.length - 1);
  const avgSell = win.reduce((s, x) => s + x.sellSharePct, 0) / win.length;

  const flags: string[] = [];
  if (drawdownPct <= -bleedPct) flags.push(`down ${drawdownPct.toFixed(1)}% from the ${hours.toFixed(1)}h peak`);
  if (negShare >= negShareBar) flags.push(`${(negShare * 100).toFixed(0)}% of steps negative`);
  if (avgSell >= sellBar) flags.push(`avg sell-share ${avgSell.toFixed(0)}%`);
  const bleeding = drawdownPct <= -bleedPct && negShare >= negShareBar && avgSell >= sellBar;
  return {
    bleeding,
    reason: bleeding ? `slow bleed: ${flags.join(", ")}` : flags.length ? `watching: ${flags.join(", ")}` : "steady",
    drawdownPct: Math.round(drawdownPct * 10) / 10,
    hours: Math.round(hours * 10) / 10,
    negSharePct: Math.round(negShare * 100),
    avgSellPct: Math.round(avgSell),
  };
}

function recordBleedSample(symbol: string, px: number, sellSharePct: number): void {
  loadBleedSeries();
  const now = Date.now();
  const arr = bleedSeries.get(symbol) ?? [];
  arr.push({ ts: now, px, sellSharePct });
  // Trim beyond the window so the file and memory stay bounded.
  const cutoff = now - BLEED_WINDOW_HOURS * 3_600_000;
  bleedSeries.set(symbol, arr.filter((s) => s.ts >= cutoff));

  const v = bleedVerdict(bleedSeries.get(symbol)!, now);
  bleedLatest.set(symbol, { symbol, at: now, bleeding: v.bleeding, drawdownPct: v.drawdownPct, hours: v.hours, negSharePct: v.negSharePct, avgSellPct: v.avgSellPct, reason: v.reason });
  if (v.bleeding && !bleedAlerted.get(symbol)) {
    bleedAlerted.set(symbol, true);
    console.error(`[dumpWatch] SLOW BLEED on ${symbol}: ${v.reason}. The sharp-dump signal misses grinds by design; this one is for them. ALERT ONLY; a human decides.`);
    appendLedger("dump-watch.jsonl", { ts: now, kind: "slow-bleed", symbol, drawdownPct: v.drawdownPct, hours: v.hours, negSharePct: v.negSharePct, avgSellPct: v.avgSellPct });
  } else if (!v.bleeding && bleedAlerted.get(symbol) && v.drawdownPct > -BLEED_PCT / 2) {
    // Clear only on real recovery (half the threshold), not on boundary noise.
    bleedAlerted.set(symbol, false);
    console.error(`[dumpWatch] ${symbol} slow bleed cleared (${v.reason})`);
  }
  saveBleedSeries();
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
  // Feed the hours-scale bleed series with this tick's closing price + flow.
  recordBleedSample(symbol, rows[rows.length - 1].memePx, v.sharePct);
  return r;
}

async function tick(): Promise<void> {
  try {
    const positions = await openPositionsOnChain();
    // Coverage follows the WATCHLIST, not the wallet: exiting a pool must not
    // blind the detector for it, because flat-and-deciding-to-re-enter is
    // exactly when the bleed reading matters most (measured 2026-08-26: the
    // guard exited all CASHCAT seats overnight and the bleed series went
    // dark while our re-entry trigger depended on it).
    const symbols = [...new Set([
      ...positions.map((p) => p.symbol.toUpperCase()),
      ...ENGINE_SYMBOLS,
    ])].filter((s) => usdgPoolIdFor(s));
    for (const s of symbols) {
      try {
        const r = await scanSymbol(s);
        if (!r) continue;
        if (r.pressure && !alerted.get(s)) {
          alerted.set(s, true);
          const posture = AUTO_EXIT
            ? "AUTO-EXIT ARMED: the pilot guard flattens this venue's seats on its next tick."
            : "ALERT ONLY (auto-exit disarmed); verify before de-risking.";
          console.error(`[dumpWatch] EARLY WARNING on ${s}: ${r.reason} over ${r.swaps} swaps, one-sided selling accelerating with price rolling over. ${posture}`);
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
    `[dumpWatch] sharp layer: sell-flow watch on held seat pools every ${Math.round(WATCH_MS / 1000)}s, fires when sell-share>=${SELL_SHARE}, accel>=${ACCEL}x, and price<=${VEL_PCT}%. ${AUTO_EXIT ? `AUTO-EXIT ARMED (pilot guard flattens the venue; ${Math.round(EXIT_LOCKOUT_MS / 60000)}m re-entry lockout)` : "alert-only (MERIDIAN_DUMP_AUTO_EXIT=off)"}`,
  );
  console.log(
    `[dumpWatch] slow-bleed layer armed: fires on a ${BLEED_PCT}%+ drawdown from the ${BLEED_WINDOW_HOURS}h peak with >=${Math.round(BLEED_NEG_SHARE * 100)}% negative steps and avg sell-share >=${BLEED_SELL_PCT}% over >=${BLEED_MIN_HOURS}h (alert-only; catches the grinds the sharp signal skips)`,
  );
  const t = setInterval(() => void tick(), WATCH_MS);
  t.unref?.();
  void tick();
  return t;
}
