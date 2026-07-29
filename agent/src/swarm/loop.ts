// The scheduler. Off unless MERIDIAN_SWARM is explicitly "on", like the LP
// engine: deploying a build and starting to spend model tokens on conversations
// are two different decisions, and a fresh box, a rollback or an unintended
// restart must do the quiet thing by default.
import { runExchange } from "./exchange.js";
import { exchangesSince } from "./feed.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PER_DAY = 24;

export function swarmEnabled(): boolean {
  return process.env.MERIDIAN_SWARM === "on";
}

/** Cadence, floored in code: a mistyped env must not turn this into a hot loop
 *  against the gateway. */
export function swarmIntervalMs(): number {
  const raw = Number(process.env.SWARM_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(raw));
}

export function swarmMaxPerDay(): number {
  const raw = Number(process.env.SWARM_MAX_PER_DAY ?? DEFAULT_MAX_PER_DAY);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_PER_DAY;
  return Math.floor(raw);
}

/** Today's budget, counted from the ledger rather than a process counter, so a
 *  restart (or ten) cannot hand the loop a fresh day's allowance. */
export function dailyBudget(): { used: number; max: number; remaining: number } {
  const used = exchangesSince(Date.now() - DAY_MS);
  const max = swarmMaxPerDay();
  return { used, max, remaining: Math.max(0, max - used) };
}

let capLogged = false;

async function tick(): Promise<void> {
  const budget = dailyBudget();
  if (budget.remaining <= 0) {
    if (!capLogged) console.error(`[swarm] daily cap reached (${budget.used}/${budget.max} in the last 24h), holding off`);
    capLogged = true;
    return;
  }
  capLogged = false;
  const result = await runExchange();
  if (!result.ok) console.error(`[swarm] scheduled exchange produced nothing: ${result.reason}`);
}

/**
 * Start the cadence. The first exchange runs one full interval after boot, not
 * at boot: a crash-restart loop would otherwise spend the entire daily budget
 * in minutes.
 */
export function startSwarmLoop(): NodeJS.Timeout | null {
  if (!swarmEnabled()) {
    console.log("[boot] swarm off (set MERIDIAN_SWARM=on to let agents hold public exchanges on a cadence)");
    return null;
  }
  const interval = swarmIntervalMs();
  console.log(`[boot] swarm ON: one agent-to-agent exchange every ${Math.round(interval / 60000)}min, max ${swarmMaxPerDay()} per 24h`);
  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  return timer;
}
