// Backpressure + fairness for the LLM chat endpoints. Three independent guards,
// applied in order to /api/my-agent/message and /stream:
//
//   #4 per-wallet token bucket  — one wallet can't spam the model
//   #2 per-wallet single-flight — one in-flight turn per wallet at a time
//   #3 global concurrency slot  — cap simultaneous LLM turns; overflow WAITS
//      briefly for a slot (graceful) instead of a hard failure
//
// All in-memory (per process). Fine for the single backend replica; when we go
// multi-replica these move to a shared store alongside the SIWE-nonce fix.

const RATE_BURST = Number(process.env.CHAT_RATE_BURST ?? 5); // tokens
const RATE_REFILL_MS = Number(process.env.CHAT_RATE_REFILL_MS ?? 3000); // +1 token / 3s
const MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT ?? 40);
const ACQUIRE_TIMEOUT_MS = Number(process.env.CHAT_ACQUIRE_TIMEOUT_MS ?? 15000);
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * How long an SSE turn may go with NO event from the gateway before the route
 * gives up on it. This is the guard that stops a hung upstream holding a global
 * slot and a wallet's single-flight lock forever. Read at call time so it can be
 * changed without a rebuild, and floored in code because a zero or negative
 * value would abort every stream the instant it started.
 */
export function streamIdleTimeoutMs(): number {
  const raw = Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return Math.max(1000, Math.floor(raw));
}

// ---- #4 per-wallet token bucket ----------------------------------------------
const buckets = new Map<string, { tokens: number; last: number }>();

/** Consume one token; false = rate-limited (too many messages too fast). */
export function rateLimitOk(address: string): boolean {
  const now = Date.now();
  const b = buckets.get(address) ?? { tokens: RATE_BURST, last: now };
  const refill = Math.floor((now - b.last) / RATE_REFILL_MS);
  if (refill > 0) {
    b.tokens = Math.min(RATE_BURST, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens <= 0) {
    buckets.set(address, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(address, b);
  // Opportunistic prune so the map can't grow unbounded across many wallets.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.tokens >= RATE_BURST && now - v.last > 10 * 60_000) buckets.delete(k);
    }
  }
  return true;
}

// ---- #2 per-wallet single-flight ---------------------------------------------
const inFlight = new Set<string>();

/** Reserve this wallet's single turn slot; false = a turn is already running. */
export function tryBeginTurn(address: string): boolean {
  if (inFlight.has(address)) return false;
  inFlight.add(address);
  return true;
}
export function endTurn(address: string): void {
  inFlight.delete(address);
}

// ---- #3 global concurrency semaphore -----------------------------------------
let active = 0;
const waiters: Array<{ resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }> = [];

/**
 * Acquire a global LLM slot. Resolves true immediately if under the cap, else
 * waits up to `timeoutMs` for one to free (returns false if none does). A freed
 * slot is handed directly to the next waiter, so the cap is never exceeded.
 */
export function acquireSlot(timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<boolean> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.findIndex((w) => w.resolve === resolve);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    waiters.push({ resolve, timer });
  });
}

/** Release a slot: hand it to the next waiter, or drop the active count. */
export function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true); // slot transfers; active count stays the same
  } else {
    active = Math.max(0, active - 1);
  }
}

/** Snapshot for observability. */
export function chatLoad(): { active: number; queued: number; max: number } {
  return { active, queued: waiters.length, max: MAX_CONCURRENT };
}
