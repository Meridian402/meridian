import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi } from "viem";
import {
  alignTick,
  v3TargetRange,
  buildV3Mint,
  buildV3Withdraw,
  buildV3Approvals,
  PONS_V3,
  SUSHI_V3,
  MERD_WETH_POOL,
  WETH_ADDR,
} from "../src/venues/v3/adapter.js";

// Real MERD/WETH numbers from the 2026-08-07 discovery reads.
const MERD = "0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8" as const;
const POOL = { token0: WETH_ADDR, token1: MERD, fee: 10000 };
const SPACING = 200;
const LIVE_TICK = 170579;

test("alignTick snaps down onto the spacing grid, negative ticks included", () => {
  assert.equal(alignTick(170579, 200), 170400);
  assert.equal(alignTick(170400, 200), 170400);
  assert.equal(alignTick(-170579, 200), -170600);
});

test("token0 (WETH) bands sit above the live tick, token1 (MERD) bands below", () => {
  const quote = v3TargetRange(LIVE_TICK, SPACING, "token0", 1, 4);
  assert.equal(quote.tickLower, 170600);
  assert.equal(quote.tickUpper, 171400);
  assert.ok(quote.tickLower > LIVE_TICK);

  const sell = v3TargetRange(LIVE_TICK, SPACING, "token1", 1, 4);
  assert.equal(sell.tickUpper, 170200);
  assert.equal(sell.tickLower, 169400);
  assert.ok(sell.tickUpper < LIVE_TICK);
});

test("range bounds are always spacing-aligned, which v3 pools hard-require", () => {
  for (const side of ["token0", "token1"] as const) {
    for (const t of [LIVE_TICK, 1, -1, 199, -37777]) {
      const r = v3TargetRange(t, SPACING, side, 2, 8);
      assert.equal(Math.abs(r.tickLower % SPACING), 0); // abs: JS gives -0 for negative multiples
      assert.equal(Math.abs(r.tickUpper % SPACING), 0);
      assert.ok(r.tickUpper > r.tickLower);
    }
  }
});

const NFPM_ABI = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256, uint128, uint256, uint256)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256, uint256)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256, uint256)",
]);

test("mint calldata round-trips through the canonical NFPM ABI", () => {
  const range = v3TargetRange(LIVE_TICK, SPACING, "token0", 1, 4);
  const tx = buildV3Mint(PONS_V3, POOL, range, 123456789n, 0n, "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe", 1_800_000_000);
  assert.equal(tx.to, PONS_V3.nfpm);
  assert.equal(tx.value, 0n);
  const dec = decodeFunctionData({ abi: NFPM_ABI, data: tx.data });
  assert.equal(dec.functionName, "mint");
  const a = dec.args[0] as { token0: string; fee: number; tickLower: number; amount0Desired: bigint };
  assert.equal(a.token0.toLowerCase(), WETH_ADDR.toLowerCase());
  assert.equal(a.fee, 10000);
  assert.equal(a.tickLower, 170600);
  assert.equal(a.amount0Desired, 123456789n);
});

test("withdraw is decrease-then-collect with fee sweep at max", () => {
  const { decrease, collect } = buildV3Withdraw(PONS_V3, 42n, 999n, "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe", 1_800_000_000);
  const d = decodeFunctionData({ abi: NFPM_ABI, data: decrease.data });
  assert.equal(d.functionName, "decreaseLiquidity");
  const c = decodeFunctionData({ abi: NFPM_ABI, data: collect.data });
  assert.equal(c.functionName, "collect");
  const ca = c.args[0] as { amount0Max: bigint; amount1Max: bigint };
  assert.equal(ca.amount0Max, (1n << 128n) - 1n);
  assert.equal(ca.amount1Max, (1n << 128n) - 1n);
});

test("approvals wrap native into WETH first when token0 is WETH and spent", () => {
  const steps = buildV3Approvals(PONS_V3, POOL, 1000n, 0n);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].to, WETH_ADDR);
  assert.equal(steps[0].value, 1000n); // the wrap carries the ETH
  assert.equal(steps[1].value, 0n); // the approve does not
  const none = buildV3Approvals(PONS_V3, POOL, 0n, 500n);
  assert.equal(none.length, 1); // token1 approve only, no wrap
});

test("the two stacks are distinct and the MERD pool belongs to PONS's", () => {
  assert.notEqual(PONS_V3.factory.toLowerCase(), SUSHI_V3.factory.toLowerCase());
  assert.notEqual(PONS_V3.nfpm.toLowerCase(), SUSHI_V3.nfpm.toLowerCase());
  assert.equal(MERD_WETH_POOL, "0xBFaC28D6B6A258f442639CF20864f655116D57a6");
});
