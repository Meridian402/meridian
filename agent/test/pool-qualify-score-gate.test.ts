import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiedFrom } from "../src/signals/poolQualify.js";

/**
 * THE GATE THE COMMENT PROMISED AND THE CODE NEVER HAD.
 *
 * poolQualify's header has always described three gates: depth, score
 * (fee-positive net of markout), and holdable. Two were implemented. The filter
 * read `deep.filter((p) => p.holdable)`. netPerDayUsd was computed for every
 * pool, attached to every pool, and never once consulted.
 *
 * Real numbers from the 2.5-day markout scan on 2026-08-09, both of which the
 * allocator was listing as deployable:
 *
 *   SNDK/USDG 1%   fees $1,772   markout $4,161   net -$2,389   (-$956/day)
 *   MU/USDG 1%     fees $1,704   markout $2,476   net   -$772   (-$309/day)
 *
 * Deep, holdable, and measurably handing back more than double their fees to
 * informed flow. Depth is exactly what makes a toxic pool inviting.
 */

const pool = (symbol: string, netPerDayUsd: number, depthUsd: number, holdable = true) => ({
  name: `${symbol}/USDG 1%`,
  symbol,
  token: `0x${symbol.toLowerCase().padEnd(40, "0")}` as `0x${string}`,
  fee: 10000,
  tickSpacing: 200,
  depthUsd,
  netPerDayUsd,
  holdable,
});

// The live board on 2026-08-09, converted from the 2.5-day window to per-day.
const LIVE = [
  pool("MU", -308.70, 36_000),
  pool("SNDK", -955.63, 22_000),
  pool("INTC", 116.80, 19_000),
  pool("MSFT", 45.16, 13_000),
  pool("PLTR", 340.54, 6_000),
  pool("AMD", 11.26, 5_000),
  pool("COIN", 24.19, 5_000),
];

test("the two toxic pools no longer qualify", () => {
  const out = qualifiedFrom(LIVE).map((p) => p.symbol);
  assert.ok(!out.includes("SNDK"), "SNDK measured -$956/day and must not be deployable");
  assert.ok(!out.includes("MU"), "MU measured -$309/day and must not be deployable");
});

test("every profitable pool still qualifies, so this is not a blanket tightening", () => {
  const out = qualifiedFrom(LIVE).map((p) => p.symbol);
  assert.deepEqual(out, ["INTC", "MSFT", "PLTR", "AMD", "COIN"]);
});

test("depth does not buy a pass, which is the whole trap", () => {
  // MU had the deepest book on the board and the second worst economics.
  const out = qualifiedFrom([pool("MU", -308.7, 999_999_999)]);
  assert.deepEqual(out, [], "the deepest pool on the board is still a loser");
});

test("an unscored pool is excluded, not admitted by default", () => {
  // lpScore drops pools with no swaps in the window, so netByPool.get() misses
  // and the value defaults to 0. Silence is not evidence that a pool pays.
  assert.deepEqual(qualifiedFrom([pool("NEW", 0, 50_000)]), []);
});

test("holdability is still required, so the new gate did not replace the old one", () => {
  assert.deepEqual(qualifiedFrom([pool("RICH", 500, 50_000, false)]), []);
});

test("both gates must pass together", () => {
  const out = qualifiedFrom([
    pool("GOOD", 100, 10_000, true),
    pool("TOXIC", -100, 10_000, true),
    pool("UNHOLDABLE", 100, 10_000, false),
    pool("BOTHBAD", -100, 10_000, false),
  ]).map((p) => p.symbol);
  assert.deepEqual(out, ["GOOD"]);
});

test("ordering by depth survives, since size still decides among good pools", () => {
  const out = qualifiedFrom([pool("A", 10, 1_000), pool("B", 10, 90_000), pool("C", 10, 40_000)]);
  assert.deepEqual(out.map((p) => p.symbol), ["B", "C", "A"]);
});

test("an empty book qualifies nothing rather than throwing", () => {
  assert.deepEqual(qualifiedFrom([]), []);
});

test("a break-even pool does not qualify: the bar is fee-POSITIVE", () => {
  assert.deepEqual(qualifiedFrom([pool("FLAT", 0.0, 50_000)]), []);
  assert.equal(qualifiedFrom([pool("BARELY", 0.01, 50_000)]).length, 1);
});
