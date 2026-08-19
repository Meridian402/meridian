// THE ACCOUNTANT (Phase 0 of the bleed program, 2026-08-18). The audit's
// finding V5: fees print daily while realized losses are recorded nowhere,
// so nobody can answer "which venue lost the money". This ledger fixes that
// with one row per money-moving operation, written at call sites that
// already hold every number and were throwing them away.
//
// The model is CASH-BOUNDARY FLOW accounting. Cash is ETH + USDG in the
// signer wallet. usdIn is cash leaving into a venue (a mint's USDG side, a
// token buy, a band's ETH); usdOut is cash coming back (a withdraw's USDG
// side, a sell's proceeds, a stop's ETH). Token inventory in between is
// deliberately NOT valued per row: it is counted when bought (usdIn) and
// when finally sold (usdOut), so over any closed cycle
//   net = sum(usdOut) - sum(usdIn) - sum(gasUsd)
// is EXACT realized P&L per venue, with no marks, no basis guesses, and no
// double counting. feeUsd separately states the income component (both
// sides of a collect, valued at collection-time price) so earning and
// bleeding can be read side by side.
//
// Attribution must never break a trading path: every write is best-effort,
// and the async price fetch inside attribute() swallows its own errors.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";

export type Sleeve = "usdg" | "meme";

export interface AttributionRow {
  ts: number;
  sleeve: Sleeve;
  venue: string;
  tokenId?: string;
  /** mint | token-buy | collect | withdraw | floor-exit | recenter-close |
   *  lp-close | breaker-flatten | sell | band-mint | catch-mint | stop-exit |
   *  sweep | rotate | breaker-withdraw | stale-withdraw */
  mech: string;
  usdIn: number;
  usdOut: number;
  feeUsd: number;
  gasUsd: number;
  /** Spot stamps for auditability; 0 when not applicable or unknown. */
  ethUsd: number;
  tokenUsd?: number;
  tx?: string;
  backfilled?: boolean;
  /** Set when a value had to be estimated (backfill without exact data). */
  approx?: boolean;
}

const FILE = "attribution.jsonl";

/** PURE: gas cost of a receipt in USD. */
export function gasUsdOf(gasUsed: bigint, effectiveGasPrice: bigint | undefined, ethUsd: number): number {
  if (!effectiveGasPrice || !Number.isFinite(ethUsd) || ethUsd <= 0) return 0;
  return (Number(gasUsed * effectiveGasPrice) / 1e18) * ethUsd;
}

/** Record one operation. `gasWei` (gasUsed * effectiveGasPrice) is converted
 *  with a live ETH price; ETH-denominated callers pass amounts already in USD.
 *  Fire-and-forget by design: call as `void attribute({...})`. */
export async function attribute(
  row: Omit<AttributionRow, "ts" | "gasUsd" | "ethUsd"> & { gasWei?: bigint; ethUsd?: number },
): Promise<void> {
  try {
    const ethUsd = row.ethUsd ?? (await fetchEthUsd().catch(() => 0)) ?? 0;
    const { gasWei, ...rest } = row;
    const full: AttributionRow = {
      ts: Date.now(),
      ...rest,
      ethUsd,
      gasUsd: gasWei ? (Number(gasWei) / 1e18) * ethUsd : 0,
    };
    appendLedger(FILE, full);
  } catch (err) {
    console.error(`[attribution] row dropped (${row.mech} ${row.venue}): ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }
}

/** Synchronous variant for backfill and callers that already have every number. */
export function recordAttribution(row: AttributionRow): void {
  try {
    appendLedger(FILE, row);
  } catch (err) {
    console.error(`[attribution] row dropped: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }
}

export function readAttributionRows(sinceMs: number): AttributionRow[] {
  const path = dataPath(FILE);
  if (!existsSync(path)) return [];
  const rows: AttributionRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as AttributionRow;
      if (r.ts >= sinceMs && Number.isFinite(r.usdIn) && Number.isFinite(r.usdOut)) rows.push(r);
    } catch {
      /* skip a bad line */
    }
  }
  return rows;
}

export interface VenueAttribution {
  venue: string;
  sleeve: Sleeve;
  ops: number;
  usdIn: number;
  usdOut: number;
  feeUsd: number;
  gasUsd: number;
  /** usdOut - usdIn - gasUsd: exact realized flow, negative = the venue took money. */
  netUsd: number;
  byMech: Record<string, { ops: number; usdIn: number; usdOut: number; feeUsd: number }>;
  hasApprox: boolean;
}

