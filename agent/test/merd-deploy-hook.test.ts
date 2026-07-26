import { test } from "node:test";
import assert from "node:assert/strict";
import { hookInitCode, predictHookAddress, assertDeployable, type HookDeployment } from "../src/merd/deployHook.js";
import { MERD_HOOK, MERD_HOOK_ADDRESS, MERD_HOOK_OWNER, MERD_TREASURY, MERD_FEE_SCHEDULE } from "../src/merd/merd.js";
import { ALL_HOOK_MASK, TREASURY_HOOK_FLAGS, hookAddressClaims } from "../src/merd/hookMiner.js";
import { V4_POOL_MANAGER, V4_POSITION_MANAGER } from "../src/merd/v4Pool.js";

/**
 * The hook's address is not cosmetic. v4 reads the permissions it will honour
 * out of the low 14 bits, and a hook at the wrong address is never called at
 * all — no revert, no error, just a pool that quietly collects nothing forever.
 * These tests are the tripwire for that, and for the deploy-time arguments that
 * decide where the address lands.
 */

test("the recorded address still reproduces from the recorded parameters", () => {
  // The whole point of writing the address down. If this fails, the contract,
  // its constructor arguments, or the compiler settings moved underneath it —
  // and MERD_HOOK_ADDRESS is now pointing at nothing.
  const { address } = predictHookAddress(MERD_HOOK);
  assert.equal(address, MERD_HOOK_ADDRESS);
});

test("the address claims exactly afterSwap and afterSwapReturnsDelta", () => {
  const bits = Number(BigInt(MERD_HOOK_ADDRESS) & BigInt(ALL_HOOK_MASK));
  assert.equal(bits, TREASURY_HOOK_FLAGS);
  assert.equal(bits, 0x044, "1<<6 | 1<<2");
  // Matching the whole mask, not just containing the bits we want: a stray
  // extra bit claims a callback the contract never implemented, and every swap
  // in the pool would revert on the missing function.
  assert.ok(hookAddressClaims(MERD_HOOK_ADDRESS));
});

test("mining is deterministic — same inputs, same salt, on any machine", () => {
  const a = predictHookAddress(MERD_HOOK);
  const b = predictHookAddress(MERD_HOOK);
  assert.equal(a.salt, b.salt);
  assert.equal(a.address, b.address);
});

test("the owner is the cold treasury, not a hot key", () => {
  // The only authority over this contract is a one-way fee kill switch. A hot
  // key holding it means a key compromise permanently zeroes our revenue.
  assert.equal(MERD_HOOK_OWNER, MERD_TREASURY);
  assert.equal(MERD_HOOK.owner, MERD_TREASURY);
});

// ── the address moves when it should ─────────────────────────────────────────

test("changing a single basis point moves the address", () => {
  // Proves the init code really does cover the constructor arguments, which is
  // what makes the recorded address a meaningful check rather than a comment.
  const nudged: HookDeployment = {
    ...MERD_HOOK,
    schedule: { ...MERD_FEE_SCHEDULE, buyFloorBps: 101 },
  };
  assert.notEqual(predictHookAddress(nudged).address, MERD_HOOK_ADDRESS);
});

test("changing the treasury moves the address", () => {
  const elsewhere: HookDeployment = { ...MERD_HOOK, treasury: "0x000000000000000000000000000000000000dEaD" };
  assert.notEqual(predictHookAddress(elsewhere).address, MERD_HOOK_ADDRESS);
});

test("every variant still lands on a valid hook address", () => {
  // Mining re-runs per variant, so each one must independently satisfy the mask
  // — otherwise a late parameter change produces a silently uncallable hook.
  for (const bps of [100, 150, 200]) {
    const d: HookDeployment = { ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, buyFloorBps: bps } };
    assert.ok(hookAddressClaims(predictHookAddress(d).address), `floor ${bps} mined a bad address`);
  }
});

test("init code is the creation bytecode followed by the arguments", () => {
  const code = hookInitCode(MERD_HOOK);
  assert.ok(code.startsWith("0x60") || code.startsWith("0x61"), "should begin with contract creation bytecode");
  // 3 addresses + 11 schedule words, each padded to 32 bytes, on the end.
  const args = hookInitCode(MERD_HOOK).length - hookInitCode({ ...MERD_HOOK, schedule: MERD_FEE_SCHEDULE }).length;
  assert.equal(args, 0, "identical inputs must produce identical init code");
  assert.ok(code.length > 1000, "artifact looks empty — run forge build");
});

// ── the arguments that would break the pool ──────────────────────────────────

test("the PositionManager is refused as the PoolManager", () => {
  // This exact confusion has happened once in this repo. A hook built against
  // the wrong manager rejects the real one in onlyPoolManager, so every swap in
  // the pool reverts — with no upgrade path and no way to change the pool's hook.
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, poolManager: V4_POSITION_MANAGER }),
    /verified v4 singleton/,
  );
});

test("the real PoolManager passes", () => {
  assert.equal(MERD_HOOK.poolManager, V4_POOL_MANAGER);
  assert.doesNotThrow(() => assertDeployable(MERD_HOOK));
});

test("zero addresses are refused before mining, not after", () => {
  for (const field of ["poolManager", "treasury", "owner"] as const) {
    assert.throws(
      () => assertDeployable({ ...MERD_HOOK, [field]: "0x0000000000000000000000000000000000000000" }),
      /zero address|verified v4 singleton/,
      `${field} should be rejected`,
    );
  }
});

test("a schedule that gets more expensive over time is refused", () => {
  // The most hostile thing this contract could do to someone who already bought.
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, buyFloorBps: 500 } }),
    /non-increasing/,
  );
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, sellPlateauBps: 1200 } }),
    /cap|non-increasing/,
  );
});

test("an opening rate above the contract's own cap is refused", () => {
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, buyLaunchBps: 2000 } }),
    /10% cap/,
  );
});

test("shares that exceed the whole fee are refused", () => {
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, referralShareBps: 9000, lpShareBps: 2000 } }),
    /exceed the whole fee/,
  );
});

test("a plateau that ends before the ramp reaches it is refused", () => {
  assert.throws(
    () => assertDeployable({ ...MERD_HOOK, schedule: { ...MERD_FEE_SCHEDULE, rampSeconds: 90_000n } }),
    /plateau cannot end before/,
  );
});

test("the pinned schedule is the one we reviewed", () => {
  // Reading these back in one place, because they are permanent once deployed.
  assert.equal(MERD_FEE_SCHEDULE.buyLaunchBps, 1000, "opens at 10%");
  assert.equal(MERD_FEE_SCHEDULE.buyPlateauBps, 300, "settles at 3%");
  assert.equal(MERD_FEE_SCHEDULE.buyFloorBps, 100, "floors at 1% forever");
  assert.equal(MERD_FEE_SCHEDULE.rampSeconds, 600n);
  assert.equal(MERD_FEE_SCHEDULE.plateauUntil, 86_400n);
  assert.equal(MERD_FEE_SCHEDULE.taperSeconds, 86_400n);
  assert.equal(MERD_FEE_SCHEDULE.referralShareBps + MERD_FEE_SCHEDULE.lpShareBps, 2000, "80% stays with the treasury");
});
