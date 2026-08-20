import { config } from "./config.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { appendLedger } from "./ledger.js";

// Durable, rolling-24h ledger of every house-wallet money movement — trades AND
// LP mints/swaps. Replaces the old in-memory `dailySpentUsd`, which only reset
// on process restart, so the "daily" cap was really "spend since last boot":
// long uptime falsely blocked, frequent redeploys never enforced. Now it's a
// true rolling 24h window that survives restarts and covers the LP path too,
// not just the (currently-off) directional trades.
const LEDGER = dataPath("wallet-ledger.jsonl");
const DAY_MS = 24 * 60 * 60 * 1000;

// Global runaway circuit breaker across ALL house-wallet ops. Generous on
// purpose: it exists to halt a BUG looping mints/swaps, not to budget normal
// activity (a busy real day is far under these). Tripping means "stop moving
// money, a human should look." Env-tunable.
const MAX_DAILY_WALLET_OPS = Number(process.env.MERIDIAN_MAX_DAILY_WALLET_OPS ?? 150);
const MAX_DAILY_NOTIONAL_USD = Number(process.env.MERIDIAN_MAX_DAILY_NOTIONAL_USD ?? 25000);

interface LedgerRow {
  at: number;
  usd: number;
  kind: string;
}

function readWindow(): LedgerRow[] {
  try {
    if (!existsSync(LEDGER)) return [];
    const cutoff = Date.now() - DAY_MS;
    const rows: LedgerRow[] = [];
    for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.at === "number" && r.at >= cutoff) rows.push(r);
      } catch {}
    }
    return rows;
  } catch {
    return []; // fail-open: never block money management on a disk read error
  }
}

let _appendsSinceCompact = 0;
function append(usd: number, kind: string): void {
  try {
    appendLedger("wallet-ledger.jsonl", { at: Date.now(), usd: Math.max(0, Number(usd) || 0), kind });
    // Opportunistic compaction keeps this rolling-window file bounded, so reads
    // stay O(recent) instead of O(all-time) as the agent runs for months. Single
    // process + synchronous fs, so no append can interleave with the rewrite.
    if (++_appendsSinceCompact >= 100) {
      _appendsSinceCompact = 0;
      compact();
    }
  } catch {}
}

function compact(): void {
  try {
    if (!existsSync(LEDGER)) return;
    const cutoff = Date.now() - 2 * DAY_MS; // keep a 48h buffer beyond the 24h window
    const kept = readFileSync(LEDGER, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const r = JSON.parse(line);
          return typeof r.at === "number" && r.at >= cutoff;
        } catch {
          return false;
        }
      });
    writeFileSync(LEDGER, kept.length ? kept.join("\n") + "\n" : "");
  } catch {}
}

/**
 * Per-trade clamp + rolling-daily spend guard for the directional trade paths
 * (executeIndexTrade / executeIndexYieldTrade / MCP momentum). Same interface as
 * before — the daily budget is now a durable rolling-24h window instead of an
 * in-memory counter that reset on restart.
 */
export class RiskLimiter {
  size(requestedUsd: number): number {
    const wanted = requestedUsd > 0 ? requestedUsd : config.maxTradeUsd;
    return Math.min(wanted, config.maxTradeUsd);
  }

  check(amountUsd: number): { ok: boolean; reason?: string } {
    const spent = this.spentTodayUsd;
    if (spent + amountUsd > config.maxDailyUsd) {
      return { ok: false, reason: `daily trade limit reached ($${spent.toFixed(0)}/$${config.maxDailyUsd} in the last 24h)` };
    }
    return { ok: true };
  }

  record(amountUsd: number): void {
    append(amountUsd, "trade");
  }

  get spentTodayUsd(): number {
    return readWindow()
      .filter((r) => r.kind === "trade")
      .reduce((s, r) => s + r.usd, 0);
  }
}

/**
 * Global runaway breaker over ALL house-wallet money movement (LP mints/swaps +
 * trades). Call BEFORE a deploying op. Throws if the rolling-24h op-count or
 * notional would exceed the cap — the ceiling the LP path never had. Deliberately
 * does NOT guard withdrawals/collects: getting OUT is always allowed. Fail-open
 * on read errors (a disk hiccup must never freeze position management).
 */
export function guardWalletOp(label: string): void {
  const rows = readWindow();
  if (rows.length >= MAX_DAILY_WALLET_OPS) {
    throw new Error(
      `house-wallet circuit breaker OPEN: ${rows.length} ops in 24h >= ${MAX_DAILY_WALLET_OPS} (${label}) — halting money movement for manual review`,
    );
  }
  const notional = rows.reduce((s, r) => s + r.usd, 0);
  if (notional >= MAX_DAILY_NOTIONAL_USD) {
    throw new Error(
      `house-wallet circuit breaker OPEN: $${notional.toFixed(0)} notional in 24h >= $${MAX_DAILY_NOTIONAL_USD} (${label}) — halting for manual review`,
    );
  }
}

/** Record a completed LP-side money op into the shared rolling-24h ledger. */
export function recordWalletOp(usd: number, kind = "lp"): void {
  append(usd, kind);
}

/** NEVER START WHAT YOU CANNOT FINISH (2026-08-20). The breaker caught the
 *  stock guard mid-operation that evening: withdraw done, re-mint refused,
 *  the worst possible stopping point. A multi-step operation checks its
 *  WHOLE op budget here before the first leg; if the sequence cannot fit
 *  under the cap, none of it starts. Fail-open on read errors, same as the
 *  breaker itself. */
export function walletOpsAvailable(n: number): boolean {
  try {
    return readWindow().length + n <= MAX_DAILY_WALLET_OPS;
  } catch {
    return true;
  }
}

/** Live view for /api/ops and the console. */
export function walletOps24h(): { count: number; notionalUsd: number; maxOps: number; maxNotionalUsd: number } {
  const rows = readWindow();
  return {
    count: rows.length,
    notionalUsd: Math.round(rows.reduce((s, r) => s + r.usd, 0)),
    maxOps: MAX_DAILY_WALLET_OPS,
    maxNotionalUsd: MAX_DAILY_NOTIONAL_USD,
  };
}
