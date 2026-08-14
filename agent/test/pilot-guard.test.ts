import { test } from "node:test";
import assert from "node:assert/strict";
import { recenterVerdict, floorBreached } from "../src/pilotGuard.js";
import { skimAmountUsd } from "../src/treasurySkim.js";

/**
 * THE PILOT GUARD'S THREE DECISIONS, the pure parts. This guard exists
 * because of one specific afternoon: a position slid out of its band into a
 * falling tape, and the two wrong answers were doing nothing forever and
 * re-centering into the knife. Every test here encodes a rule agreed with
 * the operator on 2026-08-14.
 */

const MIN = 60_000;
const mk = (ticks: number[], now: number, stepMs = 3 * MIN) =>
  ticks.map((tick, i) => ({ t: now - (ticks.length - 1 - i) * stepMs, tick }));

// ── re-center: patience first ────────────────────────────────────────────────

test("no re-center before the minimum out-of-range age, even on a calm tape", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 10 * MIN, now, mk([100, 100, 100, 100], now), true, 45 * MIN);
  assert.equal(v.act, false, "a wick out of range must not trigger a knee-jerk re-band");
});

test("no re-center while the tape is still falling away below the band", () => {
  const now = 1_000_000_000;
  // token-as-currency0, exited below: away = tick down. Tape keeps sliding
  // 300 ticks (~3%) across the window: still the knife, still refuse.
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1000, -1100, -1200, -1300], now), true, 45 * MIN);
  assert.equal(v.act, false);
  assert.match(v.reason, /moving away/);
});

test("re-center once out long enough AND the tape has settled", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1300, -1305, -1298, -1302], now), true, 45 * MIN);
  assert.equal(v.act, true, "sideways tape after the minimum wait is exactly the re-entry the guard exists to allow");
});

test("a recovering tape (coming back toward the band) also allows re-center", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1300, -1250, -1200, -1150], now), true, 45 * MIN);
  assert.equal(v.act, true, "price walking home is stability, not danger");
});

test("orientation flips for a token exited ABOVE its band", () => {
  const now = 1_000_000_000;
  // away is now tick UP; a tape still climbing away must refuse.
  const v = recenterVerdict(now - 60 * MIN, now, mk([1000, 1100, 1200, 1300], now), false, 45 * MIN);
  assert.equal(v.act, false);
});

test("no verdict without tape history: never act blind", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 120 * MIN, now, [], true, 45 * MIN);
  assert.equal(v.act, false);
});

// ── the floor: bounded worst case ────────────────────────────────────────────

test("floor counts value plus uncollected fees, and trips strictly below", () => {
  assert.equal(floorBreached(118, 1, 120), true, "$119 all-in is under a $120 floor");
  assert.equal(floorBreached(118, 3, 120), false, "$121 all-in is not");
  assert.equal(floorBreached(120, 0, 120), false, "exactly at the floor holds");
});

// ── the skim: float target, not events ───────────────────────────────────────

test("skim sweeps only the excess above the float target", () => {
  assert.equal(skimAmountUsd(350, 300, 10), 50);
  assert.equal(skimAmountUsd(305, 300, 10), 0, "sub-minimum excess is not worth a transaction");
  assert.equal(skimAmountUsd(250, 300, 10), 0, "under target sweeps nothing, ever");
});
