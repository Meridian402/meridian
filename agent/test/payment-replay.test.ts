import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The replay ledger resolves its path at import time, so the data dir override
// goes in first. These tests never touch the network: the on-chain half is
// replaced with a promise the test controls, which is the only way to hold a
// verification "in flight" deterministically.
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-payment-test-"));

const { PaymentGate } = await import("../src/payments/PaymentGate.js");

const TREASURY = "0x7037b347b21d5e72452da1445fb1f01d652d40cc";
const TX = "0x" + "ab".repeat(32);
const header = JSON.stringify({ txHash: TX, signature: "0x" + "cd".repeat(65) });

/**
 * The attack this pins: verification takes several awaits (receipt, block,
 * signature) and only burns the tx at the very end. Without a reservation, a
 * payer could fire the same X-PAYMENT header at several resources at once and
 * have every one of them pass the used-check before any burned, buying several
 * credit packs with a single transfer.
 */
test("the same payment cannot be verified twice concurrently", async () => {
  const gate = new PaymentGate(TREASURY, "self");
  let settle: ((v: { ok: boolean; txHash?: string }) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gate as any).settleOnChain = () =>
    new Promise((resolve) => {
      settle = resolve;
    });

  const first = gate.verify(header, 5, "credits:starter"); // in flight, holds the tx
  const second = await gate.verify(header, 50, "credits:pro"); // same tx, different pack

  assert.equal(second.ok, false, "a concurrent second use of one payment must be refused");
  assert.match(second.error ?? "", /already being verified/);

  settle!({ ok: true, txHash: TX });
  assert.equal((await first).ok, true, "the first verification still succeeds");
});

test("a released reservation does not block a later, honest verification", async () => {
  const gate = new PaymentGate(TREASURY, "self");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gate as any).settleOnChain = async () => ({ ok: false, error: "payment tx reverted" });

  const failed = await gate.verify(header, 5, "credits:starter");
  assert.equal(failed.ok, false);
  // A failed attempt must free the hold, or one bad request would lock that tx
  // out forever even for the person who really paid.
  const retry = await gate.verify(header, 5, "credits:starter");
  assert.equal(retry.ok, false);
  assert.doesNotMatch(retry.error ?? "", /already being verified/);
});

test("a malformed X-PAYMENT header is rejected before anything is held", async () => {
  const gate = new PaymentGate(TREASURY, "self");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gate as any).settleOnChain = async () => ({ ok: true, txHash: TX });

  assert.equal((await gate.verify("not json", 5, "credits:starter")).ok, false);
  assert.equal((await gate.verify(JSON.stringify({ txHash: "0x123" }), 5, "credits:starter")).ok, false);
  assert.equal((await gate.verify(JSON.stringify({ txHash: TX }), 5, "credits:starter")).ok, false); // no signature
  // The real header still works afterwards, so no rejected attempt left a hold.
  assert.equal((await gate.verify(header, 5, "credits:starter")).ok, true);
});
