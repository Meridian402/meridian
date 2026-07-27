import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import { assertSignerIsHouseWallet } from "../src/venues/signer.js";

/**
 * Mirror of the treasury allowlist, for the signing key: merd/wallets.ts pins
 * the house wallet, and a process whose key derives to anything else must
 * refuse to boot rather than sign from a wallet that role separation, the
 * docs and the published track record do not follow.
 *
 * Order matters: the keyless case runs first because getAgentSigner caches
 * the first key it ever sees.
 */

test("a keyless (read-only) process has nothing to assert", () => {
  delete process.env.AGENT_SIGNER_PRIVATE_KEY;
  assert.doesNotThrow(() => assertSignerIsHouseWallet());
});

test("a key that wallets.ts does not know is refused", () => {
  process.env.AGENT_SIGNER_PRIVATE_KEY = generatePrivateKey();
  assert.throws(() => assertSignerIsHouseWallet(), /wallets\.ts/);
});
