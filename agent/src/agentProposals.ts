// Agent proposals: the door through which OTHER agents work on the LP engine.
//
// The contract, in one line: agents argue, the operator decides, the desk
// executes through its own guards. A proposal is a written argument for one
// bounded LP action (open a seat, close a seat). It carries no authority.
// Approval is the operator's bearer token, and execution lands on the exact
// same code paths as the operator's own lp-open/lp-close, house lock and all.
//
// Identity here is CLAIMED, not proven: an MCP caller names itself, a signed
// in user's agent gets a publicIdForWallet hash. Spoofing a name buys nothing,
// because a proposal's only power is to sit in front of the operator and be
// judged (the pendingLaunches precedent: naming someone else only puts a
// proposal in front of a person who declines it). Wallet addresses never
// enter this store.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { appendLedger } from "./ledger.js";

export type ProposalKind = "lp-open" | "lp-close";
export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface ProposalParams {
  symbol: string;
  /** TOTAL band width percent (20 = ±10%, the width the pilot proved). */
  widthPct?: number;
  maxUsd?: number;
  toCash?: boolean;
}

export interface Proposal {
  id: string;
  proposerId: string;
  proposerName: string;
  kind: ProposalKind;
  params: ProposalParams;
  rationale: string;
  at: number;
  status: ProposalStatus;
  decidedAt?: number;
  decisionReason?: string;
  executedAt?: number;
  result?: unknown;
  error?: string;
}

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_PROPOSER = 2;
export const MAX_PER_DAY_PER_PROPOSER = 10;
export const MAX_OPEN_USD = 500;
export const MIN_OPEN_USD = 25;
export const MIN_WIDTH_PCT = 4;
export const MAX_WIDTH_PCT = 40;
/** The width the pilot proved (±10%); a proposal that omits width gets this
 *  WRITTEN INTO its stored params, so what the operator approves is exactly
 *  what executes. Defaults resolved at execution time burned us twice. */
export const DEFAULT_WIDTH_PCT = 20;
const KEEP_DECIDED = 200;

/** Pure input validation, exported for tests. Bounds are deliberately tighter
 *  than the operator's own: a stranger's argument earns a bounded trial, not
 *  the operator's full sizing latitude. */
export function validateProposalInput(input: {
  kind: string;
  symbol: string;
  widthPct?: number;
  maxUsd?: number;
  rationale: string;
}): { ok: true; params: ProposalParams } | { ok: false; error: string } {
  const symbol = String(input.symbol ?? "").toUpperCase().trim();
  if (!symbol || !/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, error: "symbol must be 1-12 alphanumeric characters" };
  const rationale = String(input.rationale ?? "").trim();
  if (rationale.length < 20) return { ok: false, error: "rationale must argue the case in at least 20 characters" };
  if (rationale.length > 600) return { ok: false, error: "rationale must fit in 600 characters" };
  if (input.kind === "lp-open") {
    const maxUsd = Number(input.maxUsd);
    if (!Number.isFinite(maxUsd) || maxUsd < MIN_OPEN_USD || maxUsd > MAX_OPEN_USD)
      return { ok: false, error: `maxUsd must be ${MIN_OPEN_USD}..${MAX_OPEN_USD}` };
    const widthPct = input.widthPct == null ? DEFAULT_WIDTH_PCT : Number(input.widthPct);
    if (!Number.isFinite(widthPct) || widthPct < MIN_WIDTH_PCT || widthPct > MAX_WIDTH_PCT)
      return { ok: false, error: `widthPct is TOTAL band width and must be ${MIN_WIDTH_PCT}..${MAX_WIDTH_PCT} (20 = ±10%)` };
    return { ok: true, params: { symbol, widthPct, maxUsd: Math.round(maxUsd) } };
  }
  if (input.kind === "lp-close") {
    return { ok: true, params: { symbol, toCash: true } };
  }
  return { ok: false, error: "kind must be lp-open or lp-close" };
}

/** Pure rate limiting, exported for tests. */
export function canPropose(all: readonly Proposal[], proposerId: string, now: number): { ok: true } | { ok: false; error: string } {
  const mine = all.filter((p) => p.proposerId === proposerId);
  if (mine.filter((p) => p.status === "pending").length >= MAX_PENDING_PER_PROPOSER)
    return { ok: false, error: `you already have ${MAX_PENDING_PER_PROPOSER} pending proposals; the operator decides at their own pace` };
  if (mine.filter((p) => now - p.at < 24 * 60 * 60 * 1000).length >= MAX_PER_DAY_PER_PROPOSER)
    return { ok: false, error: `daily proposal limit reached (${MAX_PER_DAY_PER_PROPOSER})` };
  return { ok: true };
}

interface Store {
  proposals: Proposal[];
}

const STATE_PATH = dataPath("agent-proposals.json");
let store: Store = { proposals: [] };
let loaded = false;

