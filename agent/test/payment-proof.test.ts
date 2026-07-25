import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMessage } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { paymentMessage } from "../src/payments/PaymentGate.js";

/**
 * The x402 payment proof must be NON-TRANSFERABLE.
 *
 * Before this, X-PAYMENT carried only a tx hash. Every transfer to the treasury
 * is public the instant it lands, so that hash was a bearer token: anyone
 * watching the chain could lift an honest payer's hash, present it as their own,
 * and burn it — getting a free call AND leaving the real payer's request
 * rejected as "already used".
 *
 * These tests pin the property that closes it: a proof is only valid when signed
 * by the wallet whose USDG actually moved, for that exact transfer and that
 * exact tool. They exercise the signature binding directly (no chain needed) —
 * the suite's other tests run the gate in stub mode, which accepts any proof and
 * therefore cannot cover this.
 */

const TREASURY = "0x1111111111111111111111111111111111111111";
const TX = "0xabc0000000000000000000000000000000000000000000000000000000000001";
const OTHER_TX = "0xabc0000000000000000000000000000000000000000000000000000000000002";

const payer = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());

const sign = (account: typeof payer, params: { txHash: string; resource: string; treasury?: string }) =>
  account.signMessage({ message: paymentMessage({ treasury: TREASURY, ...params }) });

const verify = (address: string, signature: string, params: { txHash: string; resource: string; treasury?: string }) =>
  verifyMessage({
    address: address as `0x${string}`,
    message: paymentMessage({ treasury: TREASURY, ...params }),
    signature: signature as `0x${string}`,
  });

test("the paying wallet's own signature verifies", async () => {
  const sig = await sign(payer, { txHash: TX, resource: "meridian_lp_score" });
  assert.equal(await verify(payer.address, sig, { txHash: TX, resource: "meridian_lp_score" }), true);
});

test("THEFT: an observer who knows the tx hash cannot forge the proof", async () => {
  // The attacker sees TX on-chain and signs it with their OWN key, since they
  // do not have the payer's. The gate recovers the signature against the wallet
  // that actually sent the USDG (the payer), so it must not match.
  const forged = await sign(attacker, { txHash: TX, resource: "meridian_lp_score" });
  assert.equal(await verify(payer.address, forged, { txHash: TX, resource: "meridian_lp_score" }), false);
});

test("a proof cannot be moved to a different tool", async () => {
  // Paying $0.02 for a carry quote must not unlock a $0.05 lp_score call.
  const sig = await sign(payer, { txHash: TX, resource: "meridian_carry_quote" });
  assert.equal(await verify(payer.address, sig, { txHash: TX, resource: "meridian_lp_score" }), false);
});

test("a proof cannot be moved to a different payment", async () => {
  const sig = await sign(payer, { txHash: TX, resource: "meridian_lp_score" });
  assert.equal(await verify(payer.address, sig, { txHash: OTHER_TX, resource: "meridian_lp_score" }), false);
});

test("a proof cannot be replayed against a different operator's treasury", async () => {
  const sig = await sign(payer, { txHash: TX, resource: "meridian_lp_score" });
  const elsewhere = await verify(payer.address, sig, {
    txHash: TX,
    resource: "meridian_lp_score",
    treasury: "0x2222222222222222222222222222222222222222",
  });
  assert.equal(elsewhere, false);
});

test("the signed message is case-stable, so hash/treasury casing cannot break an honest payer", async () => {
  const sig = await sign(payer, { txHash: TX.toUpperCase().replace("0X", "0x"), resource: "meridian_lp_score" });
  assert.equal(await verify(payer.address, sig, { txHash: TX.toLowerCase(), resource: "meridian_lp_score" }), true);
});