/** PURE: fold rows into the per-venue truth table, worst venue first. */
export function aggregateAttribution(rows: readonly AttributionRow[]): {
  venues: VenueAttribution[];
  totals: { usdIn: number; usdOut: number; feeUsd: number; gasUsd: number; netUsd: number; ops: number };
} {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const byVenue = new Map<string, VenueAttribution>();
  for (const r of rows) {
    const key = `${r.sleeve}:${r.venue}`;
    let v = byVenue.get(key);
    if (!v) {
      v = { venue: r.venue, sleeve: r.sleeve, ops: 0, usdIn: 0, usdOut: 0, feeUsd: 0, gasUsd: 0, netUsd: 0, byMech: {}, hasApprox: false };
      byVenue.set(key, v);
    }
    v.ops += 1;
    v.usdIn += r.usdIn;
    v.usdOut += r.usdOut;
    v.feeUsd += r.feeUsd;
    v.gasUsd += r.gasUsd;
    if (r.approx) v.hasApprox = true;
    const m = (v.byMech[r.mech] ??= { ops: 0, usdIn: 0, usdOut: 0, feeUsd: 0 });
    m.ops += 1;
    m.usdIn += r.usdIn;
    m.usdOut += r.usdOut;
    m.feeUsd += r.feeUsd;
  }
  const venues = [...byVenue.values()].map((v) => {
    v.netUsd = r2(v.usdOut - v.usdIn - v.gasUsd);
    v.usdIn = r2(v.usdIn);
    v.usdOut = r2(v.usdOut);
    v.feeUsd = r2(v.feeUsd);
    v.gasUsd = r2(v.gasUsd);
    for (const m of Object.values(v.byMech)) {
      m.usdIn = r2(m.usdIn);
      m.usdOut = r2(m.usdOut);
      m.feeUsd = r2(m.feeUsd);
    }
    return v;
  });
  venues.sort((a, b) => a.netUsd - b.netUsd);
  const totals = venues.reduce(
    (t, v) => ({
      usdIn: r2(t.usdIn + v.usdIn),
      usdOut: r2(t.usdOut + v.usdOut),
      feeUsd: r2(t.feeUsd + v.feeUsd),
      gasUsd: r2(t.gasUsd + v.gasUsd),
      netUsd: r2(t.netUsd + v.netUsd),
      ops: t.ops + v.ops,
    }),
    { usdIn: 0, usdOut: 0, feeUsd: 0, gasUsd: 0, netUsd: 0, ops: 0 },
  );
  return { venues, totals };
}

// THE REALIZED-P&L ADMISSION GATE (bleed program phase 2). The audit's V4:
// a venue could stop the desk out repeatedly and be re-admitted at full
// size hours later, because nothing read our own results back. Admission
// now consults this ledger: a venue whose measured record over the trailing
// window is worse than the floor does not get new capital, whatever the
// pool-level tape says. Two correctness rules learned before writing it:
// backfilled rows are EXCLUDED (their documented holes would ban every
// venue forever), and the caller passes the venue's OPEN exposure so
// capital that is deployed-but-alive is not scored as lost.
const REALIZED_FLOOR_USD = Number(process.env.MERIDIAN_VENUE_REALIZED_FLOOR_USD ?? 25);
const REALIZED_DAYS = Number(process.env.MERIDIAN_VENUE_REALIZED_DAYS ?? 7);

/** PURE: does a venue's measured record admit new capital? */
export function venueRealizedAdmits(netUsd: number, floorUsd = REALIZED_FLOOR_USD): { ok: boolean; reason: string } {
  if (netUsd >= -Math.abs(floorUsd)) return { ok: true, reason: "" };
  return { ok: false, reason: `measured net $${netUsd.toFixed(2)} over the last ${REALIZED_DAYS}d is below the -$${Math.abs(floorUsd).toFixed(0)} admission floor; the window has to roll off before this venue sees new capital` };
}

let admissionCache: { at: number; byKey: Map<string, number> } | null = null;

/** The gate itself: live-row cash flow for the venue over the window, plus
 *  the caller's current open exposure there (flow alone reads an open
 *  position as pure cash out). 60s cache: admission runs on every pass. */
export function venueEarnsAdmission(sleeve: Sleeve, venue: string, openExposureUsd = 0): { ok: boolean; reason: string; netUsd: number } {
  const now = Date.now();
  if (!admissionCache || now - admissionCache.at > 60_000) {
    const byKey = new Map<string, number>();
    for (const r of readAttributionRows(now - REALIZED_DAYS * 24 * 3600e3)) {
      if (r.backfilled || r.approx) continue;
      const k = `${r.sleeve}:${r.venue}`;
      byKey.set(k, (byKey.get(k) ?? 0) + r.usdOut - r.usdIn - r.gasUsd);
    }
    admissionCache = { at: now, byKey };
  }
  const netUsd = Math.round(((admissionCache.byKey.get(`${sleeve}:${venue}`) ?? 0) + Math.max(0, openExposureUsd)) * 100) / 100;
  return { ...venueRealizedAdmits(netUsd), netUsd };
}

/** The nightly print: per-venue truth to the log, worst first. Wired to a
 *  24h interval at boot; also computable on demand via /api/attribution. */
export function printAttributionReport(daysBack = 1): void {
  const rows = readAttributionRows(Date.now() - daysBack * 24 * 3600e3);
  if (rows.length === 0) return;
  const { venues, totals } = aggregateAttribution(rows);
  console.error(`[attribution] last ${daysBack}d, ${totals.ops} ops: in $${totals.usdIn}, out $${totals.usdOut}, fees $${totals.feeUsd}, gas $${totals.gasUsd}, NET $${totals.netUsd}`);
  for (const v of venues) {
    const mechs = Object.entries(v.byMech)
      .map(([m, x]) => `${m} ${x.ops}x ${(x.usdOut - x.usdIn) >= 0 ? "+" : ""}$${(x.usdOut - x.usdIn).toFixed(2)}`)
      .join(", ");
    console.error(`[attribution]   ${v.sleeve}:${v.venue}: net ${v.netUsd >= 0 ? "+" : ""}$${v.netUsd} (fees $${v.feeUsd}, gas $${v.gasUsd})${v.hasApprox ? " ~approx" : ""} [${mechs}]`);
  }
}
