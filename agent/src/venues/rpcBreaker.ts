// THE RPC LEG BREAKER. Read path only.
//
// Reads go through a fallback list: the dedicated provider first, the public
// endpoint last (see config.robinhoodReadRpcUrls). That design assumed a failing
// primary would fail FAST. It does not when the provider REJECTS ACCESS:
//
//   - On the batched read client, a 403 answer is not an array, the RPC library
//     trips over it ("Cannot read properties of undefined"), files that under
//     "unknown error" and retries it four times with backoff: about 3.75 s on
//     EVERY read before the fallback is tried.
//   - The library also throws the HTTP status away when the 403 body is a
//     JSON-RPC error, so the caller sees "JSON is not a valid request object"
//     and nothing that says "your key was refused".
//
// Found 2026-11-16: the dedicated provider had been answering every call with
// 403 "ROBINHOOD_MAINNET is not enabled for this app" for weeks. Nothing said
// so. Every read on the desk paid the retry tax, /api/lp-scan timed out, and
// the basis logger, which had no fallback at all, wrote nothing but errors.
//
// The breaker makes that failure cheap and loud. It watches the HTTP status of
// every response on a leg (the transport's onFetchResponse hook, the only place
// the status survives). Once a leg rejects access (401, 402, 403) real reads
// skip it entirely; a single light probe re-tests it every cooldown, in the
// background, and reads return to it when the probe passes. It says so in the
// log when it opens and when it recovers. Throttles (429) and server errors are
// NOT access failures: those keep the library's own retry and failover.
import type { Transport } from "viem";

const ACCESS_STATUSES = new Set([401, 402, 403]);

export interface LegHealth {
  /** Hostname only. The full URL carries the provider key and never leaves the process. */
  host: string;
  role: string;
  state: "ok" | "skipped";
  /** Access rejections seen since the leg last answered. */
  failures: number;
  lastStatus: number | null;
  skippedSince: number | null;
  nextProbeAt: number | null;
}

export interface ProbeOutcome {
  ok: boolean;
  status: number | null;
}

/** PURE: true for the statuses that mean "you may not use this endpoint". */
export function isAccessStatus(status: number | null | undefined): boolean {
  return status != null && ACCESS_STATUSES.has(status);
}

/** PURE: the HTTP status carried by an RPC error or anything in its cause
 *  chain. Present only when the body was NOT a JSON-RPC error (an HTML block
 *  page, say); the response hook is the reliable source. */
export function httpStatusOf(err: unknown): number | null {
  let e = err as { status?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 8 && e && typeof e === "object"; depth++) {
    if (typeof e.status === "number") return e.status;
    e = e.cause as typeof e;
  }
  return null;
}

/** PURE: hostname of an RPC URL, for logs and health surfaces. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unparsed-url";
  }
}

/** PURE: an error rendered for a ledger row, a log line or an API body. RPC
 *  errors print the full request URL, and a dedicated provider's URL IS its
 *  key, so every URL is cut down to its origin before the text goes anywhere. */
export function redactRpcText(value: unknown, max = 300): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/https?:\/\/[^\s"'<>)\]]+/g, (u) => {
      try {
        const parsed = new URL(u);
        return `${parsed.protocol}//${parsed.hostname}/<redacted>`;
      } catch {
        return "<url>";
      }
    })
    .slice(0, max);
}

/** Thrown instead of a request when a leg is being skipped. It carries no
 *  numeric `code`, so the fallback transport moves on to the next endpoint. */
export class LegSkippedError extends Error {
  constructor(host: string) {
    super(`rpc endpoint ${host} is being skipped after it rejected access`);
    this.name = "LegSkippedError";
  }
}

