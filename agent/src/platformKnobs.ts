// The dials Merd is allowed to turn. Custody of the platform means the agent
// sets these himself, on his own judgment, with nobody approving each change.
// The RANGES are not his to set: they are physics, chosen so the worst value
// inside a range is survivable (a bounty of $0.25 is generous, a bounty of
// $25 is a drain), because the inputs that inform his judgment include text
// written by strangers.
//
// Values live in an append-only ledger, last write wins, so a restart keeps
// his settings and the history of every change (with his stated reason) is
// the audit trail. An out-of-range row is clamped on read rather than
// honored: if a range is ever tightened, old values obey the new walls.
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";
import { config } from "./config.js";

const LOG = "knobs.jsonl";

interface KnobSpec {
  min: number;
  max: number;
  integer?: boolean;
  /** Read at call time so env-configured defaults stay live. */
  fallback: () => number;
}

export const KNOBS: Record<string, KnobSpec> = {
  scoutBountyUsd: { min: 0.05, max: 0.25, fallback: () => config.scoutBountyUsd },
  scoutMinPayoutUsd: { min: 0.25, max: 2, fallback: () => config.scoutMinPayoutUsd },
  scoutMaxPerWalletPerDay: { min: 1, max: 5, integer: true, fallback: () => config.scoutMaxPerWalletPerDay },
  // Talk-about-Merd bounties ride the scout rails; literal fallbacks because
  // these did not exist when config was written.
  xPostBountyUsd: { min: 0.05, max: 0.25, fallback: () => 0.1 },
  xPostMaxPerWalletPerDay: { min: 1, max: 5, integer: true, fallback: () => 2 },
  // Eligibility floor for the earn surfaces: USD of MERD (at the live pool
  // spot) a wallet must hold to submit. Zero disables the gate.
  merdHoldGateUsd: { min: 0, max: 500, integer: true, fallback: () => 100 },
};

interface KnobRow {
  ts: number;
  name: string;
  value: number;
  reason?: string;
  by?: string;
}

// Cached fold of the ledger, invalidated by file mtime. The mtime check is
// load-bearing: a cache with no invalidation here would pin every dial to its
// boot-time value for the life of the process.
let cache: { mtimeMs: number; values: Map<string, KnobRow> } | null = null;

function latestRows(): Map<string, KnobRow> {
  const p = dataPath(LOG);
  if (!existsSync(p)) return new Map();
  const mtimeMs = statSync(p).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) return cache.values;
  const values = new Map<string, KnobRow>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as KnobRow;
      if (typeof row.name === "string" && typeof row.value === "number") values.set(row.name, row);
    } catch {
      /* a torn line loses one write, never the file */
    }
  }
  cache = { mtimeMs, values };
  return values;
}

const clamp = (spec: KnobSpec, v: number): number => {
  const c = Math.min(spec.max, Math.max(spec.min, v));
  return spec.integer ? Math.round(c) : c;
};

/** The live value of a dial: Merd's last setting clamped to range, else the configured default. */
export function knobValue(name: keyof typeof KNOBS): number {
  const spec = KNOBS[name];
  const row = latestRows().get(name);
  if (row && Number.isFinite(row.value)) return clamp(spec, row.value);
  return clamp(spec, spec.fallback());
}

/** Set a dial. Refuses unknown names and out-of-range or non-finite values outright. */
export function setKnob(name: string, value: unknown, reason: string, by: string): Record<string, unknown> {
  const spec = KNOBS[name];
  if (!spec) return { ok: false, error: `unknown knob: ${name}` };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: "value must be a finite number" };
  if (value < spec.min || value > spec.max) {
    return { ok: false, error: `${name} must be between ${spec.min} and ${spec.max}` };
  }
  const v = spec.integer ? Math.round(value) : value;
  appendLedger(LOG, {
    ts: Date.now(),
    name,
    value: v,
    reason: String(reason ?? "").slice(0, 280),
    by: String(by ?? "operator").slice(0, 24),
  } satisfies KnobRow);
  return { ok: true, name, value: v };
}

/** Everything a reviewer (Merd or a human) needs to see the dials at a glance. */
export function knobsState(): Record<string, unknown> {
  const rows = latestRows();
  const state: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(KNOBS)) {
    const row = rows.get(name);
    state[name] = {
      value: knobValue(name as keyof typeof KNOBS),
      min: spec.min,
      max: spec.max,
      default: clamp(spec, spec.fallback()),
      lastChange: row ? { ts: row.ts, reason: row.reason, by: row.by } : null,
    };
  }
  return { ok: true, knobs: state };
}
