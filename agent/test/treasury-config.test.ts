import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTreasuryIsLive } from "../src/config.js";
import { TREASURY_WALLET, HOUSE_WALLET, ENGINE_SIGNER_WALLET, PREVIOUS_ENGINE_SIGNER_WALLET, RETIRED_WALLET } from "../src/merd/wallets.js";
import { foldEarnings } from "../src/earningsHistory.js";

/**
 * treasuryAddress is the payTo of the whole x402 rail. Since 2026-09-04 the
 * only live value is the house wallet (the execution wallet); the OpenHermit
 * treasury joined the retired list on the operator's call ("never use that
 * wallet again"). A stale value does not error; it quietly collects into
 * somewhere nobody is watching, so this guard is an allowlist of one.
 */

test("the house wallet passes, and it is the execution wallet", () => {
  assert.equal(HOUSE_WALLET, ENGINE_SIGNER_WALLET);
  assert.doesNotThrow(() => assertTreasuryIsLive(HOUSE_WALLET));
  assert.doesNotThrow(() => assertTreasuryIsLive(HOUSE_WALLET.toLowerCase()));
});

test("the 2026-08 treasury is refused as retired", () => {
  assert.throws(() => assertTreasuryIsLive(TREASURY_WALLET), /retired wallet/);
});

test("older retired wallets stay refused, case-insensitively", () => {
  assert.throws(() => assertTreasuryIsLive(RETIRED_WALLET), /retired wallet/);
  assert.throws(() => assertTreasuryIsLive(RETIRED_WALLET.toUpperCase()), /retired wallet/);
  assert.throws(() => assertTreasuryIsLive(PREVIOUS_ENGINE_SIGNER_WALLET), /retired wallet/);
});

test("an unknown but plausible address is refused: allowlist, not denylist", () => {
  assert.throws(() => assertTreasuryIsLive("0x1111111111111111111111111111111111111111"), /not the canonical treasury/);
});

test("unconfigured is allowed, because PaymentGate already fails safe on it", () => {
  assert.doesNotThrow(() => assertTreasuryIsLive(""));
});

test("the earnings timeline is the desk's own collects, cumulative, with receipts", () => {
  const rows = [
    { ts: 3, mech: "collect", feeUsd: 1.5, sleeve: "usdg", venue: "CASHCAT", tx: "0xc" },
    { ts: 1, mech: "collect", feeUsd: 2, sleeve: "usdg", venue: "PONS", tx: "0xa" },
    { ts: 2, mech: "mint", usdIn: 700, sleeve: "usdg", venue: "PONS" },
    { ts: 4, mech: "collect", feeUsd: 0, sleeve: "meme", venue: "BONER" },
    { ts: 5, mech: "collect", feeUsd: 0.25, sleeve: "meme", venue: "BONER" },
  ];
  const pts = foldEarnings(rows, 2000);
  assert.deepEqual(pts.map((p) => [p.ts, p.usd, p.amountUsd, p.venue, p.tx ?? null]), [[1, 2, 2, "PONS", "0xa"], [3, 3.5, 1.5, "CASHCAT", "0xc"], [5, 3.75, 0.25, "BONER", null]]);
  assert.equal(pts[2].eth, 0.001875, "eth is the cumulative figure at the served price");
});
