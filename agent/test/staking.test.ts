import { test } from "node:test";
import assert from "node:assert/strict";

// The staking surface must stay DORMANT until MERD is deployed and the vault
// address is set. This file exists because a staking card that lights up early
// leaks that a MERD launch is imminent, which is exactly what the embargo
// forbids. The property under test is that nothing enables by accident.

const MERD = "0x4663196C0Ad93594907555b2018457695Db8Ccef";
const VAULT = "0x1111111111111111111111111111111111111111";

async function load() {
  return import(`../src/earn/staking.js?t=${Math.random()}`);
}

test("dormant by default: no MERD, no vault", async () => {
  delete process.env.MERD_TOKEN_ADDRESS;
  delete process.env.MERD_STAKING_ADDRESS;
  const { stakingEnabled, stakingAddress, stakingState } = await load();
  assert.equal(stakingEnabled(), false);
  assert.equal(stakingAddress(), null);
  assert.deepEqual(await stakingState(), { enabled: false });
});

test("MERD alone does not enable staking: the vault address is also required", async () => {
  process.env.MERD_TOKEN_ADDRESS = MERD;
  delete process.env.MERD_STAKING_ADDRESS;
  const { stakingEnabled } = await load();
  assert.equal(stakingEnabled(), false, "no vault address means no staking, even with MERD live");
});

test("the vault address alone does not enable it either: MERD must be live", async () => {
  delete process.env.MERD_TOKEN_ADDRESS;
  process.env.MERD_STAKING_ADDRESS = VAULT;
  const { stakingEnabled } = await load();
  assert.equal(stakingEnabled(), false, "a vault with no live token is still dormant");
});

test("both set is what turns it on, and only a deliberate real address counts", async () => {
  process.env.MERD_TOKEN_ADDRESS = MERD;
  process.env.MERD_STAKING_ADDRESS = VAULT;
  const { stakingEnabled, stakingAddress } = await load();
  assert.equal(stakingEnabled(), true);
  assert.equal(stakingAddress(), VAULT);
  // Junk in the vault var leaves it dormant rather than pointing at nothing.
  process.env.MERD_STAKING_ADDRESS = "not-an-address";
  const again = await load();
  assert.equal(again.stakingEnabled(), false);
});

test("prepare refuses while dormant, so no MERD tx is ever built early", async () => {
  delete process.env.MERD_TOKEN_ADDRESS;
  delete process.env.MERD_STAKING_ADDRESS;
  const { prepareStake } = await load();
  await assert.rejects(
    () => prepareStake({ address: "0x" + "aa".repeat(20), amountMerd: 5, direction: "stake" }),
    /not live/,
  );
});

test("the state read carries no rate field, ever", async () => {
  // The vault has no APR by design. The dormant shape must not carry one, and
  // when live the only forward-looking-sounding field is growthSinceLaunchPct,
  // which is history. Assert the dormant shape is exactly { enabled: false }.
  delete process.env.MERD_TOKEN_ADDRESS;
  delete process.env.MERD_STAKING_ADDRESS;
  const { stakingState } = await load();
  const s = await stakingState();
  assert.deepEqual(Object.keys(s), ["enabled"]);
  assert.ok(!("apr" in s) && !("aprPct" in s) && !("rate" in s));
});
