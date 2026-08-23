import { test } from "node:test";
import assert from "node:assert/strict";
import { dumpVerdict } from "../src/dumpWatch.js";

// Dump pressure requires ALL THREE: dominant sell-share, accelerating sell
// volume, and price rolling over. Any one missing = no alert.

test("real dump: dominant + accelerating sells + price down -> pressure", () => {
  // recent sells $900 vs $200 buys (82% share), older sells $300 (3x accel), price -6%
  const v = dumpVerdict(900, 200, 300, -6);
  assert.equal(v.pressure, true);
});

test("absorbed selling (heavy but price UP) -> no pressure", () => {
  // the live CASHCAT case: lots of selling but buyers absorb it and price rises
  const v = dumpVerdict(1400, 1200, 700, +8);
  assert.equal(v.pressure, false, "price rising must veto a dump call");
});

test("dominant sells but NOT accelerating -> no pressure", () => {
  const v = dumpVerdict(700, 200, 800, -5); // accel < 1 (recent < older)
  assert.equal(v.pressure, false);
});

test("price down but selling not dominant -> no pressure", () => {
  const v = dumpVerdict(400, 600, 100, -5); // sell-share 40%
  assert.equal(v.pressure, false);
});

test("balanced calm flow -> no pressure, reason 'calm'", () => {
  const v = dumpVerdict(300, 320, 300, +0.2);
  assert.equal(v.pressure, false);
  assert.equal(v.reason, "calm");
});

test("verdict reports share and accel for the reading", () => {
  const v = dumpVerdict(900, 100, 300, -6);
  assert.equal(v.sharePct, 90);
  assert.equal(v.accel, 3);
});
