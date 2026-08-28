import { test } from "node:test";
import assert from "node:assert/strict";
import { dumpVerdict, dumpExitVerdict, mintRefusal, type DumpReading } from "../src/dumpWatch.js";

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

// ---- the armed step: exit verdict + re-entry vetoes -------------------------

const NOW = 1_700_000_000_000;
function reading(over: Partial<DumpReading>): DumpReading {
  return { symbol: "CASHCAT", at: NOW, swaps: 30, recentSellSharePct: 80, accel: 2.1, velPct: -5, pressure: true, reason: "sell-share 80%, selling 2.1x accelerating, price -5.0%", ...over };
}

test("armed + live pressure + fresh reading -> exit", () => {
  const v = dumpExitVerdict(reading({}), NOW + 60_000, true, 300_000);
  assert.equal(v.act, true);
  assert.match(v.reason, /pressure live/);
});

test("disarmed switch never exits, whatever the tape prints", () => {
  const v = dumpExitVerdict(reading({}), NOW, false, 300_000);
  assert.equal(v.act, false);
  assert.match(v.reason, /disarmed/);
});

test("a stale reading is a dead watch, not a signal -> no exit", () => {
  const v = dumpExitVerdict(reading({}), NOW + 600_000, true, 300_000);
  assert.equal(v.act, false);
  assert.match(v.reason, /stale/);
});

test("no pressure or no reading at all -> no exit", () => {
  assert.equal(dumpExitVerdict(reading({ pressure: false, reason: "calm" }), NOW, true, 300_000).act, false);
  assert.equal(dumpExitVerdict(undefined, NOW, true, 300_000).act, false);
});

test("an active post-exit lockout refuses a mint, and expires", () => {
  const until = NOW + 90 * 60_000;
  const blocked = mintRefusal(until, undefined, NOW + 60_000, 300_000);
  assert.ok(blocked && /lockout/.test(blocked));
  assert.equal(mintRefusal(until, undefined, until + 1, 300_000), null);
});

test("live pressure refuses a mint even with no lockout on file", () => {
  const blocked = mintRefusal(undefined, reading({}), NOW + 60_000, 300_000);
  assert.ok(blocked && /printing dump/.test(blocked));
});

test("calm tape and no lockout -> mint allowed", () => {
  assert.equal(mintRefusal(undefined, reading({ pressure: false, reason: "calm" }), NOW, 300_000), null);
  assert.equal(mintRefusal(undefined, undefined, NOW, 300_000), null);
});

test("a stale pressure reading does not block a mint (the lockout owns that window)", () => {
  assert.equal(mintRefusal(undefined, reading({}), NOW + 600_000, 300_000), null);
});
