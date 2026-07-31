import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The unit tests cover the fold, the grant and a single spend. This walks the
// WHOLE journey with charging switched ON, because that is the state nobody has
// ever actually run: production has MERIDIAN_CREDITS=off, so the debit path has
// never executed against a real wallet. "Does the credit system work" is a
// question about the sequence, not about any one function.
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-credit-journey-"));
process.env.MERIDIAN_CREDITS = "on";
process.env.CREDITS_FREE_MESSAGES = "50";
process.env.MERIDIAN_LIVE_PRICES = "0";

const { balanceOf, trySpend, refundCredit, addPurchase, PACKS, FREE_CREDITS, creditsEnforced } =
  await import("../src/credits.js");

const WALLET = "0x00000000000000000000000000000000000000f1";

test("charging is actually on for this file, or nothing below is meaningful", () => {
  assert.equal(creditsEnforced(), true);
  assert.equal(FREE_CREDITS, 50);
});

test("a new wallet starts on the free grant without buying anything", () => {
  assert.equal(balanceOf(WALLET), 50);
});

test("each message takes exactly one credit, all the way down to zero", () => {
  for (let i = 0; i < 50; i++) {
    const r = trySpend(WALLET);
    assert.equal(r.ok, true, `message ${i + 1} of the free grant should be allowed`);
    assert.equal(r.balance, 49 - i, "the balance reported back must be the balance after the debit");
  }
  assert.equal(balanceOf(WALLET), 0);
});

test("at zero the next message is refused, and refusing costs nothing", () => {
  const r = trySpend(WALLET);
  assert.equal(r.ok, false, "a wallet at zero must not be able to send");
  assert.equal(r.balance, 0);
  // A refusal must not itself move the balance, or a locked-out user would go
  // negative by retrying.
  assert.equal(balanceOf(WALLET), 0);
  for (let i = 0; i < 5; i++) trySpend(WALLET);
  assert.equal(balanceOf(WALLET), 0, "repeated refusals must stay at zero");
});

test("buying the entry pack unlocks exactly what the pricing page advertises", () => {
  const starter = PACKS.find((p) => p.id === "starter")!;
  const after = addPurchase(WALLET, starter.id, starter.credits, "0x" + "ab".repeat(32));
  assert.equal(after, starter.credits);
  assert.equal(balanceOf(WALLET), 200, "the $5 pack is 200 credits at the current price");
  // And spending resumes normally.
  assert.equal(trySpend(WALLET).ok, true);
  assert.equal(balanceOf(WALLET), 199);
});

test("a failed turn is refunded, so nobody pays for our error", () => {
  const before = balanceOf(WALLET);
  const spent = trySpend(WALLET);
  assert.equal(spent.balance, before - 1);
  refundCredit(WALLET, 1, "refund:agent-error");
  assert.equal(balanceOf(WALLET), before, "a refund must restore the wallet exactly");
});

test("the free grant is given once, never again", () => {
  // Someone who spends to zero must not be re-granted on the next read. The
  // grant is keyed on having no history at all, not on having no balance.
  const fresh = "0x00000000000000000000000000000000000000f2";
  assert.equal(balanceOf(fresh), 50);
  for (let i = 0; i < 50; i++) trySpend(fresh);
  assert.equal(balanceOf(fresh), 0);
  assert.equal(balanceOf(fresh), 0, "reading a zero balance must not re-grant");
});

test("wallets cannot spend each other's credits", () => {
  const a = "0x00000000000000000000000000000000000000f3";
  const b = "0x00000000000000000000000000000000000000f4";
  balanceOf(a);
  balanceOf(b);
  trySpend(a);
  assert.equal(balanceOf(a), 49);
  assert.equal(balanceOf(b), 50, "one wallet's spend must not touch another's balance");
});

test("every pack a person can buy grants what it says", () => {
  for (const pack of PACKS) {
    const w = `0x${pack.id.padEnd(38, "0")}00`.slice(0, 42);
    const start = balanceOf(w);
    const after = addPurchase(w, pack.id, pack.credits, "0x" + "cd".repeat(32));
    assert.equal(after, start + pack.credits, `${pack.id} should add ${pack.credits}`);
  }
});