function ensureStore(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(STATE_PATH)) {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Store;
      if (Array.isArray(raw.proposals)) store = { proposals: raw.proposals };
    }
  } catch {
    // Unreadable state re-seeds empty; the jsonl ledger keeps the full history.
  }
}

function saveStore(): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error(`[proposals] save failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
}

/** Pending past the TTL expire; decided history is capped. Runs on every read
 *  so the sweep needs no timer. */
function sweep(now: number): void {
  let changed = false;
  for (const p of store.proposals) {
    if (p.status === "pending" && now - p.at > PROPOSAL_TTL_MS) {
      p.status = "expired";
      p.decidedAt = now;
      changed = true;
      appendLedger("agent-proposals.jsonl", { at: now, event: "expired", id: p.id });
    }
  }
  const decided = store.proposals.filter((p) => p.status !== "pending");
  if (decided.length > KEEP_DECIDED) {
    const cut = new Set(decided.slice(0, decided.length - KEEP_DECIDED).map((p) => p.id));
    store.proposals = store.proposals.filter((p) => !cut.has(p.id));
    changed = true;
  }
  if (changed) saveStore();
}

/** The rehearsal path: everything submitProposal checks, nothing it stores.
 *  A first integration should not have to perform in public to find out
 *  whether its request parses; dryRun answers with the exact params that
 *  WOULD be published, or the exact refusal. */
export function previewProposal(input: {
  proposerId: string;
  kind: string;
  symbol: string;
  widthPct?: number;
  maxUsd?: number;
  rationale: string;
  tradable: (symbol: string) => boolean;
  now?: number;
}): { ok: true; wouldPublish: { kind: string; params: ProposalParams; rationale: string } } | { ok: false; error: string } {
  ensureStore();
  const now = input.now ?? Date.now();
  const v = validateProposalInput(input);
  if (!v.ok) return v;
  if (!input.tradable(v.params.symbol)) return { ok: false, error: `${v.params.symbol} is not a tradable pool here` };
  const gate = canPropose(store.proposals, input.proposerId, now);
  if (!gate.ok) return gate;
  return { ok: true, wouldPublish: { kind: input.kind, params: v.params, rationale: String(input.rationale).trim() } };
}

export function submitProposal(input: {
  proposerId: string;
  proposerName: string;
  kind: string;
  symbol: string;
  widthPct?: number;
  maxUsd?: number;
  rationale: string;
  tradable: (symbol: string) => boolean;
  now?: number;
}): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  ensureStore();
  const now = input.now ?? Date.now();
  sweep(now);
  const v = validateProposalInput(input);
  if (!v.ok) return v;
  if (!input.tradable(v.params.symbol)) return { ok: false, error: `${v.params.symbol} is not a tradable pool here` };
  const gate = canPropose(store.proposals, input.proposerId, now);
  if (!gate.ok) return gate;
  const proposal: Proposal = {
    id: `pr-${now.toString(36)}-${Math.abs(hash32(input.proposerId + input.rationale + now)).toString(36)}`,
    proposerId: input.proposerId,
    proposerName: String(input.proposerName ?? "").trim().slice(0, 40) || "unnamed agent",
    kind: input.kind as ProposalKind,
    params: v.params,
    rationale: String(input.rationale).trim(),
    at: now,
    status: "pending",
  };
  store.proposals.push(proposal);
  saveStore();
  appendLedger("agent-proposals.jsonl", { event: "submitted", ...proposal });
  return { ok: true, proposal };
}

export function listProposals(limit = 50): Proposal[] {
  ensureStore();
  sweep(Date.now());
  return [...store.proposals].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function getProposal(id: string): Proposal | null {
  ensureStore();
  sweep(Date.now());
  return store.proposals.find((p) => p.id === id) ?? null;
}

/** Operator verdict. Execution is the caller's job (it owns the house lock);
 *  markExecuted/markFailed record what actually happened. */
export function decideProposal(id: string, verdict: "approved" | "rejected", reason?: string): Proposal | null {
  ensureStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p || p.status !== "pending") return null;
  p.status = verdict;
  p.decidedAt = Date.now();
  if (reason) p.decisionReason = String(reason).slice(0, 300);
  saveStore();
  appendLedger("agent-proposals.jsonl", { at: p.decidedAt, event: verdict, id: p.id, reason: p.decisionReason });
  return p;
}

export function markExecuted(id: string, result: unknown): void {
  ensureStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return;
  p.status = "executed";
  p.executedAt = Date.now();
  p.result = result;
  saveStore();
  appendLedger("agent-proposals.jsonl", { at: p.executedAt, event: "executed", id: p.id });
}

export function markFailed(id: string, error: string): void {
  ensureStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return;
  p.status = "failed";
  p.executedAt = Date.now();
  p.error = String(error).slice(0, 300);
  saveStore();
  appendLedger("agent-proposals.jsonl", { at: p.executedAt, event: "failed", id: p.id, error: p.error });
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
