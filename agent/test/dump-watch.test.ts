import { test } from "node:test";
import assert from "node:assert/strict";
import { dumpVerdict, dumpExitVerdict, mintRefusal, switchedOff, crowdingSharePct, type DumpReading, volumeFadeVerdict, fadeRefusal, type BleedSample } from "../src/dumpWatch.js";

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

test("the kill switch understands every way a human says off", () => {
  for (const v of ["off", "OFF", "false", "0", "no", "disabled", " off "]) {
    assert.equal(switchedOff(v), true, `"${v}" must disarm`);
  }
  for (const v of [undefined, "", "on", "true", "1", "armed"]) {
    assert.equal(switchedOff(v as string | undefined), false, `"${v}" must stay armed`);
  }
});

test("crowding share: bigint-exact percent, and an empty pool reads 0 not NaN", () => {
  // The live 2026-08-30 CASHCAT measurement: our two seats vs pool active L.
  const share = crowdingSharePct(27533656313780756n, 4474122429227305951n);
  assert.ok(share > 0.6 && share < 0.63, `expected ~0.615, got ${share}`);
  assert.equal(crowdingSharePct(0n, 6687012301177300157n), 0); // flat in PONS
  assert.equal(crowdingSharePct(123n, 0n), 0); // empty pool: 0, never NaN or Infinity
  assert.equal(crowdingSharePct(500n, 500n), 100); // sole LP owns the whole pool
});


// ── the volume-fade exit (2026-09-01): leave when the flow leaves ────────────

const fadeSample = (minAgo: number, usd: number): BleedSample => ({ ts: FNOW - minAgo * 60_000, px: 1, sellSharePct: 50, usd });
const FNOW = 1_800_000_000_000;
const hourOf = (minStart: number, usd: number): BleedSample[] => [50, 30, 10].map((m) => fadeSample(minStart - (50 - m), usd));

test("two consecutive fading hours from a real base fire the fade", () => {
  const tape = [...hourOf(170, 10_000), ...hourOf(110, 6_000), ...hourOf(50, 3_500)];
  const v = volumeFadeVerdict(tape, FNOW, { dropPct: 30, minWindowUsd: 2000 });
  assert.equal(v.fading, true);
  assert.equal(Math.round(v.refUsd), 10_000, "the base hour is the flow-return reference");
});

test("one fading hour is a dip, not a fade; a quiet-by-nature venue never fades", () => {
  const dip = [...hourOf(170, 10_000), ...hourOf(110, 9_500), ...hourOf(50, 3_000)];
  assert.equal(volumeFadeVerdict(dip, FNOW, { dropPct: 30, minWindowUsd: 2000 }).fading, false);
  const quiet = [...hourOf(170, 1_500), ...hourOf(110, 900), ...hourOf(50, 500)];
  assert.equal(volumeFadeVerdict(quiet, FNOW, { dropPct: 30, minWindowUsd: 2000 }).fading, false, "below the base bar there is nothing to fade from");
});

test("a thin or volume-less tape refuses to judge (old persisted samples lack usd)", () => {
  const thin = [fadeSample(170, 9000), fadeSample(110, 5000), fadeSample(50, 2000)];
  assert.equal(volumeFadeVerdict(thin, FNOW).fading, false);
  const legacy = [...hourOf(170, 10_000), ...hourOf(110, 6_000), ...hourOf(50, 3_500)].map((s) => ({ ts: s.ts, px: s.px, sellSharePct: s.sellSharePct }));
  assert.equal(volumeFadeVerdict(legacy as BleedSample[], FNOW).fading, false);
});

test("the fade lockout blocks re-entry until flow returns or it ages out", () => {
  const lock = { until: FNOW + 60 * 60_000, refUsd: 10_000 };
  assert.ok(fadeRefusal(lock, 2_000, FNOW), "flow still dead: refused");
  assert.equal(fadeRefusal(lock, 7_500, FNOW), null, "flow back to 70% of the base: allowed early");
  assert.equal(fadeRefusal(lock, 2_000, FNOW + 61 * 60_000), null, "lockout aged out");
  assert.equal(fadeRefusal(undefined, 0, FNOW), null);
});
