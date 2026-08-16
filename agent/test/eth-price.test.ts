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

// ── the walk, which the first despike did not stop ───────────────────────────

test("THE WALK: 20% steps are refused because trust measures from the anchor", () => {
  // The first fix compared each reading to the LAST ACCEPTED price and then
  // re-anchored to it, so six 20% steps reached a quarter of true value with
  // no external call. Trust now measures from a fixed corroborated anchor, so
  // step two is already outside tolerance and must face the world.
  // Step one (1500, a 20% displacement) is already outside the fast tolerance,
  // so the pool cannot be believed on its own and the anchor holds the line.
  assert.deepEqual(chooseEthUsd(1500, null, 1880), { price: 1880, source: "last-good" });
});

test("a step beyond the fast tolerance falls through to corroboration", () => {
  // 1500 is 20% below the anchor: too far to believe on its own. With the
  // world reachable and disagreeing, the world wins.
  assert.deepEqual(chooseEthUsd(1500, 1880, 1880), { price: 1880, source: "external" });
});

test("small honest moves still take the fast path with no network call", () => {
  assert.deepEqual(chooseEthUsd(1900, null, 1880), { price: 1900, source: "pool" });
  assert.deepEqual(chooseEthUsd(1800, null, 1880), { price: 1800, source: "pool" });
});

test("a real crash still passes: the world agrees with the displaced pool", () => {
  assert.deepEqual(chooseEthUsd(1000, 1010, 1880), { price: 1000, source: "pool" });
});
