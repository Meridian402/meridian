import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module under test resolves its data dir at import time, so the override
// must be in place BEFORE the dynamic import below. A fresh temp dir per run
// keeps these tests off the real ledgers.
const dir = mkdtempSync(join(tmpdir(), "meridian-credits-test-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_CREDITS = "on";
delete process.env.CREDITS_FREE_MESSAGES;

const { creditsFromEvents, balanceOf, trySpend, refundCredit, addPurchase, FREE_CREDITS, PACKS, creditsEnforced } = await import(
  "../src/credits.js"
);
type CreditEvent = import("../src/credits.js").CreditEvent;

const ledgerRows = (): CreditEvent[] => {
  const path = join(dir, "credits.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CreditEvent);
};
const rowsFor = (wallet: string) => ledgerRows().filter((r) => r.wallet === wallet.toLowerCase());

const ev = (kind: CreditEvent["kind"], credits: number): CreditEvent => ({ wallet: "0xw", kind, credits, at: 0 });

test("fold: grants and purchases add, spends subtract", () => {
  assert.equal(creditsFromEvents([]), 0);
  assert.equal(creditsFromEvents([ev("grant", 20)]), 20);
  assert.equal(creditsFromEvents([ev("grant", 20), ev("spend", 5), ev("purchase", 500)]), 515);
  assert.equal(creditsFromEvents([ev("grant", 3), ev("spend", 1), ev("spend", 1), ev("spend", 1)]), 0);
});

test("fold: clamps at zero, and later credits count in full", () => {
  assert.equal(creditsFromEvents([ev("spend", 10)]), 0);
  assert.equal(creditsFromEvents([ev("grant", 5), ev("spend", 10), ev("grant", 3)]), 3);
});

test("fold: ignores malformed amounts (zero, negative, non-finite)", () => {
  assert.equal(creditsFromEvents([ev("grant", 0), ev("grant", -5), ev("grant", NaN), ev("grant", 7)]), 7);
});

test("signup grant: first touch grants FREE_CREDITS, exactly one grant row", () => {
  const w = "0x00000000000000000000000000000000000000a1";
  assert.equal(balanceOf(w), FREE_CREDITS);
  assert.equal(balanceOf(w), FREE_CREDITS); // second read does not grant again
  const grants = rowsFor(w).filter((r) => r.kind === "grant" && r.reason === "signup");
  assert.equal(grants.length, 1);
});

test("signup grant never repeats: spend to 0, balance stays 0", () => {
  const w = "0x00000000000000000000000000000000000000a2";
  assert.equal(balanceOf(w), FREE_CREDITS);
  const spent = trySpend(w, FREE_CREDITS);
  assert.equal(spent.ok, true);
  assert.equal(spent.balance, 0);
  // The critical property: a wallet with history at balance 0 gets NO new grant.
  assert.equal(balanceOf(w), 0);
  const grants = rowsFor(w).filter((r) => r.kind === "grant");
  assert.equal(grants.length, 1);
});

test("trySpend: succeeds down to exactly 0, then fails at 0", () => {
  const w = "0x00000000000000000000000000000000000000a3";
  assert.equal(balanceOf(w), FREE_CREDITS);
  for (let i = FREE_CREDITS - 1; i >= 0; i--) {
    const r = trySpend(w);
    assert.deepEqual(r, { ok: true, balance: i });
  }
  const broke = trySpend(w);
  assert.deepEqual(broke, { ok: false, balance: 0 });
  // The failed attempt must not have written a spend row.
  assert.equal(rowsFor(w).filter((r) => r.kind === "spend").length, FREE_CREDITS);
});

test("refund restores a spent credit", () => {
  const w = "0x00000000000000000000000000000000000000a4";
  balanceOf(w);
  trySpend(w, FREE_CREDITS);
  assert.equal(refundCredit(w, 1, "refund:error"), 1);
  assert.deepEqual(trySpend(w), { ok: true, balance: 0 });
  const refunds = rowsFor(w).filter((r) => r.kind === "grant" && r.reason === "refund:error");
  assert.equal(refunds.length, 1);
});

test("purchase adds a pack's credits on top of the balance", () => {
  const w = "0x00000000000000000000000000000000000000a5";
  balanceOf(w);
  const pack = PACKS[0];
  assert.equal(addPurchase(w, pack.id, pack.credits, "0xabc123"), FREE_CREDITS + pack.credits);
  assert.equal(balanceOf(w), FREE_CREDITS + pack.credits);
  const rows = rowsFor(w).filter((r) => r.kind === "purchase");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tx, "0xabc123");
  assert.equal(rows[0].reason, `pack:${pack.id}`);
});

test("enforcement off: trySpend always ok, no spend rows, refund writes nothing", () => {
  const w = "0x00000000000000000000000000000000000000a6";
  process.env.MERIDIAN_CREDITS = "off";
  try {
    assert.equal(creditsEnforced(), false);
    assert.deepEqual(trySpend(w), { ok: true, balance: FREE_CREDITS });
    assert.deepEqual(trySpend(w, 1_000_000), { ok: true, balance: FREE_CREDITS });
    assert.equal(rowsFor(w).filter((r) => r.kind === "spend").length, 0);
    // With no spend to undo, a refund must not mint credits out of errors.
    assert.equal(refundCredit(w, 1, "refund:error"), FREE_CREDITS);
    assert.equal(rowsFor(w).length, 1); // just the signup grant
  } finally {
    process.env.MERIDIAN_CREDITS = "on";
  }
  assert.equal(creditsEnforced(), true);
});

test("mixed-case addresses hit the same account", () => {
  const lower = "0x00000000000000000000000000000000000000ab";
  const mixed = "0x00000000000000000000000000000000000000AB";
  assert.equal(balanceOf(mixed), FREE_CREDITS);
  assert.deepEqual(trySpend(lower), { ok: true, balance: FREE_CREDITS - 1 });
  assert.equal(balanceOf(mixed), FREE_CREDITS - 1);
  // One account in the ledger, every row keyed by the lowercase form.
  assert.equal(rowsFor(lower).filter((r) => r.kind === "grant").length, 1);
  assert.ok(ledgerRows().every((r) => r.wallet === r.wallet.toLowerCase()));
});
