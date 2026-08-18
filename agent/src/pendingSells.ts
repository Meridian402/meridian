// SOLD MEANS SOLD. On 2026-08-18 a floor exit's token sale failed once,
// logged once, and gave up; 6,329 PONS sat loose in the wallet, unhedged,
// through the whole chain-wide dump. The same day lp-close's index-only
// sweep left 1,756 CASHCAT stranded the same way. A failed liquidation is
// not an event to note, it is a position that still exists: this queue holds
// every unfinished sale on disk and retries it, with backoff, until the
// inventory is actually cash. It survives redeploys because the inventory
// survives redeploys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { appendLedger } from "./ledger.js";
import { realSellStockForUsdg } from "./venues/stockPools.js";

const QUEUE_PATH = dataPath("pending-sells.json");
const BASE_RETRY_MS = 3 * 60e3;
const MAX_RETRY_MS = 60 * 60e3;

export interface PendingSell {
  symbol: string;
  reason: string;
  enqueuedTs: number;
  attempts: number;
  /** Earliest time of the next attempt (backoff). */
  notBefore: number;
  lastError?: string;
}

/** PURE: retry delay after this many failed attempts. Doubles from 3 minutes,
 *  capped at an hour: persistent enough to catch a venue coming back, slow
 *  enough that a structurally broken sale is not a gas faucet. */
export function nextRetryDelayMs(attempts: number, baseMs = BASE_RETRY_MS, capMs = MAX_RETRY_MS): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempts, 10)));
}

function loadQueue(): PendingSell[] {
  try {
    if (!existsSync(QUEUE_PATH)) return [];
    const q = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function saveQueue(q: PendingSell[]): void {
  writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2));
}

export function pendingSellsNow(): PendingSell[] {
  return loadQueue();
}

/** Put a symbol on the sell-until-done queue. Deduped by symbol: the sale is
 *  always the FULL wallet balance, so one entry covers every strand of it. */
export function enqueuePendingSell(symbol: string, reason: string): void {
  const sym = symbol.toUpperCase();
  const q = loadQueue();
  if (q.some((e) => e.symbol === sym)) return;
  q.push({ symbol: sym, reason, enqueuedTs: Date.now(), attempts: 0, notBefore: 0 });
  saveQueue(q);
  appendLedger("pending-sells.jsonl", { ts: Date.now(), kind: "enqueue", symbol: sym, reason });
  console.error(`[pendingSells] ${sym} queued for liquidation (${reason}); retrying until it is cash`);
}

/** One pass over the queue: sell what is due, back off what fails, drop what
 *  no longer exists. Callers hold the house-wallet lock (it moves money). */
export async function retryPendingSells(): Promise<void> {
  const q = loadQueue();
  if (q.length === 0) return;
  const now = Date.now();
  const keep: PendingSell[] = [];
  let changed = false;
  for (const e of q) {
    if (now < e.notBefore) {
      keep.push(e);
      continue;
    }
    try {
      const r = await realSellStockForUsdg({ fromSymbol: e.symbol });
      changed = true;
      appendLedger("pending-sells.jsonl", { ts: Date.now(), kind: "sold", symbol: e.symbol, usdgReceived: r.usdgReceived, tokensSold: r.tokensSold, txHash: r.hash, attempts: e.attempts });
      console.error(`[pendingSells] ${e.symbol} sold for $${r.usdgReceived.toFixed(2)} USDG after ${e.attempts} failed attempt(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/wallet holds no/i.test(msg)) {
        // Nothing left to sell: some other path already cashed it. Done.
        changed = true;
        appendLedger("pending-sells.jsonl", { ts: Date.now(), kind: "cleared", symbol: e.symbol, note: msg.slice(0, 120) });
        continue;
      }
      e.attempts += 1;
      e.notBefore = now + nextRetryDelayMs(e.attempts);
      e.lastError = msg.slice(0, 160);
      keep.push(e);
      changed = true;
      const nextMin = Math.round(nextRetryDelayMs(e.attempts) / 60e3);
      console.error(`[pendingSells] ${e.symbol} sale attempt ${e.attempts} failed (${msg.slice(0, 120)}); next try in ~${nextMin}m`);
      if (e.attempts % 10 === 0) {
        console.error(`[pendingSells] CRITICAL: ${e.symbol} has failed to sell ${e.attempts} times since ${new Date(e.enqueuedTs).toISOString()}; inventory is sitting unhedged`);
      }
    }
  }
  if (changed) saveQueue(keep);
}

/** Sell each symbol's full wallet balance to USDG now; anything that fails
 *  goes on the queue instead of being forgotten. "Holds none" is success. */
export async function sellSymbolsOrEnqueue(
  symbols: readonly string[],
  reason: string,
): Promise<Array<{ symbol: string; usdgReceived: number; txHash: string }>> {
  const sold: Array<{ symbol: string; usdgReceived: number; txHash: string }> = [];
  for (const symbol of symbols) {
    try {
      const r = await realSellStockForUsdg({ fromSymbol: symbol });
      sold.push({ symbol, usdgReceived: r.usdgReceived, txHash: r.hash });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/wallet holds no/i.test(msg)) continue;
      enqueuePendingSell(symbol, `${reason}: ${msg.slice(0, 80)}`);
    }
  }
  return sold;
}
