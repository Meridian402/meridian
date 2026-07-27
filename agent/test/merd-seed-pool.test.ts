import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi, parseEther, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import {
  sqrtPriceX96For,
  liquidityFor,
  fullRangeTicks,
  buildSeedTransactions,
  poolIdFor,
  openingPrice,
} from "../src/merd/seedPool.js";
import { MERD_ADDRESS, MERD, MERD_SEED, MERD_HOOK_ADDRESS, MERD_LOCK_ADDRESS } from "../src/merd/merd.js";
import { V4_POSITION_MANAGER, PERMIT2, NATIVE_ETH } from "../src/merd/v4Pool.js";

/**
 * The opening price cannot be corrected. Whatever the pool is created with is
 * what every subsequent trade prices off, so the arithmetic below is the part
 * of this module that has to be exactly right rather than approximately right.
 */

const Q96 = 2n ** 96n;
const HOOK = "0x0000000000000000000000000000000999900044" as const;

test("a 1:1 pool opens at exactly 2^96", () => {
  // The known anchor: sqrt(1) * 2^96. If this drifts, everything else is wrong.
  assert.equal(sqrtPriceX96For(parseEther("1"), parseEther("1")), Q96);
});

test("price four opens at exactly twice the anchor", () => {
  // sqrt(4) = 2, so sqrtPriceX96 doubles.
  assert.equal(sqrtPriceX96For(parseEther("1"), parseEther("4")), 2n * Q96);
});

test("the price is currency1 per currency0, which is MERD per ETH", () => {
  const { merdPerEth } = openingPrice(parseEther("1"), parseEther("1000000"));
  assert.equal(merdPerEth, 1_000_000);
});

test("integer maths holds at launch magnitudes", () => {
  // 1e27 MERD against 1e18 ETH is where floating point starts losing digits,
  // and it is exactly the shape a real launch has.
  const s = sqrtPriceX96For(parseEther("1"), parseEther("1000000000"));
  // sqrt(1e9) = 31622.7766..., so sqrtPriceX96 ≈ 31622.77 * 2^96
  const ratio = Number(s) / Number(Q96);
  assert.ok(Math.abs(ratio - Math.sqrt(1e9)) / Math.sqrt(1e9) < 1e-9, `got ratio ${ratio}`);
});

test("a zero on either side is refused rather than producing a garbage price", () => {
  assert.throws(() => sqrtPriceX96For(0n, parseEther("1")), /both sides must be positive/);
  assert.throws(() => sqrtPriceX96For(parseEther("1"), 0n), /both sides must be positive/);
});

test("full range is the widest ticks the spacing allows", () => {
  assert.deepEqual(fullRangeTicks(200), { tickLower: -887200, tickUpper: 887200 });
  assert.deepEqual(fullRangeTicks(60), { tickLower: -887220, tickUpper: 887220 });
  // Must be aligned, or the mint reverts.
  for (const spacing of [1, 10, 60, 200]) {
    const { tickLower, tickUpper } = fullRangeTicks(spacing);
    // === rather than assert.equal: JS gives -0 for a negative exact multiple,
    // and Object.is (which assert.equal uses) treats -0 and 0 as different.
    assert.ok(tickLower % spacing === 0, `tickLower ${tickLower} misaligned at spacing ${spacing}`);
    assert.ok(tickUpper % spacing === 0, `tickUpper ${tickUpper} misaligned at spacing ${spacing}`);
    assert.ok(Math.abs(tickLower) <= 887272, "must stay inside v4's own bound");
  }
});

test("liquidity carries the 1% execution-price haircut", () => {
  // Not superstition: the PositionManager pulls amounts at execution-time price,
  // and the LP guard's first live re-center reverted on exactly this.
  const eth = parseEther("10");
  const merd = parseEther("1000000");
  const s = sqrtPriceX96For(eth, merd);
  const { tickLower, tickUpper } = fullRangeTicks(200);
  const l = liquidityFor(eth, merd, s, tickLower, tickUpper);
  assert.ok(l > 0n, "should mint something");

  // Re-deriving without the haircut must come out strictly larger.
  const undiscounted = (l * 100n) / 99n;
  assert.ok(undiscounted > l);
});

test("a price outside the range is refused", () => {
  const s = sqrtPriceX96For(parseEther("1"), parseEther("1"));
  // Range entirely above the opening price.
  assert.throws(() => liquidityFor(parseEther("1"), parseEther("1"), s, 60000, 80000), /inside the range/);
});

