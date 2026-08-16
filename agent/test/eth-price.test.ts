import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseEthUsd } from "../src/venues/uniswapV4.js";

/** The 2026-08-16 incident, as rules: a thin pool's displaced price must not
 *  reprice the book unless the world agrees with it. */

test("normal: pool agrees with history, pool wins without an external call", () => {
  assert.deepEqual(chooseEthUsd(1881, null, 1875), { price: 1881, source: "pool" });
});

test("the incident: pool displaced 4x against history AND the external feed -> external wins", () => {
  assert.deepEqual(chooseEthUsd(484, 1880, 1875), { price: 1880, source: "external" });
});

test("a REAL crash passes: pool and external agree even though history disagrees", () => {
  assert.deepEqual(chooseEthUsd(900, 910, 1875), { price: 900, source: "pool" });
});

test("boot into a displaced pool with no history: external corroboration decides", () => {
  assert.deepEqual(chooseEthUsd(484, 1880, null), { price: 1880, source: "external" });
});

test("everything dark but history: hold the last good price", () => {
  assert.deepEqual(chooseEthUsd(null, null, 1875), { price: 1875, source: "last-good" });
});

test("first boot, nothing but the pool: best effort, take it", () => {
  assert.deepEqual(chooseEthUsd(1881, null, null), { price: 1881, source: "pool" });
});
