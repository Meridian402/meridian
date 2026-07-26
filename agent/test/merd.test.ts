import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { MERD, MERD_ADDRESS, MERD_SALT, MERD_TREASURY } from "../src/launch/merd.js";
import { predictTokenAddress } from "../src/launch/deployToken.js";

/**
 * The salt is only correct for one exact set of constructor arguments. Change
 * the treasury, the supply, or a character of the name, and the init code hash
 * moves, the address moves, and the mined salt quietly produces something else.
 *
 * Without this test that is a silent surprise discovered on-chain. With it, it
 * is a failing build.
 */

test("the recorded salt still produces the mined 0x4663 address", () => {
  assert.equal(predictTokenAddress(MERD), MERD_ADDRESS);
});

test("the address begins with the chain id, which is the whole point of mining it", () => {
  assert.ok(MERD_ADDRESS.toLowerCase().startsWith("0x4663"), `got ${MERD_ADDRESS}`);
});

test("changing ANY parameter invalidates the address", () => {
  // Each of these is a realistic slip, and each must move the address rather
  // than deploy something subtly wrong to the expected one.
  assert.notEqual(predictTokenAddress({ ...MERD, supply: 100_000_000n }), MERD_ADDRESS);
  assert.notEqual(predictTokenAddress({ ...MERD, name: "meridian" }), MERD_ADDRESS);
  assert.notEqual(predictTokenAddress({ ...MERD, symbol: "MRD" }), MERD_ADDRESS);
  assert.notEqual(
    predictTokenAddress({ ...MERD, treasury: "0x0000000000000000000000000000000000000001" }),
    MERD_ADDRESS,
  );
  assert.notEqual(predictTokenAddress({ ...MERD, salt: `0x${"00".repeat(32)}` }), MERD_ADDRESS);
});

test("the parameters are exactly what was agreed", () => {
  assert.equal(MERD.name, "Meridian");
  assert.equal(MERD.symbol, "MERD");
  assert.equal(MERD.supply, 1_000_000_000n);
  assert.equal(MERD.treasury, MERD_TREASURY);
  // Whole tokens, not wei. Passing 1e27 here would mint a billion billion.
  assert.ok(MERD.supply < 10n ** 12n, "supply must be expressed in whole tokens");
});

test("addresses are canonically checksummed", () => {
  // A checksum mismatch is the cheapest possible typo detector, and these two
  // addresses are the ones a mistake would be permanent in.
  assert.equal(getAddress(MERD_ADDRESS), MERD_ADDRESS);
  assert.equal(getAddress(MERD_TREASURY), MERD_TREASURY);
});

test("the treasury is not the deploying key", () => {
  // deployToken enforces this at runtime too; pinned here so the constant
  // cannot be edited to the signer without a test failing first.
  assert.notEqual(MERD_TREASURY.toLowerCase(), "0xb849aa20b21c015e8f5118dcf4b631366c2e87bb");
});

test("the salt is the mined value, not a placeholder", () => {
  // Re-mined when the treasury consolidated onto 0x475C: the treasury is a
  // constructor argument, so it is part of the init code hash and therefore
  // part of the address. The previous salt (200179) is void.
  assert.equal(BigInt(MERD_SALT), 21540n);
});

// ── wallet topology ──────────────────────────────────────────────────────────

test("the three wallet roles are three distinct addresses", async () => {
  const { WALLET_ROLES } = await import("../src/launch/wallets.js");
  const seen = new Set(Object.values(WALLET_ROLES).map((a) => a.toLowerCase()));
  assert.equal(seen.size, 3, "a collapsed role means one compromise costs more than it has to");
});

test("the treasury is the wallet that holds the supply", async () => {
  const { TREASURY_WALLET } = await import("../src/launch/wallets.js");
  assert.equal(MERD.treasury, TREASURY_WALLET, "MERD's supply must land in the treasury, not elsewhere");
});

test("neither the agent nor the deployer is the treasury", async () => {
  const { MERD_AGENT_WALLET, DEPLOYER_WALLET, TREASURY_WALLET } = await import("../src/launch/wallets.js");
  assert.notEqual(MERD_AGENT_WALLET.toLowerCase(), TREASURY_WALLET.toLowerCase());
  assert.notEqual(DEPLOYER_WALLET.toLowerCase(), TREASURY_WALLET.toLowerCase());
});

test("the retired wallet is not wired into any live role", async () => {
  const { WALLET_ROLES, RETIRED_WALLET } = await import("../src/launch/wallets.js");
  for (const [role, addr] of Object.entries(WALLET_ROLES)) {
    assert.notEqual(addr.toLowerCase(), RETIRED_WALLET.toLowerCase(), `${role} points at the retired wallet`);
  }
});