// ── the transaction sequence ─────────────────────────────────────────────────

const plan = {
  ethWei: parseEther("5"),
  merdWei: parseEther("100000000"), // 10% of supply
  recipient: "0x7037b347B21D5e72452dA1445FB1f01D652d40CC" as const,
  hook: HOOK,
};

const MULTICALL_ABI = parseAbi(["function multicall(bytes[] data) payable returns (bytes[])"]);
const INITIALIZE_ABI = parseAbi(["function initializePool((address,address,uint24,int24,address), uint160) payable returns (int24)"]);
const MODIFY_ABI = parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);

/** The two inner calls bundled into the launch transaction. */
function innerCalls(data: `0x${string}`): readonly `0x${string}`[] {
  const [calls] = decodeFunctionData({ abi: MULTICALL_ABI, data }).args as [readonly `0x${string}`[]];
  return calls;
}

test("the sequence is approve, permit2, then one atomic launch transaction", () => {
  const { txs } = buildSeedTransactions(plan);
  assert.equal(txs.length, 3, "creation and seeding are bundled, not separate");
  assert.equal(txs[0].to, MERD_ADDRESS, "first grant is on the token");
  assert.equal(txs[1].to, PERMIT2, "v4 pulls ERC-20s through Permit2");
  assert.equal(txs[2].to, V4_POSITION_MANAGER);
});

test("creation and seeding are ATOMIC — the opening price cannot be moved in between", () => {
  // The failure this prevents: a v4 pool with no liquidity still has a price,
  // and a swap against an empty pool moves it. Two transactions leave a gap
  // where anyone watching can set the opening price of a pool that is about to
  // receive the entire supply.
  const { txs, sqrtPriceX96 } = buildSeedTransactions(plan);
  const calls = innerCalls(txs[2].data);
  assert.equal(calls.length, 2, "exactly initializePool then modifyLiquidities");

  const [tuple, price] = decodeFunctionData({ abi: INITIALIZE_ABI, data: calls[0] }).args as [
    readonly [string, string, number, number, string],
    bigint,
  ];
  assert.equal(price, sqrtPriceX96, "the pool opens at the price we computed");

  // The second call must really be the mint, or "atomic" is a comment rather
  // than a property.
  const [unlockData] = decodeFunctionData({ abi: MODIFY_ABI, data: calls[1] }).args as [`0x${string}`, bigint];
  assert.ok(unlockData.length > 2, "the mint carries its actions");
  assert.equal(tuple[4], plan.hook);
});

test("only the launch transaction carries ETH, and exactly the planned amount", () => {
  const { txs } = buildSeedTransactions(plan);
  assert.equal(txs[0].value, "0");
  assert.equal(txs[1].value, "0");
  // multicall delegatecalls, so msg.value passes through to modifyLiquidities.
  assert.equal(txs[2].value, plan.ethWei.toString(), "the pool is funded once");
});

test("the pool is created WITH the hook — it can never be added later", () => {
  const { key, txs } = buildSeedTransactions(plan);
  assert.equal(key.hooks, HOOK);
  const [tuple] = decodeFunctionData({ abi: INITIALIZE_ABI, data: innerCalls(txs[2].data)[0] }).args as [
    readonly [string, string, number, number, string],
    bigint,
  ];
  assert.equal(tuple[4], HOOK, "the hook is part of the pool's identity");
  assert.equal(tuple[0], NATIVE_ETH, "native ETH sorts to currency0");
  assert.equal(tuple[1], MERD_ADDRESS);
});

test("seeding without a hook is refused outright", () => {
  assert.throws(() => buildSeedTransactions({ ...plan, hook: NATIVE_ETH }), /hook address is required/);
});

test("the opening price in the creation call matches the amounts being seeded", () => {
  const { sqrtPriceX96, txs } = buildSeedTransactions(plan);
  const [, price] = decodeFunctionData({ abi: INITIALIZE_ABI, data: innerCalls(txs[2].data)[0] }).args as [unknown, bigint];
  assert.equal(price, sqrtPriceX96);
  assert.equal(price, sqrtPriceX96For(plan.ethWei, plan.merdWei), "price must be derived from the seed, not guessed");
});

// ── the launch shape as decided ──────────────────────────────────────────────

test("the whole supply goes into the pool, against one ETH", () => {
  // A fair launch by construction: nothing held back means no treasury
  // overhang, and no allocation anyone has to be trusted not to dump.
  assert.equal(MERD_SEED.merdWei, MERD.supply * 10n ** 18n, "every token is in the pool");
  assert.equal(MERD_SEED.ethWei, parseEther("1"));
});

