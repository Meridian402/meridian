import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The dynamic swap layer: qualification (signals/poolQualify) pushes vetted
 * pools into stockPools, and swap routing consults them after the
 * hand-verified seed. Three properties carry the safety story. The seed can
 * never be overridden by the qualifier, so a hand-verified tier cannot be
 * silently re-routed. Registration replaces the whole set, so a pool that
 * thins or restricts drops out on the next pass instead of lingering
 * tradable. And a cold process (nothing registered yet) trades only the
 * seed, which is the same fail-safe direction poolQualify's own cache takes.
 *
 * Built after the 2026-07-27 depth reconciliation proved the chain's pools
 * deepened ~600x in eleven days, which retired the reason the seed was a
 * hardcoded ceiling.
 *
 * The dynamic example is a FICTIONAL pool on purpose. The first version used
 * MU, and when MU was hand-verified into the seed on 2026-08-17 the test's
 * premise silently inverted. A symbol that can never be seeded cannot rot.
 */
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "dynamic-pools-"));
const { isTradable, tradableSymbols, poolFeePct, registerQualifiedPools, TRADABLE_SYMBOLS } = await import("../src/venues/stockPools.js");

const DYN = "0x00000000000000000000000000000000000000d1" as const;
const AAPL = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" as const;

test("a cold process trades only the seed", () => {
  assert.equal(isTradable("AAPL"), true, "seed symbols are always tradable");
  assert.equal(isTradable("MU"), true, "MU joined the seed 2026-08-17 with its Monday seat");
  assert.equal(isTradable("XYZT"), false, "nothing dynamic before the first qualification pass");
  assert.deepEqual(tradableSymbols(), TRADABLE_SYMBOLS);
});

test("a qualified pool becomes tradable, with its own fee tier", () => {
  registerQualifiedPools([{ symbol: "XYZT", token: DYN, fee: 10000, tickSpacing: 200 }]);
  assert.equal(isTradable("XYZT"), true);
  assert.ok(tradableSymbols().includes("XYZT"));
  assert.equal(poolFeePct("XYZT"), 1, "the registered 1% tier prices the leg");
});

test("the seed outranks the qualifier: a hand-verified tier cannot be re-routed", () => {
  // AAPL's seed entry is the 1% tier. A qualifier pushing a 0.3% AAPL entry
  // must not win, or a scan of one pool could silently trade another, which
  // is the exact scoring-one-buying-another bug configuredPool exists to stop.
  registerQualifiedPools([{ symbol: "AAPL", token: AAPL, fee: 3000, tickSpacing: 60 }]);
  assert.equal(poolFeePct("AAPL"), 1, "seed tier survives a conflicting registration");
});

test("registration replaces the set, so de-qualification propagates", () => {
  registerQualifiedPools([{ symbol: "XYZT", token: DYN, fee: 10000, tickSpacing: 200 }]);
  assert.equal(isTradable("XYZT"), true);
  registerQualifiedPools([]);
  assert.equal(isTradable("XYZT"), false, "a pool that thins or restricts drops out on the next pass");
  assert.equal(isTradable("AAPL"), true, "the seed is untouched by dynamic churn");
});

test("an unknown symbol is refused either way", () => {
  assert.equal(isTradable("NOPE"), false);
  registerQualifiedPools([{ symbol: "XYZT", token: DYN, fee: 10000, tickSpacing: 200 }]);
  assert.equal(isTradable("NOPE"), false);
});
