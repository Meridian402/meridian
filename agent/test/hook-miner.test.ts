import { test } from "node:test";
import assert from "node:assert/strict";
import { getContractAddress, keccak256, toHex, type Hex } from "viem";
import {
  mineHookSalt,
  create2Address,
  hookAddressClaims,
  initCodeFor,
  HOOK_FLAGS,
  ALL_HOOK_MASK,
  TREASURY_HOOK_FLAGS,
  CREATE2_DEPLOYER,
} from "../src/launch/hookMiner.js";

/**
 * A v4 hook's permissions live in the low 14 bits of its own address, so the
 * deployment address is not a detail — it is the configuration. Get it wrong
 * and nothing reverts: the pool works, afterSwap is never called, and the fee
 * silently collects nothing forever.
 *
 * These pin the address maths and, more importantly, that we match the whole
 * mask rather than just the bits we want.
 */

// Stand-in init code; the miner only ever sees its hash.
const INIT_CODE = ("0x60806040" + "ab".repeat(64)) as Hex;

test("create2Address agrees with viem's own implementation", () => {
  // Cross-check rather than trust: if this hand-rolled packing were wrong,
  // every mined address would be wrong in a way nothing else would catch.
  const salt = keccak256(toHex("meridian"));
  const mine = create2Address(CREATE2_DEPLOYER, salt, keccak256(INIT_CODE));
  const theirs = getContractAddress({
    from: CREATE2_DEPLOYER,
    salt,
    bytecodeHash: keccak256(INIT_CODE),
    opcode: "CREATE2",
  });
  assert.equal(mine, theirs);
});

test("a mined address claims exactly the treasury-hook permissions", () => {
  const mined = mineHookSalt(INIT_CODE);
  assert.ok(hookAddressClaims(mined.address), `got ${mined.address}`);
  const bits = Number(BigInt(mined.address) & BigInt(ALL_HOOK_MASK));
  assert.equal(bits, TREASURY_HOOK_FLAGS);
  assert.equal(bits, HOOK_FLAGS.AFTER_SWAP | HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA);
});

test("the mined salt actually reproduces the mined address", () => {
  const mined = mineHookSalt(INIT_CODE);
  assert.equal(create2Address(CREATE2_DEPLOYER, mined.salt, keccak256(INIT_CODE)), mined.address);
});

test("matching is exact across the whole mask, not just the wanted bits", () => {
  // An address that ALSO sets BEFORE_SWAP would make the pool call a function
  // we never implemented, and every swap in that pool would revert. A subset
  // check would happily accept it.
  const withExtra = TREASURY_HOOK_FLAGS | HOOK_FLAGS.BEFORE_SWAP;
  const fakeAddress = `0x${"00".repeat(18)}${withExtra.toString(16).padStart(4, "0")}` as const;
  assert.equal(hookAddressClaims(fakeAddress), false, "extra permission bits must be rejected");
});

test("an address with no permission bits is rejected", () => {
  assert.equal(hookAddressClaims(`0x${"11".repeat(20)}` as const), false);
});

test("mining is cheap enough to run at deploy time", () => {
  // 14 bits => ~16k expected attempts. If this ever needs millions, the mask
  // or the flags are wrong, not the machine.
  const mined = mineHookSalt(INIT_CODE);
  assert.ok(mined.iterations < 500_000, `took ${mined.iterations} iterations`);
});

test("flags outside the permission mask are refused", () => {
  assert.throws(() => mineHookSalt(INIT_CODE, 1 << 15), /outside the 14-bit permission mask/);
});

test("init code binds the constructor arguments", () => {
  // The hash covers constructor args, so changing the treasury address changes
  // the required salt. A salt committed to source would silently go stale.
  const a = initCodeFor("0x6080" as Hex, `0x${"00".repeat(31)}01` as Hex);
  const b = initCodeFor("0x6080" as Hex, `0x${"00".repeat(31)}02` as Hex);
  assert.notEqual(keccak256(a), keccak256(b));
  assert.notEqual(mineHookSalt(a).address, mineHookSalt(b).address);
});
