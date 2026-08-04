import type { AgentDecision, RwaAsset } from "../types.js";
import type { Strategy } from "./Strategy.js";
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";
import { lpPositionsWithValue } from "../venues/lpPositions.js";
import { phaseOf } from "../lpGuard.js";
import { universe } from "../state.js";
import { opportunitiesSnapshot } from "../signals/opportunities.js";

/**
 * The live-desk narrator. Its job is to SHOW that Merd and the research swarm
 * are constantly gathering data: every cycle it surfaces real, measured research
 * activity from the samplers (perp venue, on-chain yields, spot-vs-NYSE basis),
 * the mapped RWA universe, and the deterministic opportunity scan, then closes
 * with the market-making posture. It rotates which source LEADS each cycle so
 * the terminal reads as a desk actively working, not a static readout. Every
 * number here is observed by a sampler, never invented. Narrate-only: always
 * returns `hold`, so it never triggers execution.
 */

// Read the last non-empty JSON rows of a sampler ledger (tail only — cheap even
// as the file grows). Returns newest-first.
function tailRows(file: string, n: number): any[] {
  try {
    const p = dataPath(file);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    const out: any[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function perpObs(): string | null {
  const [row] = tailRows("lighter-log.jsonl", 1);
  if (!row || !Array.isArray(row.m) || row.m.length === 0) return null;
  const ms = row.m as [string, number, number, number, number | null, number | null][];
  const total = ms.reduce((s, m) => s + (m[2] || 0), 0);
  const busiest = [...ms].sort((a, b) => (b[2] || 0) - (a[2] || 0))[0];
  return `Polled the perp venue: ${ms.length} markets, about $${(total / 1e6).toFixed(1)}M in 24h flow. Busiest book ${busiest[0]} at $${Math.round((busiest[2] || 0) / 1000)}k. Watching funding for any move off baseline.`;
}

function yieldObs(): string | null {
  const [row] = tailRows("yield-log.jsonl", 1);
  if (!row) return null;
  const parts: string[] = [];
  if (typeof row.syrupPremiumPct === "number" && row.syrupDepthUsd)
    parts.push(`syrupUSDG sitting ${row.syrupPremiumPct.toFixed(2)}% over par, ~$${(row.syrupDepthUsd / 1e6).toFixed(1)}M deep`);
  if (row.indexImpliedAprPct != null) parts.push(`$INDEX distribution implying ~${Math.round(row.indexImpliedAprPct)}% APR`);
  return parts.length ? `Checked on-chain yields: ${parts.join("; ")}.` : null;
}

function basisObs(): string | null {
  const rows = tailRows("basis-log.jsonl", 12).filter((r) => typeof r.basisPct === "number");
  if (!rows.length) return null;
  const newest = rows[0].ts;
  const batch = rows.filter((r) => r.ts === newest);
  const top = batch.sort((a, b) => Math.abs(b.basisPct) - Math.abs(a.basisPct))[0];
  const dir = top.basisPct >= 0 ? "above" : "below";
  return `Basis watch: ${top.symbol} pool ${Math.abs(top.basisPct).toFixed(2)}% ${dir} its real-market print.`;
}

function universeObs(): string | null {
  try {
    const s: any = universe.status();
    if (!s?.totalVenues) return null;
    return `Mapping the tokenized-RWA universe: ${s.totalVenues} venues tracked across treasuries, equities, credit, and more.`;
  } catch {
    return null;
  }
}

function opportunityObs(): string | null {
  try {
    const s: any = opportunitiesSnapshot();
    return s?.headline ? `Re-scored opportunities. Best measured, accessible one: ${s.headline}.` : null;
  } catch {
    return null;
  }
}

const LEADS = [perpObs, yieldObs, basisObs, universeObs, opportunityObs];

export class ResearchStrategy implements Strategy {
  readonly name = "research-desk";

  async evaluate(_assets: RwaAsset[]): Promise<AgentDecision> {
    const timestamp = Date.now();
    const thoughts: string[] = [];

    // Rotate which research source leads, so consecutive cycles vary and the
    // desk reads as continuously working through the landscape.
    const cycle = Math.floor(timestamp / 30000);
    const built = LEADS.map((fn) => fn());
    const available = built.map((v, i) => ({ v, i })).filter((x) => x.v);
    if (available.length) {
      const lead = available[cycle % available.length];
      thoughts.push(lead.v as string);
      // add one more observation (the next available source) for texture
      const next = available[(cycle + 1) % available.length];
      if (next && next.i !== lead.i) thoughts.push(next.v as string);
    } else {
      thoughts.push("Warming up the research feed: samplers coming online, gathering the first readings across venues, yields, and basis.");
    }

    // Always close with the market-making posture, so the desk stays honest
    // about what it would actually do with what it just learned.
    try {
      const positions = await lpPositionsWithValue();
      const phase = phaseOf(new Date());
      if (positions.length === 0) {
        thoughts.push(
          phase === "weekday-market"
            ? "Book: flat during market hours, holding for a pool that clears the cost-aware bar before deploying."
            : "Book: flat and off-hours, staying out by design rather than chasing informed moves.",
        );
      } else {
        for (const p of positions) {
          // Positions in venues the pricer does not know (the ETH-quoted meme
          // family) come back with an address-shaped symbol and raw liquidity
          // units where a dollar value should be. Narrating that printed
          // "0x0000.../USDG with $2.3e15 working" on the public desk. Name
          // them honestly and skip the number we cannot price.
          if (!/^[A-Z0-9]{1,12}$/.test(p.symbol)) {
            thoughts.push(
              `Book: making markets in a 24/7 ETH-quoted venue (position #${p.tokenId}), ${p.inRange ? "in range and earning the fee" : "out of range, watching whether to re-ladder"}. Fees accrue on-chain; full pricing lands when the desk's pricer covers this venue.`,
            );
            continue;
          }
          thoughts.push(
            `Book: making markets in ${p.symbol}/USDG, a +/-${p.rangePct.toFixed(1)}% band with ~$${p.valueUsd.toFixed(0)} working, ${p.inRange ? "in range and earning the fee" : "out of range, watching whether to re-center"}.`,
          );
        }
      }
    } catch {
      thoughts.push("Book: reading current position state from Robinhood Chain.");
    }

    return { timestamp, action: "hold", reason: "scanning the market for opportunities", thoughts };
  }
}
