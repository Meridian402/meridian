// THE CLOSED RECORD (2026-09-07). The operator wound the Meridian desk down and
// asked that the site keep showing the final figures exactly as they stood,
// while the house wallet is emptied. The honest way to do both: close the
// record. When MERIDIAN_RECORD_CLOSED_AT is set, the trading loops and the
// book snapshotter do not start (nothing new is written to any ledger, so
// every history endpoint freezes at its last row by construction), and this
// module serves the final book figures captured at close from
// record-closed.json, with the close date, so the site can say plainly that
// nothing here is live any more. Unset the variable and the desk boots as
// before.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLOSED_RECORD } from "./recordClosedFigures.js";

export interface ClosedRecord {
  closedAt: string;
  closedLabel: string;
  note: string;
  book: { profitUsd: number; bookUsd: number; bankedUsd: number; workingUsd: number; bookEth: number; totalAssetsUsd: number; merdAmt: number; capitalInUsd: number; startedLabel: string };
  record: { daysLive: number; lifetimeFeesUsd: number; bestDayUsd: number; worstDaySinceFloorUsd: number; feesCollectedTimelineUsd: number };
  wallets: { house: string; ethUsdAtClose: number };
}

/** PURE: is the record closed, given the env value? Empty or unparseable = open. */
export function parseClosedAt(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const RECORD_CLOSED_AT: string | null = parseClosedAt(process.env.MERIDIAN_RECORD_CLOSED_AT);
export const RECORD_CLOSED = RECORD_CLOSED_AT != null;

let cached: ClosedRecord | null | undefined;
/** The final figures. The JSON at the agent root wins when present (humans and
 *  tests read it); the embedded copy in recordClosedFigures.ts is what the
 *  Railway image carries, since the image ships dist/ and node_modules only. */
export function closedRecord(): ClosedRecord | null {
  if (cached !== undefined) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "record-closed.json"), join(here, "..", "..", "record-closed.json"), join(process.cwd(), "record-closed.json")];
    const p = candidates.find((c) => existsSync(c));
    cached = p ? (JSON.parse(readFileSync(p, "utf8")) as ClosedRecord) : CLOSED_RECORD;
  } catch {
    cached = CLOSED_RECORD;
  }
  return cached;
}

/** What /api/record-status serves. */
export function recordStatus(): { closed: boolean; closedAt: string | null; record: ClosedRecord | null } {
  return { closed: RECORD_CLOSED, closedAt: RECORD_CLOSED_AT, record: RECORD_CLOSED ? closedRecord() : null };
}
