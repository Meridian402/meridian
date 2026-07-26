import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi } from "viem";
import {
  predictLockAddress,
  lockInitCode,
  assertDeployable,
  buildLockExistingTransaction,
  type LockDeployment,
} from "../src/launch/deployLock.js";
import { MERD_LOCK, MERD_LOCK_ADDRESS, MERD_SEED, MERD_TREASURY, MERD_ADDRESS } from "../src/launch/merd.js";
import { buildSeedTransactions } from "../src/launch/seedPool.js";
import { V4_POSITION_MANAGER, V4_POOL_MANAGER, NATIVE_ETH } from "../src/launch/v4Pool.js";

/**
 * The lock's address is an INPUT to the launch transaction — the mint names it
 * as the position's owner — so it has to be known and correct before anything
 * is broadcast. If it drifts, the entire supply is minted to an address that
 * either holds nothing or holds a contract we did not write.
 */

test("the recorded lock address still reproduces from the recorded parameters", () => {
  assert.equal(predictLockAddress(MERD_LOCK), MERD_LOCK_ADDRESS);
});

test("the launch mints the position to the LOCK, never to a wallet", () => {
  // The property that makes this a fair launch rather than a promise: no key
  // ever holds an NFT worth every token in existence, not even briefly.
  assert.equal(MERD_SEED.recipient, MERD_LOCK_ADDRESS);
  assert.notEqual(MERD_SEED.recipient, MERD_TREASURY, "the treasury must not receive the position");
});

test("the mint recipient in the actual calldata is the lock", () => {
  // Asserting the constant is not enough — what matters is the bytes that get
  // signed, so decode them.
  const { txs } = buildSeedTransactions(MERD_SEED);
  const MULTICALL = parseAbi(["function multicall(bytes[] data) payable returns (bytes[])"]);
  const [calls] = decodeFunctionData({ abi: MULTICALL, data: txs[2].data }).args as [readonly `0x${string}`[]];
  const MODIFY = parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
  const [unlockData] = decodeFunctionData({ abi: MODIFY, data: calls[1] }).args as [`0x${string}`, bigint];
  // The owner sits in the mint params; checking it appears at all is enough to
  // catch a recipient that silently reverted to a wallet.
  assert.ok(
    unlockData.toLowerCase().includes(MERD_LOCK_ADDRESS.slice(2).toLowerCase()),
    "the lock address must appear in the mint params",
  );
  assert.ok(
    !unlockData.toLowerCase().includes(MERD_TREASURY.slice(2).toLowerCase()),
    "the treasury must not appear as a position recipient",
  );
});

test("changing any constructor argument moves the lock", () => {
  const variants: [string, LockDeployment][] = [
    ["beneficiary", { ...MERD_LOCK, beneficiaryA: "0x000000000000000000000000000000000000dEaD" }],
    ["share", { ...MERD_LOCK, shareABps: 5000 }],
    ["currency1", { ...MERD_LOCK, currency1: "0x000000000000000000000000000000000000dEaD" }],
  ];
  for (const [label, v] of variants) {
    assert.notEqual(predictLockAddress(v), MERD_LOCK_ADDRESS, `${label} should move the address`);
  }
});

test("the lock pays fees to the treasury, whole", () => {
  // Creator and platform are the same party for MERD, so A takes everything.
  assert.equal(MERD_LOCK.beneficiaryA, MERD_TREASURY);
  assert.equal(MERD_LOCK.beneficiaryB, MERD_TREASURY);
  assert.equal(MERD_LOCK.shareABps, 10_000);
});

test("the lock is built against MERD's actual pool", () => {
  assert.equal(MERD_LOCK.currency0, NATIVE_ETH, "native ETH sorts to currency0");
  assert.equal(MERD_LOCK.currency1, MERD_ADDRESS);
  assert.equal(MERD_LOCK.positionManager, V4_POSITION_MANAGER);
});

// ── the arguments that would strand the supply ───────────────────────────────

test("the PoolManager is refused where the PositionManager belongs", () => {
  // The same confusion that would have broken the hook, in the other direction.
  // A lock pointed at the singleton can never collect the position's fees.
  assert.throws(
    () => assertDeployable({ ...MERD_LOCK, positionManager: V4_POOL_MANAGER }),
    /expected/,
  );
});

test("zero beneficiaries are refused", () => {
  for (const field of ["beneficiaryA", "beneficiaryB", "currency1"] as const) {
    assert.throws(
      () => assertDeployable({ ...MERD_LOCK, [field]: "0x0000000000000000000000000000000000000000" }),
      /zero address/,
      `${field} should be rejected`,
    );
  }
});

test("a non-native currency0 is refused", () => {
  // v4 sorts native ETH first and spells it as address(0). Anything else here
  // means the lock and the pool disagree about which token is which.
  assert.throws(() => assertDeployable({ ...MERD_LOCK, currency0: MERD_ADDRESS }), /native ETH/);
});

test("the real configuration passes", () => {
  assert.doesNotThrow(() => assertDeployable(MERD_LOCK));
  assert.ok(lockInitCode(MERD_LOCK).length > 1000, "artifact looks empty — run forge build");
});

// ── the follow-up call ───────────────────────────────────────────────────────

test("lockExisting encodes the tokenId the launch actually minted", () => {
  const tx = buildLockExistingTransaction(MERD_LOCK_ADDRESS, 7n);
  assert.equal(tx.to, MERD_LOCK_ADDRESS);
  assert.equal(tx.value, "0");
  const decoded = decodeFunctionData({ abi: parseAbi(["function lockExisting(uint256 id)"]), data: tx.data });
  assert.equal((decoded.args as [bigint])[0], 7n);
});

test("a zero tokenId is refused rather than encoded", () => {
  // Zero is the lock's "nothing locked yet" sentinel, and v4 starts at 1, so a
  // zero here means the tokenId was never actually read.
  assert.throws(() => buildLockExistingTransaction(MERD_LOCK_ADDRESS, 0n), /must be positive/);
  assert.throws(() => buildLockExistingTransaction(MERD_LOCK_ADDRESS, -1n), /must be positive/);
});
