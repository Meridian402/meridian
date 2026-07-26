import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTreasuryIsLive } from "../src/config.js";
import { TREASURY_WALLET, RETIRED_WALLET } from "../src/launch/wallets.js";

/**
 * treasuryAddress is the payTo of the whole x402 rail — the address callers are
 * told to send to, and the address their payment is then verified against. A
 * stale value there does not error; it quietly collects into somewhere nobody
 * is watching. This is the guard for that, and it exists because the retired
 * wallet really was configured.
 */

test("the retired wallet is refused outright", () => {
  assert.throws(() => assertTreasuryIsLive(RETIRED_WALLET), /retired wallet/);
});

test("case does not let it through", () => {
  assert.throws(() => assertTreasuryIsLive(RETIRED_WALLET.toUpperCase()), /retired wallet/);
  assert.throws(() => assertTreasuryIsLive(RETIRED_WALLET.toLowerCase()), /retired wallet/);
});

test("the real treasury passes", () => {
  assert.doesNotThrow(() => assertTreasuryIsLive(TREASURY_WALLET));
});

test("unconfigured is allowed, because PaymentGate already fails safe on it", () => {
  // An empty treasury makes PaymentGate refuse to quote a price at all, which
  // is a louder and earlier failure than anything this guard would add.
  assert.doesNotThrow(() => assertTreasuryIsLive(""));
});