export interface LegBreakerOptions {
  host: string;
  role: string;
  /** One cheap, retry-free request that says whether the endpoint serves us. */
  probe: () => Promise<ProbeOutcome>;
  cooldownMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class LegBreaker {
  readonly host: string;
  readonly role: string;
  private readonly probe: () => Promise<ProbeOutcome>;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private skippedSince: number | null = null;
  private nextProbeAt = 0;
  private probing: Promise<void> | null = null;
  private failures = 0;
  private lastStatus: number | null = null;

  constructor(opts: LegBreakerOptions) {
    this.host = opts.host;
    this.role = opts.role;
    this.probe = opts.probe;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** Called for every HTTP response on this leg. */
  observe(status: number): void {
    if (isAccessStatus(status)) this.reject(status);
  }

  /** Called with an error thrown by the leg, for the bodies that keep their status. */
  observeError(err: unknown): void {
    const status = httpStatusOf(err);
    if (status != null) this.observe(status);
  }

  /** Feed an outside probe result in (the boot probe uses this). */
  noteProbe(outcome: ProbeOutcome): void {
    if (outcome.ok) this.recover();
    else if (isAccessStatus(outcome.status)) this.reject(outcome.status as number);
  }

  /** "pass": use the endpoint. "skip": do not touch it. A skipped leg whose
   *  cooldown has run out starts ONE background probe; real traffic keeps
   *  skipping until that probe passes, so no read ever waits on a bad leg. */
  enter(): "pass" | "skip" {
    if (this.skippedSince == null) return "pass";
    if (this.now() >= this.nextProbeAt && !this.probing) this.probing = this.runProbe();
    return "skip";
  }

  /** The in-flight background probe, if any. For tests and orderly shutdown. */
  settled(): Promise<void> {
    return this.probing ?? Promise.resolve();
  }

  private async runProbe(): Promise<void> {
    this.nextProbeAt = this.now() + this.cooldownMs;
    try {
      const outcome = await this.probe();
      if (outcome.ok) this.recover();
      else if (isAccessStatus(outcome.status)) this.reject(outcome.status as number);
      // Any other failure (timeout, 5xx): it has not shown it will serve us,
      // so it stays skipped until the next probe.
    } catch {
      /* a probe that throws is a failed probe */
    } finally {
      this.probing = null;
    }
  }

  private reject(status: number): void {
    this.failures++;
    this.lastStatus = status;
    this.nextProbeAt = this.now() + this.cooldownMs;
    if (this.skippedSince == null) {
      this.skippedSince = this.now();
      this.log(
        `[rpc] ${this.role} endpoint ${this.host} REJECTED ACCESS (HTTP ${status}); skipping it and reading from the next endpoint, ` +
          `re-testing every ${Math.round(this.cooldownMs / 60_000)}m. Check the provider key and that this network is enabled for it.`,
      );
    }
  }

  private recover(): void {
    if (this.skippedSince != null) {
      const minutes = Math.round((this.now() - this.skippedSince) / 60_000);
      this.log(`[rpc] ${this.role} endpoint ${this.host} is answering again after ${minutes}m; reads are back on it`);
    }
    this.skippedSince = null;
    this.nextProbeAt = 0;
    this.failures = 0;
    this.lastStatus = null;
  }

  health(): LegHealth {
    return {
      host: this.host,
      role: this.role,
      state: this.skippedSince == null ? "ok" : "skipped",
      failures: this.failures,
      lastStatus: this.lastStatus,
      skippedSince: this.skippedSince,
      nextProbeAt: this.skippedSince == null ? null : this.nextProbeAt,
    };
  }
}

/** Wrap one transport leg so its breaker decides whether a request is sent.
 *  The leg must ALSO report its HTTP statuses to the breaker: build it with
 *  `onFetchResponse: (res) => breaker.observe(res.status)`. */
export function guardLeg(inner: Transport, breaker: LegBreaker): Transport {
  return ((args: Parameters<Transport>[0]) => {
    const leg = inner(args);
    const request = (async (req: unknown, opts: unknown) => {
      if (breaker.enter() === "skip") throw new LegSkippedError(breaker.host);
      try {
        return await (leg.request as (r: unknown, o: unknown) => Promise<unknown>)(req, opts);
      } catch (err) {
        breaker.observeError(err);
        throw err;
      }
    }) as typeof leg.request;
    return { ...leg, request };
  }) as Transport;
}
