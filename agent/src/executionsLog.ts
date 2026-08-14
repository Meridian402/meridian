// Durable record of every attempted execution — the ledger the 2026-07-13
// churn incident showed we were missing: two live rotations scrolled out of
// the in-memory decision ring and were only rediscovered on the block
// explorer hours later. Every fill (or failure) appends here forever, and
// the strategy's cooldown guard reads its ground truth from this file, not
// from process memory that a restart wipes.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";

const LOG_PATH = dataPath("executions.jsonl");

export interface ExecutionRecord {
  ts: number;
  kind: "rotation" | "entry" | "yield-enter" | "yield-exit" | "liquidation" | "lp-mint" | "lp-exit" | "lp-collect" | "treasury-skim";
  fromSymbol?: string;
  toSymbol?: string;
  amountUsd: number;
  success: boolean;
  txHash?: string;
  error?: string;
}

export function recordExecution(r: ExecutionRecord): void {
  appendLedger("executions.jsonl", r);
}

/** Most recent executions, newest first. */
export function readRecentExecutions(limit = 10): ExecutionRecord[] {
  if (!existsSync(LOG_PATH)) return [];
  const rows: ExecutionRecord[] = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ExecutionRecord);
    } catch {}
  }
  return rows.slice(-limit).reverse();
}

/** Every execution ever recorded, oldest first. */
export function readAllExecutions(): ExecutionRecord[] {
  if (!existsSync(LOG_PATH)) return [];
  const rows: ExecutionRecord[] = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ExecutionRecord);
    } catch {}
  }
  return rows;
}

/** Timestamp of the most recent SUCCESSFUL trade, or null. Reads the file so restarts can't forget. */
export function lastSuccessfulTradeTs(): number | null {
  if (!existsSync(LOG_PATH)) return null;
  let last: number | null = null;
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ExecutionRecord;
      if (r.success) last = r.ts;
    } catch {}
  }
  return last;
}
