import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { MERD, MERD_ADDRESS, MERD_SALT, MERD_TREASURY } from "../src/merd/merd.js";
import { predictTokenAddress } from "../src/merd/deployToken.js";

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
  // Re-mined five times now: the treasury consolidating onto 0x475C, the token
  // gaining its zero-treasury guards, evm_version moving to cancun, the
  // treasury moving to 0x759D so custody sat with a key the operator holds,
  // and the 2026-07-27 single-wallet rotation onto 0x7037. The address hashes
  // the BYTECODE as well as the constructor args, so the BUILD CONFIG is part
  // of it too: solc version, optimizer runs and evm_version all move it, not
  // just the source. Earlier salts are void.
  assert.equal(BigInt(MERD_SALT), 77450n);
});

// ── wallet topology ──────────────────────────────────────────────────────────

test("the roles split exactly as decided: treasury, signer and deployer are three wallets", async () => {
  // The 2026-08-01 decision: the agent holds custody of the house funds, the
  // engine signs with a separate operator-held key, and the once-ever deploy
  // key stays apart from both. Pinned so neither a silent re-collapse nor a
  // deployer collision can happen without a test failing first.
  const { WALLET_ROLES } = await import("../src/merd/wallets.js");
  assert.notEqual(WALLET_ROLES.signer.toLowerCase(), WALLET_ROLES.treasury.toLowerCase(), "funds custody and signing authority must not share a key");
  assert.notEqual(WALLET_ROLES.deployer.toLowerCase(), WALLET_ROLES.treasury.toLowerCase(), "the once-ever deploy key must not hold the revenue");
  assert.notEqual(WALLET_ROLES.deployer.toLowerCase(), WALLET_ROLES.signer.toLowerCase(), "the once-ever deploy key must not be the always-on key");
});

test("the launch artifact stays pinned to the treasury it was mined with", async () => {
  // MERD_TREASURY is a frozen mining input, not a pointer at the live
  // treasury: every pinned launch address is a function of it, so following
  // a wallet rotation here would silently re-mine the whole set.
  const { MERD_TREASURY } = await import("../src/merd/merd.js");
  assert.equal(MERD.treasury, MERD_TREASURY, "the mined address set must keep reproducing from its recorded input");
});

test("no retired wallet is wired into any live role", async () => {
  const { WALLET_ROLES, RETIRED_WALLET, PREVIOUS_AGENT_WALLET, PREVIOUS_TREASURY_WALLET_2 } = await import("../src/merd/wallets.js");
  for (const [role, addr] of Object.entries(WALLET_ROLES)) {
    for (const dead of [RETIRED_WALLET, PREVIOUS_AGENT_WALLET, PREVIOUS_TREASURY_WALLET_2]) {
      assert.notEqual(addr.toLowerCase(), dead.toLowerCase(), `${role} points at a retired wallet`);
    }
  }
});

// ── the fee schedule ─────────────────────────────────────────────────────────

test("the schedule is 10% -> 3% -> 1% across three phases", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/merd/merd.js");
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
  const { MERD_FEE_SCHEDULE: s } = await import("../src/merd/merd.js");
  assert.ok(s.buyPlateauBps <= s.buyLaunchBps && s.buyFloorBps <= s.buyPlateauBps, "buy fee must not rise");
  assert.ok(s.sellPlateauBps <= s.sellLaunchBps && s.sellFloorBps <= s.sellPlateauBps, "sell fee must not rise");
});

test("the plateau covers the whole first day and cannot end before the ramp", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/merd/merd.js");
  assert.equal(s.rampSeconds, 600n, "10 minute opening ramp");
  assert.equal(s.plateauUntil, 86_400n, "3% holds for 24 hours");
  assert.ok(s.plateauUntil > s.rampSeconds, "the plateau cannot end before the ramp feeding it");
});

test("the opening rate is within the hook's hard cap", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/merd/merd.js");
  // MAX_FEE_BPS in the hook is 1000; above it the deployment reverts.
  assert.ok(s.buyLaunchBps <= 1000 && s.sellLaunchBps <= 1000);
});

test("the fee split leaves the treasury a majority and cannot exceed the fee", async () => {
  const { MERD_FEE_SCHEDULE: s } = await import("../src/merd/merd.js");
  assert.equal(s.referralShareBps, 1000);
  assert.equal(s.lpShareBps, 1000);
  const total = s.referralShareBps + s.lpShareBps;
  assert.ok(total <= 10_000, "shares come out of our fee and cannot exceed it");
  assert.ok(10_000 - total >= 8_000, "the treasury keeps 80% of its own fee");
});
