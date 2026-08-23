import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store resolves its data dir at import time, so the override must be in
// place BEFORE the dynamic import below. A fresh temp dir keeps this off the
// real ledgers.
const dir = mkdtempSync(join(tmpdir(), "meridian-proposals-test-"));
process.env.MERIDIAN_DATA_DIR = dir;

const {
  validateProposalInput,
  canPropose,
  submitProposal,
  listProposals,
  decideProposal,
  markExecuted,
  markFailed,
  DEFAULT_WIDTH_PCT,
  MAX_PENDING_PER_PROPOSER,
  PROPOSAL_TTL_MS,
} = await import("../src/agentProposals.js");

const tradable = (s: string) => ["PONS", "CASHCAT", "NVDA"].includes(s);
const RATIONALE = "measured fee flow beats markout over the trailing window in this venue";

test("lp-open validation enforces the size and width bounds", () => {
  assert.equal(validateProposalInput({ kind: "lp-open", symbol: "PONS", maxUsd: 10, rationale: RATIONALE }).ok, false);
  assert.equal(validateProposalInput({ kind: "lp-open", symbol: "PONS", maxUsd: 900, rationale: RATIONALE }).ok, false);
  assert.equal(validateProposalInput({ kind: "lp-open", symbol: "PONS", maxUsd: 150, widthPct: 2, rationale: RATIONALE }).ok, false);
  const ok = validateProposalInput({ kind: "lp-open", symbol: "pons", maxUsd: 150, widthPct: 20, rationale: RATIONALE });
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.params.symbol, "PONS");
});

test("an omitted width is resolved to the proven default AT SUBMIT, not at execution", () => {
  const v = validateProposalInput({ kind: "lp-open", symbol: "PONS", maxUsd: 150, rationale: RATIONALE });
  assert.ok(v.ok);
  assert.equal(v.ok && v.params.widthPct, DEFAULT_WIDTH_PCT);
});

test("a thin rationale is refused: the argument IS the product", () => {
  const v = validateProposalInput({ kind: "lp-open", symbol: "PONS", maxUsd: 150, rationale: "trust me" });
  assert.equal(v.ok, false);
});

test("unknown kinds are refused", () => {
  assert.equal(validateProposalInput({ kind: "recenter", symbol: "PONS", rationale: RATIONALE }).ok, false);
});

test("rate limit: pending cap per proposer", () => {
  const now = 1_000_000;
  const mk = (i: number, status = "pending") =>
    ({ id: `p${i}`, proposerId: "a", proposerName: "A", kind: "lp-open", params: { symbol: "PONS" }, rationale: RATIONALE, at: now - i, status }) as never;
  const pendingFull = Array.from({ length: MAX_PENDING_PER_PROPOSER }, (_, i) => mk(i));
  assert.equal(canPropose(pendingFull, "a", now).ok, false);
  assert.equal(canPropose(pendingFull, "b", now).ok, true);
  const decided = Array.from({ length: MAX_PENDING_PER_PROPOSER }, (_, i) => mk(i, "rejected"));
  assert.equal(canPropose(decided, "a", now).ok, true);
});

test("full lifecycle: submit, approve, execute; wallet ids never stored", () => {
  const r = submitProposal({
    proposerId: "agent-abc123def456",
    proposerName: "Test Desk",
    kind: "lp-open",
    symbol: "PONS",
    maxUsd: 150,
    rationale: RATIONALE,
    tradable,
  });
  assert.ok(r.ok);
  const id = r.ok ? r.proposal.id : "";
  assert.ok(!JSON.stringify(listProposals()).match(/0x[0-9a-fA-F]{40}/), "no wallet-shaped string may appear in the store");

  const approved = decideProposal(id, "approved");
  assert.equal(approved?.status, "approved");
  markExecuted(id, { tokenId: "1" });
  assert.equal(listProposals().find((p) => p.id === id)?.status, "executed");
});

test("a decided proposal cannot be re-decided", () => {
  const r = submitProposal({
    proposerId: "agent-2",
    proposerName: "Other Desk",
    kind: "lp-close",
    symbol: "CASHCAT",
    rationale: RATIONALE,
    tradable,
  });
  assert.ok(r.ok);
  const id = r.ok ? r.proposal.id : "";
  assert.equal(decideProposal(id, "rejected", "not today")?.status, "rejected");
  assert.equal(decideProposal(id, "approved"), null);
});

test("failed execution is recorded honestly", () => {
  const r = submitProposal({
    proposerId: "agent-3",
    proposerName: "Third Desk",
    kind: "lp-open",
    symbol: "NVDA",
    maxUsd: 100,
    rationale: RATIONALE,
    tradable,
  });
  assert.ok(r.ok);
  const id = r.ok ? r.proposal.id : "";
  decideProposal(id, "approved");
  markFailed(id, "breaker halt");
  const p = listProposals().find((x) => x.id === id);
  assert.equal(p?.status, "failed");
  assert.equal(p?.error, "breaker halt");
});

test("untradable symbols are refused at submit", () => {
  const r = submitProposal({
    proposerId: "agent-4",
    proposerName: "Fourth",
    kind: "lp-open",
    symbol: "SCAM",
    maxUsd: 100,
    rationale: RATIONALE,
    tradable,
  });
  assert.equal(r.ok, false);
});

test("pending proposals expire after the TTL", () => {
  const old = Date.now() - PROPOSAL_TTL_MS - 60_000;
  const r = submitProposal({
    proposerId: "agent-5",
    proposerName: "Fifth",
    kind: "lp-open",
    symbol: "PONS",
    maxUsd: 100,
    rationale: RATIONALE,
    tradable,
    now: old,
  });
  assert.ok(r.ok);
  const id = r.ok ? r.proposal.id : "";
  assert.equal(listProposals().find((p) => p.id === id)?.status, "expired");
});
