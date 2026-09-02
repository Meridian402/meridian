// Loop liveness: one registry of heartbeats for the autonomous loops, so a
// loop that has silently stopped ticking is visible (/health, /api/ops) and,
// for the loops that manage money, fatal.
//
// Why fatal: Railway's healthcheck is deploy-time only (its docs: "not used
// for continuous monitoring"), and a setInterval callback that hangs on an
// await keeps the process alive while nothing manages the book. The 31.6-hour
// gap of 2026-08-21/22 had exactly that shape: a live process, a dead desk.
// The house-lock ceiling (houseWallet.ts) already exits for one failure mode,
// a lock held past 15 minutes; this covers the other, a loop that stops
// completing ticks. The exit floor here sits ABOVE the lock ceiling on
// purpose, so when the lock is the cause the lock watchdog fires first, and
// this one only fires for a loop that is stale without holding it.
//
// Exit is the honest recovery, for the reasons houseWallet.ts states: state
// is persisted, every guard reconciles from chain on boot, and Railway
// restarts on a non-zero exit. A beat is recorded when a tick COMPLETES (or
// deliberately yields), never when it starts, so a hung tick starves its own
// heartbeat instead of looking alive.

export interface LoopEntry {
  name: string;
  /** How often the loop is supposed to complete a tick. */
  everyMs: number;
  /** A money loop stale past the exit threshold ends the process. */
  money: boolean;
  registeredAt: number;
  lastBeat: number | null;
  beats: number;
}

export interface LoopVerdict {
  name: string;
  everyMs: number;
  money: boolean;
  lastBeat: number | null;
  beats: number;
  /** Since the last beat, or since registration when it has never beaten. */
  ageMs: number;
  staleAfterMs: number;
  stale: boolean;
}

const STALE_MULT = 3;
const STALE_FLOOR_MS = 10 * 60 * 1000;
const EXIT_MULT = 4;
// 30 minutes: above the 15-minute house-lock ceiling by design (see above).
// 0 disables the exit and leaves the report.
export const EXIT_FLOOR_MS = Number(process.env.MERIDIAN_LOOP_EXIT_MIN ?? 30) * 60 * 1000;
const WATCH_MS = 60 * 1000;

const loops = new Map<string, LoopEntry>();

/** PURE: a loop is stale once it has missed several periods, with a floor so
 *  a fast loop is not judged on a single slow RPC. */
export function staleAfterMs(everyMs: number, mult = STALE_MULT, floorMs = STALE_FLOOR_MS): number {
  return Math.max(mult * everyMs, floorMs);
}

/** PURE: the exit threshold for a money loop. A zero floor disables it. */
export function exitAfterMs(everyMs: number, floorMs = EXIT_FLOOR_MS, mult = EXIT_MULT): number {
  if (!Number.isFinite(floorMs) || floorMs <= 0) return Infinity;
  return Math.max(mult * everyMs, floorMs);
}

/** PURE: judge a set of entries at `now`. */
export function judgeLoops(entries: readonly LoopEntry[], now: number): LoopVerdict[] {
  return entries.map((e) => {
    const ageMs = Math.max(0, now - (e.lastBeat ?? e.registeredAt));
    const after = staleAfterMs(e.everyMs);
    return { name: e.name, everyMs: e.everyMs, money: e.money, lastBeat: e.lastBeat, beats: e.beats, ageMs, staleAfterMs: after, stale: ageMs > after };
  });
}

/** PURE: the first money loop past its exit threshold, or null. */
export function exitCandidate(verdicts: readonly LoopVerdict[], exitFloorMs = EXIT_FLOOR_MS): LoopVerdict | null {
  for (const v of verdicts) {
    if (!v.money) continue;
    if (v.ageMs > exitAfterMs(v.everyMs, exitFloorMs)) return v;
  }
  return null;
}

export function registerLoop(name: string, everyMs: number, opts: { money?: boolean } = {}): void {
  const prev = loops.get(name);
  loops.set(name, {
    name,
    everyMs,
    money: opts.money ?? false,
    registeredAt: prev?.registeredAt ?? Date.now(),
    lastBeat: prev?.lastBeat ?? null,
    beats: prev?.beats ?? 0,
  });
}

/** Stamp a completed tick. Unregistered names are ignored so a stray call
 *  can never invent a loop the operator has to reason about. */
export function beat(name: string): void {
  const e = loops.get(name);
  if (!e) return;
  e.lastBeat = Date.now();
  e.beats += 1;
}

export function loopVerdicts(now = Date.now()): LoopVerdict[] {
  return judgeLoops([...loops.values()], now);
}

/** What /health and /api/ops publish. ok is false only when a MONEY loop is
 *  stale; a stale report-only loop is listed but does not fail the check. */
export function livenessSnapshot(now = Date.now()): { ok: boolean; stale: string[]; loops: LoopVerdict[] } {
  const verdicts = loopVerdicts(now);
  const stale = verdicts.filter((v) => v.stale).map((v) => v.name);
  return { ok: !verdicts.some((v) => v.stale && v.money), stale, loops: verdicts };
}

/** Test hook. */
export function _resetLiveness(): void {
  loops.clear();
}

let lastNag = 0;

/** Every minute: log stale loops (throttled), and exit for a money loop past
 *  the exit threshold. Runs engine on or off; with the engine off no money
 *  loop is registered, so it can only ever report. */
export function startLivenessWatchdog(): NodeJS.Timeout {
  const t = setInterval(() => {
    const verdicts = loopVerdicts();
    const stale = verdicts.filter((v) => v.stale);
    if (stale.length > 0 && Date.now() - lastNag > 5 * 60 * 1000) {
      lastNag = Date.now();
      console.error(`[liveness] stale: ${stale.map((v) => `${v.name} ${Math.round(v.ageMs / 60000)}m (limit ${Math.round(v.staleAfterMs / 60000)}m)`).join(", ")}`);
    }
    const fatal = exitCandidate(verdicts);
    if (fatal) {
      console.error(
        `[liveness] UNRECOVERABLE: money loop "${fatal.name}" has not completed a tick for ${Math.round(fatal.ageMs / 60000)}m ` +
          `(period ${Math.round(fatal.everyMs / 1000)}s, exit past ${Math.round(exitAfterMs(fatal.everyMs) / 60000)}m). ` +
          `Exiting for a clean supervised restart; the guards reconcile from chain on boot.`,
      );
      process.exit(1);
    }
  }, WATCH_MS);
  t.unref?.();
  const money = [...loops.values()].filter((l) => l.money).map((l) => l.name);
  console.error(
    `[liveness] watchdog armed: ${loops.size} loop(s) reporting, ${money.length} money loop(s) fatal past ${EXIT_FLOOR_MS > 0 ? `${Math.round(EXIT_FLOOR_MS / 60000)}m` : "never (MERIDIAN_LOOP_EXIT_MIN=0)"}${money.length ? ` [${money.join(", ")}]` : ""}`,
  );
  return t;
}
