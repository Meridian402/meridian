import { test } from "node:test";
import assert from "node:assert/strict";
import { ETH_POOLS, poolId, assertRegistryIds, buildNativeOnlyMint, buildTokenOnlyMint } from "../src/venues/ethPools.js";

/**
 * The ETH-quoted pool registry pins each pool's census-measured id next to its
 * parameters, so any single wrong parameter (token, fee, spacing, hooks) is a
 * loud failure here instead of a silent mint into an empty pool. The live
 * encoding itself was proven by eth_call simulation on 2026-08-04 (CASHCAT and
 * STONKBROKER both clean); these tests keep the pure parts honest offline.
 */

test("every registry entry derives its census pool id", () => {
  assertRegistryIds();
  for (const p of Object.values(ETH_POOLS)) {
    assert.equal(poolId(p).toLowerCase(), p.expectedId.toLowerCase());
  }
});

test("a wrong parameter fails the id check", () => {
  const bad = { ...ETH_POOLS.CASHCAT, fee: 3000 };
  assert.notEqual(poolId(bad).toLowerCase(), bad.expectedId.toLowerCase());
});

test("native-only mint builds a range entirely above spot and carries value", () => {
  const p = ETH_POOLS.CASHCAT;
  const tick = 102760;
  const tx = buildNativeOnlyMint(p, tick, 10n ** 16n, "0x0000000000000000000000000000000000000001");
  assert.ok(tx.tickLower > tick, "range must sit above spot so it is single-sided in ETH");
  assert.equal(tx.tickLower % p.tickSpacing, 0);
  assert.equal(tx.tickUpper % p.tickSpacing, 0);
  assert.equal(tx.value, 10n ** 16n);
  assert.ok(tx.liquidity > 0n);
});

test("spacingsAbove pulls the band closer for coarse-spacing pools", () => {
  const p = ETH_POOLS.STONKBROKER;
  const tick = 116494;
  const near = buildNativeOnlyMint(p, tick, 10n ** 17n, "0x0000000000000000000000000000000000000001", 1);
  const far = buildNativeOnlyMint(p, tick, 10n ** 17n, "0x0000000000000000000000000000000000000001");
  assert.ok(near.tickLower > tick, "still entirely above spot");
  assert.equal(far.tickLower - near.tickLower, p.tickSpacing);
});

test("token-only mint builds a range entirely below spot and carries no value", () => {
  const p = ETH_POOLS.CASHCAT;
  const tick = 101571;
  const tx = buildTokenOnlyMint(p, tick, 2000n * 10n ** 18n, "0x0000000000000000000000000000000000000001");
  assert.ok(tx.tickUpper < tick, "range must sit below spot so it is single-sided in the token");
  assert.equal(tx.tickLower % p.tickSpacing, 0);
  assert.equal(tx.tickUpper % p.tickSpacing, 0);
  assert.ok(!("value" in tx), "token mint settles by Permit2 pull, no msg.value");
  assert.ok(tx.liquidity > 0n);
});
