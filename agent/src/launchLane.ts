// THE LAUNCH LANE (2026-09-04, operator: "we need to breakout" / "can we find
// some microduck type positions in the 30-70k LP range").
//
// The only pools on this chain with MICRODUCK-type fee density (real flow
// through $15k-80k of active liquidity) are launch pools a few hours old, and
// the launch watcher on the operator's Mac already finds and scores them
// every hour. Its paper record, scored as $500 seats from the mark: all 49
// marks +$319 at a 37% hit rate; the subset whose token passes the standard
// gate (verified launch bytecode, creator tax <= 1%, allowed pair) +$1,683 at
// 64%, 14 samples. Hour-1 entries and sub-3% tiers lost.
//
// This module is the desk's side of that lane. The watcher PUSHES a venue
// here (POST /api/launch-venues) with the pool key and its own measured
// stats; the desk registers it as a dynamic USDG pool, the dump watch starts
// building a tape on it, and the pilot's auto-entry treats it as one more
// candidate with lane-specific limits: a smaller seat, one launch seat at a
// time, tier / hour / depth bars, and every ordinary rail from the first
// second. A pushed venue expires after a TTL unless a seat is open in it.
// Only hooks-free side pools are accepted: the desk mints with hooks=0 and
// verifies the pushed pool id against the key it would mint into.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { dataPath } from "./dataDir.js";
import { registerLaunchPool, unregisterLaunchPool, poolIdForUsdgEntry, isTradable, launchPoolSymbols } from "./venues/stockPools.js";

export const LAUNCH_LANE = (process.env.MERIDIAN_LAUNCH_LANE ?? "on") !== "off";
export const LAUNCH_SEAT_USD = Number(process.env.MERIDIAN_LAUNCH_SEAT_USD ?? 500);
export const LAUNCH_MAX_SEATS = Number(process.env.MERIDIAN_LAUNCH_MAX_SEATS ?? 1);
export const LAUNCH_MIN_TIER_PCT = Number(process.env.MERIDIAN_LAUNCH_MIN_TIER_PCT ?? 3);
export const LAUNCH_MIN_HOUR = Number(process.env.MERIDIAN_LAUNCH_MIN_HOUR ?? 2);
export const LAUNCH_MIN_FLOW_USD_H = Number(process.env.MERIDIAN_LAUNCH_MIN_FLOW_USD_H ?? 300_000);
export const LAUNCH_DEPTH_MIN_USD = Number(process.env.MERIDIAN_LAUNCH_DEPTH_MIN_USD ?? 15_000);
export const LAUNCH_DEPTH_MAX_USD = Number(process.env.MERIDIAN_LAUNCH_DEPTH_MAX_USD ?? 80_000);
export const LAUNCH_VENUE_TTL_MS = Number(process.env.MERIDIAN_LAUNCH_VENUE_TTL_H ?? 24) * 3_600_000;
/** pushed stats older than this are not trusted; the desk's own tape takes over */
export const LAUNCH_STATS_MAX_AGE_MS = Number(process.env.MERIDIAN_LAUNCH_STATS_MAX_AGE_MIN ?? 90) * 60_000;

export interface LaunchVenue {
  symbol: string;
  token: Address;
  fee: number; // v4 units (1e-6): 30000 = 3%
  tickSpacing: number;
  poolId: Hex;
  addedTs: number;
  updatedTs: number;
  /** the watcher's measurements at the push */
  stats: LaunchStats;
}
export interface LaunchStats {
  ts: number;
  hour: number;
  flowUsdH: number;
  movePct: number;
  hourlyMovePcts: number[];
  senders: number;
  /** pool active liquidity after the last swap, raw L units as a decimal string */
  poolL: string;
  /** sqrtPriceX96 / 2^96 at the last swap */
  sqrtP: number;
  gate: boolean;
  source: string | null;
}

const PATH = dataPath("launch-venues.json");
let venues: Record<string, LaunchVenue> | null = null;
function load(): Record<string, LaunchVenue> {
  if (venues) return venues;
  try {
    venues = existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as Record<string, LaunchVenue>) : {};
  } catch {
    venues = {};
  }
  for (const v of Object.values(venues)) registerLaunchPool({ symbol: v.symbol, token: v.token, fee: v.fee, tickSpacing: v.tickSpacing });
  return venues;
}
function save(): void {
  try {
    writeFileSync(PATH, JSON.stringify(venues ?? {}, null, 2));
  } catch (err) {
    console.error(`[launchLane] could not save ${PATH}: ${err instanceof Error ? err.message : err}`);
  }
}

/** PURE: a symbol the registry can carry: A-Z0-9, 2-12 chars, not a name it already has. */
export function launchSymbol(raw: string, token: string, taken: (s: string) => boolean): string {
  let s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (s.length < 2) s = "L" + token.slice(2, 7).toUpperCase();
  if (taken(s)) s = (s.slice(0, 8) + token.slice(-4)).toUpperCase();
  return s;
}

