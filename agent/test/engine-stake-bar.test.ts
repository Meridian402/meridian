import { test } from "node:test";
import assert from "node:assert/strict";
import { stakeMeetsBar } from "../src/engine/access.js";

const MERD = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // n MERD in wei

test("clears the bar when staked value >= $250 at spot", () => {
  // 100,000 MERD at $0.003 = $300
  assert.equal(stakeMeetsBar(MERD(100_000), 0.003, 250), true);
  // exactly at the bar
  assert.equal(stakeMeetsBar(MERD(250_000), 0.001, 250), true);
});

test("fails below the bar", () => {
  // 50,000 MERD at $0.003 = $150
  assert.equal(stakeMeetsBar(MERD(50_000), 0.003, 250), false);
});

test("an unknown or zero spot price fails closed, regardless of stake size", () => {
  assert.equal(stakeMeetsBar(MERD(10_000_000), 0, 250), false);
  assert.equal(stakeMeetsBar(MERD(10_000_000), NaN, 250), false);
});

test("a zero or negative bar fails closed (misconfiguration is not free access)", () => {
  assert.equal(stakeMeetsBar(MERD(100), 1, 0), false);
  assert.equal(stakeMeetsBar(MERD(100), 1, -5), false);
});

test("price moves change the verdict for the same stake", () => {
  const stake = MERD(100_000);
  assert.equal(stakeMeetsBar(stake, 0.0024, 250), false); // $240
  assert.equal(stakeMeetsBar(stake, 0.0026, 250), true); // $260
});
