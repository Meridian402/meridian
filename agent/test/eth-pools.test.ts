import { test } from "node:test";
import assert from "node:assert/strict";
import { ETH_POOLS, poolId, assertRegistryIds, buildNativeOnlyMint } from "../src/venues/ethPools.js";

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