/** PURE: validate a push. The pool id must be the id the desk would mint into (hooks=0, USDG quote). */
export function validateLaunchPush(body: unknown, computeId: (token: Address, fee: number, tickSpacing: number) => Hex | null): { ok: true; venue: Omit<LaunchVenue, "addedTs" | "updatedTs" | "symbol"> & { symbolRaw: string } } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const token = String(b.token ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { ok: false, error: "token must be an address" };
  const fee = Number(b.fee), tickSpacing = Number(b.tickSpacing);
  if (!Number.isInteger(fee) || fee <= 0 || fee >= 0x800000) return { ok: false, error: "fee must be a static v4 fee in 1e-6 units" };
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) return { ok: false, error: "tickSpacing must be a positive integer" };
  const poolId = String(b.poolId ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(poolId)) return { ok: false, error: "poolId must be a bytes32" };
  const expected = computeId(token as Address, fee, tickSpacing);
  if (!expected || expected.toLowerCase() !== poolId) return { ok: false, error: "poolId is not the hooks-free USDG pool for that token/fee/tickSpacing; the desk cannot mint into it" };
  const s = (b.stats ?? {}) as Record<string, unknown>;
  const stats: LaunchStats = {
    ts: Number(s.ts ?? Date.now()),
    hour: Number(s.hour ?? 0),
    flowUsdH: Number(s.flowUsdH ?? 0),
    movePct: Number(s.movePct ?? 0),
    hourlyMovePcts: Array.isArray(s.hourlyMovePcts) ? (s.hourlyMovePcts as unknown[]).map(Number).filter(Number.isFinite) : [],
    senders: Number(s.senders ?? 0),
    poolL: String(s.poolL ?? "0"),
    sqrtP: Number(s.sqrtP ?? 0),
    gate: s.gate === true,
    source: s.source == null ? null : String(s.source),
  };
  if (!stats.gate) return { ok: false, error: "only gate-passing tokens are accepted" };
  if (!/^\d+$/.test(stats.poolL)) return { ok: false, error: "stats.poolL must be an integer string" };
  return { ok: true, venue: { token: token as Address, fee, tickSpacing, poolId: poolId as Hex, stats, symbolRaw: String(b.symbol ?? "") } };
}

/** Register or refresh a pushed venue. Returns the symbol the desk will use. */
export function upsertLaunchVenue(v: ReturnType<typeof validateLaunchPush> extends infer R ? (R extends { ok: true; venue: infer V } ? V : never) : never, now = Date.now()): string {
  const all = load();
  const existing = Object.values(all).find((x) => x.token.toLowerCase() === v.token.toLowerCase());
  const symbol = existing?.symbol ?? launchSymbol(v.symbolRaw, v.token, (s) => isTradable(s) && !launchPoolSymbols().includes(s));
  const row: LaunchVenue = { symbol, token: v.token, fee: v.fee, tickSpacing: v.tickSpacing, poolId: v.poolId, addedTs: existing?.addedTs ?? now, updatedTs: now, stats: v.stats };
  all[symbol] = row;
  registerLaunchPool({ symbol, token: v.token, fee: v.fee, tickSpacing: v.tickSpacing });
  save();
  return symbol;
}

export function activeLaunchVenues(now = Date.now()): LaunchVenue[] {
  return Object.values(load()).filter((v) => now - v.updatedTs < LAUNCH_VENUE_TTL_MS);
}
export function launchVenueSymbols(now = Date.now()): string[] {
  return activeLaunchVenues(now).map((v) => v.symbol);
}
export function launchVenue(symbol: string): LaunchVenue | undefined {
  return load()[symbol.toUpperCase()];
}

/** PURE: which venues may be dropped: expired and no open seat. */
export function expiredLaunchVenues(all: readonly LaunchVenue[], openSymbols: ReadonlySet<string>, now: number, ttlMs = LAUNCH_VENUE_TTL_MS): string[] {
  return all.filter((v) => now - v.updatedTs >= ttlMs && !openSymbols.has(v.symbol)).map((v) => v.symbol);
}
/** Drop expired venues (registry entry too). Called by the pilot each tick. */
export function expireLaunchVenues(openSymbols: ReadonlySet<string>, now = Date.now()): string[] {
  const all = load();
  const gone = expiredLaunchVenues(Object.values(all), openSymbols, now);
  for (const s of gone) {
    delete all[s];
    unregisterLaunchPool(s);
  }
  if (gone.length) save();
  return gone;
}

/** PURE: the pushed stats as the pilot's candidate inputs, when fresh enough. */
export function pushedStatsFor(v: LaunchVenue, now: number, maxAgeMs = LAUNCH_STATS_MAX_AGE_MS): { flowUsdPerHour: number; tick: number; activeL: bigint; medianAbsHourlyPct: number; last60mPct: number } | null {
  if (now - v.stats.ts > maxAgeMs) return null;
  if (!(v.stats.sqrtP > 0)) return null;
  const tick = Math.round((2 * Math.log(v.stats.sqrtP)) / Math.log(1.0001));
  const abs = v.stats.hourlyMovePcts.map((m) => Math.abs(m)).sort((a, b) => a - b);
  const median = abs.length === 0 ? Math.abs(v.stats.movePct) : abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
  let activeL = 0n;
  try {
    activeL = BigInt(v.stats.poolL);
  } catch {
    return null;
  }
  return { flowUsdPerHour: v.stats.flowUsdH, tick, activeL, medianAbsHourlyPct: median, last60mPct: v.stats.movePct };
}

export { poolIdForUsdgEntry };
