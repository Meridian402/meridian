import { test } from "node:test";
import assert from "node:assert/strict";
import { ethSideUsd, GAS_RESERVE_ETH } from "../src/lpAllocator.js";

/**
 * Native ETH and WETH became deployable capital on 2026-08-03: native has a
 * real spend path (realBuyStockFromNative) and the guard unwraps WETH every
 * tick, so both belong in the size every real decision is measured at. The
 * arithmetic is what keeps that honest: gas is reserved, and a broken price
 * feed zeroes the ETH side instead of poisoning the whole book.
 */

const closeTo = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test("native counts only above the gas reserve", () => {
  assert.equal(ethSideUsd(GAS_RESERVE_ETH, 0, 2000), 0);
  closeTo(ethSideUsd(GAS_RESERVE_ETH + 0.01, 0, 2000), 20);
});

test("a wallet below the reserve never goes negative", () => {
  assert.equal(ethSideUsd(GAS_RESERVE_ETH / 2, 0, 2000), 0);
  assert.equal(ethSideUsd(0, 0, 2000), 0);
});

test("WETH counts in full: the guard unwraps it next tick", () => {
  closeTo(ethSideUsd(0, 0.02, 2000), 40);
  // and it does not get a second gas reserve subtracted
  closeTo(ethSideUsd(GAS_RESERVE_ETH, 0.02, 2000), 40);
});

test("a bad or missing ETH price zeroes the ETH side, not the book", () => {
  assert.equal(ethSideUsd(1, 1, null), 0);
  assert.equal(ethSideUsd(1, 1, 0), 0);
  assert.equal(ethSideUsd(1, 1, Number.NaN), 0);
  assert.equal(ethSideUsd(1, 1, -5), 0);
});
