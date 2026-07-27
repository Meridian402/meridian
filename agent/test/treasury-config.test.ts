import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTreasuryIsLive } from "../src/config.js";
import { TREASURY_WALLET, RETIRED_WALLET } from "../src/merd/wallets.js";

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

test("an unknown but plausible address is refused: allowlist, not denylist", () => {
  // The 2026-07-27 crash-loop was caught only because the stale value happened
  // to be on the denylist already. The next stale value will not be. Anything
  // that is not the canonical treasury is refused, no list maintenance needed.
  assert.throws(
    () => assertTreasuryIsLive("0x1111111111111111111111111111111111111111"),
    /not the canonical treasury/,
  );
});

test("unconfigured is allowed, because PaymentGate already fails safe on it", () => {
  // An empty treasury makes PaymentGate refuse to quote a price at all, which
  // is a louder and earlier failure than anything this guard would add.
  assert.doesNotThrow(() => assertTreasuryIsLive(""));
});