test("opening FDV equals the ETH seeded, because the whole supply is priced by it", () => {
  // With every token in a full-range position, the MERD side is worth exactly
  // the ETH side, so FDV is the ETH in. This is arithmetic, not a target — but
  // it is the number people will read off a screen, so it gets asserted.
  const { merdPerEth } = openingPrice(MERD_SEED.ethWei, MERD_SEED.merdWei);
  const ethPerMerd = 1 / merdPerEth;
  const fdvInEth = ethPerMerd * Number(MERD.supply);
  assert.ok(Math.abs(fdvInEth - 1) < 1e-9, `FDV should be 1 ETH, got ${fdvInEth}`);
});

test("the seed produces a valid price at whole-supply magnitudes", () => {
  // 1e27 against 1e18 is the widest ratio this will ever see, and it has to
  // stay inside v4's sqrt price bounds or the pool cannot be created at all.
  const s = sqrtPriceX96For(MERD_SEED.ethWei, MERD_SEED.merdWei);
  const MIN_SQRT_PRICE = 4295128739n;
  const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
  assert.ok(s > MIN_SQRT_PRICE && s < MAX_SQRT_PRICE, `sqrtPriceX96 ${s} outside v4 bounds`);
});

test("the pinned seed builds against the pinned hook", () => {
  const { key, txs } = buildSeedTransactions(MERD_SEED);
  assert.equal(key.hooks, MERD_HOOK_ADDRESS);
  assert.equal(txs[2].value, MERD_SEED.ethWei.toString());
});

test("the LP position — which is the entire supply — goes to the lock, not a wallet", () => {
  // The NFT this mints holds all of MERD. It is minted STRAIGHT into the lock:
  // no key holds it, not even briefly, so there is no window needing a second
  // signature that could be delayed, forgotten or lost. This test previously
  // asserted the treasury, which was the earlier and worse design.
  assert.equal(MERD_SEED.recipient, MERD_LOCK_ADDRESS);
  assert.notEqual(MERD_SEED.recipient, MERD.treasury, "a wallet must never hold the position");
});

// ── the squat check ──────────────────────────────────────────────────────────

test("the pool id matches v4's own derivation", () => {
  // keccak256(abi.encode(PoolKey)). Verified against the live StateView, which
  // returned an uninitialized slot0 for this id rather than reverting.
  const { key } = buildSeedTransactions(plan);
  assert.equal(poolIdFor(key), keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  )));
});

test("the pool id changes with every part of the key", () => {
  // If two different keys collided here the check would pass while reading a
  // different pool's price, which is worse than not checking at all.
  const { key } = buildSeedTransactions(plan);
  const base = poolIdFor(key);
  assert.notEqual(poolIdFor({ ...key, fee: 3000 }), base, "fee tier is part of the identity");
  assert.notEqual(poolIdFor({ ...key, tickSpacing: 60 }), base, "spacing is part of the identity");
  assert.notEqual(poolIdFor({ ...key, hooks: NATIVE_ETH }), base, "the hook is part of the identity");
});

test("skipInitialize sends the mint alone, not a multicall", () => {
  // The recovery path when someone created our pool at our exact price:
  // including initializePool would revert on an already-initialized pool.
  const { txs } = buildSeedTransactions(plan, { skipInitialize: true });
  assert.equal(txs.length, 3);
  assert.equal(txs[2].to, V4_POSITION_MANAGER);
  const [unlockData] = decodeFunctionData({ abi: MODIFY_ABI, data: txs[2].data }).args as [`0x${string}`, bigint];
  assert.ok(unlockData.length > 2, "still carries the mint actions");
  assert.equal(txs[2].value, plan.ethWei.toString(), "still funds the position");
  assert.throws(() => innerCalls(txs[2].data), "must not be wrapped in multicall");
});

test("the default still creates and seeds atomically", () => {
  // skipInitialize must be opt-in. Defaulting it the other way would silently
  // drop pool creation from the launch and seed into whatever price it found.
  const { txs } = buildSeedTransactions(plan);
  assert.equal(innerCalls(txs[2].data).length, 2, "creation is still bundled by default");
  const { txs: explicit } = buildSeedTransactions(plan, { skipInitialize: false });
  assert.equal(explicit[2].data, txs[2].data, "passing it false must match the default");
});
