// The public earnings timeline: every fee the desk has collected to the house
// wallet, one point per collect, cumulative, with the transaction that paid it.
//
// Until 2026-09-04 this read the OpenHermit treasury's history off Blockscout
// (MERD fee share from the PONS locker plus the desk's daily skims). The
// operator retired that wallet from the site and the engine ("never use that
// wallet again"), so the series is now what the execution wallet itself earns:
// the attribution ledger's collect rows, both sleeves, exact by construction
// since every collect is a landed receipt. No explorer, no cache dependency on
// a third party, and nothing on the site points at the old address.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";

export interface EarningsPoint {
  ts: number;
  /** Cumulative fees collected, USD. */
  usd: number;
  /** Kept for older clients: the same cumulative figure in ETH at the served ETH price. */
  eth: number;
  /** Which sleeve collected it: "usdg" seats or the "meme" rotor. */
  src: string;
  /** The venue the fee came from. */
  venue: string;
  /** This collect's own amount, USD. */
  amountUsd: number;
  /** The on-chain receipt when the row carries one. */
  tx?: string;
}

let cache: { at: number; points: EarningsPoint[]; ethUsd: number } | null = null;
const CACHE_MS = 60 * 1000;

/** PURE: fold attribution rows into the cumulative collect timeline. Exported for tests. */
export function foldEarnings(rows: ReadonlyArray<Record<string, unknown>>, ethUsd: number): EarningsPoint[] {
  const collects = rows
    .filter((r) => r && r.mech === "collect" && Number(r.feeUsd) > 0 && Number.isFinite(Number(r.ts)))
    .map((r) => ({ ts: Number(r.ts), usd: Number(r.feeUsd), src: String(r.sleeve ?? "usdg"), venue: String(r.venue ?? ""), tx: typeof r.tx === "string" && r.tx ? String(r.tx) : undefined }))
    .sort((a, b) => a.ts - b.ts);
  let cum = 0;
  return collects.map((c) => {
    cum += c.usd;
    const usd = Math.round(cum * 100) / 100;
    return { ts: c.ts, usd, eth: ethUsd > 0 ? Math.round((usd / ethUsd) * 1e6) / 1e6 : 0, src: c.src, venue: c.venue, amountUsd: Math.round(c.usd * 100) / 100, tx: c.tx };
  });
}

function readAttributionRows(): Record<string, unknown>[] {
  const p = dataPath("attribution.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((r): r is Record<string, unknown> => !!r);
}

export async function earningsTimeline(ethUsd: number): Promise<EarningsPoint[]> {
  if (cache && Date.now() - cache.at < CACHE_MS && cache.ethUsd === ethUsd) return cache.points;
  const points = foldEarnings(readAttributionRows(), ethUsd);
  cache = { at: Date.now(), points, ethUsd };
  return points;
}
