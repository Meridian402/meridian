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
  // Re-mined twice: once when the treasury consolidated onto 0x475C, and
  // again when the token gained its zero-treasury and zero-supply guards. The
  // address is a hash of the CONSTRUCTOR ARGS AND THE BYTECODE, so editing the
  // contract at all moves it. Both earlier salts (200179, 21540) are void.
  assert.equal(BigInt(MERD_SALT), 7905n);
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

// ── the fee schedule ─────────────────────────────────────────────────────────

test("the schedule is 10% -> 3% -> 1% across three phases", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/launch/merd.js");
  assert.equal(s.buyLaunchBps, 1000);
  assert.equal(s.buyPlateauBps, 300);
  assert.equal(s.buyFloorBps, 100);
  assert.equal(s.sellLaunchBps, 1000);
  assert.equal(s.sellPlateauBps, 300);
  assert.equal(s.sellFloorBps, 100);
});

test("the schedule only ever falls", async () => {
  // A rate that rises on holders after they buy is the hostile configuration.
  // The hook rejects it at construction; this catches it a step earlier.
  const { MERD_FEE_SCHEDULE: s } = await import("../src/launch/merd.js");
  assert.ok(s.buyPlateauBps <= s.buyLaunchBps && s.buyFloorBps <= s.buyPlateauBps, "buy fee must not rise");
  assert.ok(s.sellPlateauBps <= s.sellLaunchBps && s.sellFloorBps <= s.sellPlateauBps, "sell fee must not rise");
});

test("the plateau covers the whole first day and cannot end before the ramp", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/launch/merd.js");
  assert.equal(s.rampSeconds, 600n, "10 minute opening ramp");
  assert.equal(s.plateauUntil, 86_400n, "3% holds for 24 hours");
  assert.ok(s.plateauUntil > s.rampSeconds, "the plateau cannot end before the ramp feeding it");
});

test("the opening rate is within the hook's hard cap", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/launch/merd.js");
  // MAX_FEE_BPS in the hook is 1000; above it the deployment reverts.
  assert.ok(s.buyLaunchBps <= 1000 && s.sellLaunchBps <= 1000);
});
