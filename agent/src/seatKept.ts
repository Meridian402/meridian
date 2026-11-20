// THE SEAT-KEPT RULES, LIVE (2026-11-20, operator: "build the wiring").
//
// The paper rule set "ranked on what a seat kept" judges a pool on what the desk's own seat
// would have KEPT there: its fees, plus what the price did to it, minus costs, for a seat opened
// at each of the last 24 hours and held a day. This module gives the live pilot guard the same
// number, from the same hourly record and the same function (signals/seatMath.ts), for two uses:
//
//   - ENTRY (MERIDIAN_PILOT_RANK_ON_KEPT=on): a venue is taken only if that two-day average and
//     the latest full day both kept money, and venues are ranked on the average.
//   - EXIT (MERIDIAN_PILOT_LEAVE_ON_LOSS_PCT=1): a venue's seats are closed once a fresh seat
//     there would have lost more than that percent of itself over the last day.
//
// Both ship OFF. Unset, nothing here is read and the guard behaves exactly as before.
//
// The record is pool-watch.jsonl, written once an hour by the paper desk's collector
// (MERIDIAN_RUN_PAPER_DESK=1 on the server). It FAILS CLOSED for entries: no record, a record
// under two unbroken days, or one more than three hours stale, and the venue is refused. It
// fails OPEN for the exit: a venue that cannot be judged is left to the floor and the dump exit,
// which still bound every seat, rather than being sold on a missing reading.
//
// What the paper record said about these rules when they were wired (11-20), so nobody reads the
// wiring as a verdict: across four chains, replayed over the hours they were drawn from, they lost
// $9; on this chain alone they lost $42 to $56. They are scored on fresh hours from 11-20 13:00
// UTC on the Paper desk page. Judge them there before switching them on.
import { statSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { readHourLedger, type LedgerHour } from "./signals/poolWatch.js";
import { refSeatNet, seatNetScore } from "./signals/seatMath.js";

export const RANK_ON_KEPT = (process.env.MERIDIAN_PILOT_RANK_ON_KEPT ?? "off") === "on";
/** Percent of the seat a fresh seat must have lost over the last day to close the venue; 0 is off. */
export const LEAVE_ON_LOSS_PCT = (() => {
  const v = Number(process.env.MERIDIAN_PILOT_LEAVE_ON_LOSS_PCT ?? 0);
  return Number.isFinite(v) && v > 0 && v < 100 ? v : 0;
})();
/** The record is written once an hour; a reading older than this is not acted on. */
export const KEPT_MAX_AGE_MS = 3 * 3_600_000;
const LEDGER = "pool-watch.jsonl";

export interface SeatShape {
  usd: number;
  widthPct: number;
  floorUsd: number;
  gasUsd: number;
  feePct: number;
}

export interface KeptReading {
  /** average of what the seat kept over the 24 day-long seats ending in the last 24 hours */
  avg: number;
  /** what the seat opened 24 hours before the latest recorded hour kept */
  lastDay: number;
  /** unix seconds: the start of the latest recorded hour */
  asOfHour: number;
}

/** PURE: what the desk's seat kept in a pool, read at the latest hour of its record. */
export function keptReading(rows: readonly LedgerHour[], nowMs: number, seat: SeatShape, maxAgeMs = KEPT_MAX_AGE_MS): { ok: true; reading: KeptReading } | { ok: false; reason: string } {
  if (!rows.length) return { ok: false, reason: "no hourly record for this pool" };
  const last = rows[rows.length - 1];
  const ageMs = nowMs - (last.hourStart + 3600) * 1000;
  if (ageMs > maxAgeMs) return { ok: false, reason: `hourly record ${(ageMs / 3_600_000).toFixed(1)}h old` };
  const idx = rows.length - 1;
  const s = seatNetScore(idx, (i0) => refSeatNet(rows, i0, 24, seat.usd, seat.widthPct, seat.floorUsd, seat.gasUsd, seat.feePct));
  if (!Number.isFinite(s.avg) || !Number.isFinite(s.lastDay)) return { ok: false, reason: "under two days of unbroken hourly record" };
  return { ok: true, reading: { avg: s.avg, lastDay: s.lastDay, asOfHour: last.hourStart } };
}

/** PURE: why a venue may not be entered on what its seat kept, or null if it may. */
export function keptEntryRefusal(r: KeptReading, seatUsd: number): string | null {
  if (!(r.avg > 0)) return `a $${seatUsd} seat here kept $${r.avg.toFixed(2)} a day on average over two days`;
  if (!(r.lastDay > 0)) return `a $${seatUsd} seat here kept $${r.lastDay.toFixed(2)} over the last day`;
  return null;
}

/** PURE: has the pool turned: would a fresh seat there have lost more than `pct` percent of itself over the last day? */
export function poolTurned(r: KeptReading, seatUsd: number, pct: number): boolean {
  return pct > 0 && r.lastDay < -(seatUsd * pct) / 100;
}

/**
 * PURE: the seat-kept part of one venue's entry check.
 *   - Ranking on: refuse a venue that cannot be read or did not keep money; rank the rest on the
 *     two-day average, per hour.
 *   - Ranking off, the pool-turned exit on: refuse only a venue that has turned, so the next
 *     tick's entry cannot undo the exit.
 *   - Both off: nothing, and the desk's own fee ranking stands.
 */
export function keptEntryCheck(
  k: { ok: true; reading: KeptReading } | { ok: false; reason: string } | undefined,
  rankOn: boolean,
  leavePct: number,
  seatUsd: number,
): { refusal?: string; rankUsdPerHour?: number } {
  if (rankOn) {
    if (!k || !k.ok) return { refusal: k ? k.reason : "no seat-kept reading" };
    const refusal = keptEntryRefusal(k.reading, seatUsd);
    return refusal ? { refusal } : { rankUsdPerHour: k.reading.avg / 24 };
  }
  if (leavePct > 0 && k?.ok && poolTurned(k.reading, seatUsd, leavePct)) {
    return { refusal: `pool turned: a $${seatUsd} seat here kept $${k.reading.lastDay.toFixed(2)} over the last day` };
  }
  return {};
}

// ---- the record, read at most once per change of the file ------------------------------------

let cache: { mtimeMs: number; size: number; byId: Map<string, LedgerHour[]> } | null = null;

/** The hourly rows recorded for one pool id, oldest first. Re-reads the file only when it changed. */
export function ledgerRowsFor(poolId: string): LedgerHour[] {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(dataPath(LEDGER));
  } catch {
    return [];
  }
  if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
    const byId = new Map<string, LedgerHour[]>();
    for (const [id, rows] of readHourLedger(LEDGER)) byId.set(id.toLowerCase(), rows);
    cache = { mtimeMs: st.mtimeMs, size: st.size, byId };
  }
  return cache.byId.get(poolId.toLowerCase()) ?? [];
}
