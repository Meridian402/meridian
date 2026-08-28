import { test } from "node:test";
import assert from "node:assert/strict";
import { recenterVerdict, floorBreached, effectiveFloorUsd } from "../src/pilotGuard.js";
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

// ── the asymmetric clocks: patience down, speed up ───────────────────────────

test("an above-band exit re-centers on the fast clock: 15 minutes of settled tape suffice", () => {
  const now = 1_000_000_000;
  // exited above (all USDG, nothing to realize); away is tick UP here.
  // 15 minutes out, tape settled: the fast clock (12m) acts where the slow
  // clock (30m) would still sit earning nothing on a busy pool.
  const flat = mk([1200, 1201, 1199, 1200], now);
  assert.equal(recenterVerdict(now - 15 * MIN, now, flat, false, 12 * MIN, 1.0, 12 * MIN).act, true);
  assert.equal(recenterVerdict(now - 15 * MIN, now, flat, false, 30 * MIN).act, false);
});

test("the fast clock still refuses to chase a tape that is running away upward", () => {
  const now = 1_000_000_000;
  // still pumping away from the band: re-entering would buy the top. Wait.
  const pumping = mk([1200, 1300, 1400, 1500], now);
  assert.equal(recenterVerdict(now - 20 * MIN, now, pumping, false, 12 * MIN, 1.0, 12 * MIN).act, false);
});

// ── the floor: bounded worst case ────────────────────────────────────────────

test("floor bounds principal alone: fees no longer widen the tolerated loss", () => {
  assert.equal(floorBreached(118, 120), true, "$118 of principal is under a $120 floor, whatever fees accrued");
  assert.equal(floorBreached(121, 120), false);
  assert.equal(floorBreached(120, 120), false, "exactly at the floor holds");
  // The bleed-audit change: $118 principal with $3 of accrued fees used to
  // read as $121 all-in and HOLD. Earned income no longer buys drawdown room.
});

test("the floor scales with the deposit, so bigger positions keep proportional protection", () => {
  assert.equal(effectiveFloorUsd(146, 120), 120, "small pilot: the env floor is already the tighter bound");
  assert.equal(effectiveFloorUsd(300, 120), 240, "a $300 position is floored at 80% of deposit, not a fixed $120");
  assert.equal(effectiveFloorUsd(0, 120), 120, "no cost basis falls back to the env floor");
});

// ── the skim: float target, not events ───────────────────────────────────────

test("skim sweeps only the excess above the float target", () => {
  assert.equal(skimAmountUsd(350, 300, 10), 50);
  assert.equal(skimAmountUsd(305, 300, 10), 0, "sub-minimum excess is not worth a transaction");
  assert.equal(skimAmountUsd(250, 300, 10), 0, "under target sweeps nothing, ever");
});

// ── the dump bid: when the desk stands below a fall and gets paid ────────────
import { dumpBidDecision } from "../src/pilotGuard.js";

const BID_BASE = {
  enabled: true,
  lockoutUntil: 2_000_000 as number | undefined,
  now: 1_000_000,
  venueSeats: 0,
  hasActiveBid: false,
  usdgAvailUsd: 500,
  bidUsd: 100,
  bidsToday: 0,
  bidsPerDay: 3,
  stoodDown: false,
};

test("a flattened venue in lockout with budget gets exactly one bid", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE }).act, true);
  assert.equal(dumpBidDecision({ ...BID_BASE, hasActiveBid: true }).act, false, "one bid per lockout");
});

test("no lockout means no bid: this is a dump response, not a standing strategy", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, lockoutUntil: undefined }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, now: 3_000_000 }).act, false, "an expired lockout is no lockout");
});

test("a venue still holding seats is not flat; no bid on top of exposure", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, venueSeats: 1 }).act, false);
});

test("the stand-down, the daily budget, the wallet, and the kill switch all veto", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, stoodDown: true }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, bidsToday: 3 }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, usdgAvailUsd: 60 }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, enabled: false }).act, false);
});
