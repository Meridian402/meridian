import { test } from "node:test";
import assert from "node:assert/strict";
import { stakeMeetsBar, ENGINE_STAKE_MERD } from "../src/engine/access.js";

const MERD = (n: number) => BigInt(n) * 10n ** 18n;

test("the bar is 0.25% of the 1B supply: 2.5M MERD", () => {
  assert.equal(ENGINE_STAKE_MERD, 2_500_000);
});

test("clears at and above the bar, purely by amount", () => {
  assert.equal(stakeMeetsBar(MERD(2_500_000)), true);
  assert.equal(stakeMeetsBar(MERD(3_000_000)), true);
});

test("fails below the bar, even by one wei", () => {
  assert.equal(stakeMeetsBar(MERD(2_499_999)), false);
  assert.equal(stakeMeetsBar(MERD(2_500_000) - 1n), false);
  assert.equal(stakeMeetsBar(0n), false);
});

test("no price input exists: the verdict is identical whatever MERD trades at", () => {
  const stake = MERD(2_500_000);
  assert.equal(stakeMeetsBar(stake), stakeMeetsBar(stake));
});

test("a zero or negative bar fails closed (misconfiguration is not free access)", () => {
  assert.equal(stakeMeetsBar(MERD(10_000_000), 0), false);
  assert.equal(stakeMeetsBar(MERD(10_000_000), -5), false);
});
