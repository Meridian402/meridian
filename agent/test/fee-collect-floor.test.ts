import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCollect, collectOrder } from "../src/memeGuard.js";

/**
 * TWO CALIBRATIONS, ONE LESSON: A COLLECT LADDER MUST FIT THE BAND COUNT.
 *
 * First failure, 2026-08-05 to 2026-08-09, from /api/consistency:
 *
 *   Wed  $108.77 fees   5 collects
 *   Thu  $115.20 fees   2 collects
 *   Fri  $103.30 fees   4 collects
 *   Sat   $41.10 fees   0 collects        <-- both weekend days
 *   Sun   $23.12 fees   0 collects        <-- collected zero times
 *
 * A flat $10 floor applied PER BAND: weekday accrual cleared it, $23 spread
 * across four bands never did, so the harvester switched itself off exactly
 * when earnings were thinnest. The fix added a hard floor plus an age route.
 *
 * Second failure, 2026-08-16: the desk grew to twenty-one thin bands holding
 * about $0.33 each, and the SAME ladder ($2 hard floor, $10 size, 6h age)
 * once again made nothing eligible. Fees rolled forward into each re-quote
 * instead of being realized, and the treasury banked $6.50 against a day of
 * accrual. Rescaled to a $0.50 floor, a $3 size route and a 2h age route:
 * with gas at ~0.02 gwei, frequent small collects beat rare large ones.
 *
 * These tests pin the CURRENT ladder to those numbers. The properties at the
 * bottom are the ones that must survive any future recalibration.
 */

const HOUR = 60 * 60 * 1000;

// ── the size route ──────────────────────────────────────────────────────────

test("an accrual at or above the size route collects immediately", () => {
  assert.equal(shouldCollect(3, 0), true, "exactly the size route still collects");
  assert.equal(shouldCollect(12, 0), true);
  assert.equal(shouldCollect(41, 0), true);
});

test("just under the size route waits for age rather than collecting on size", () => {
  assert.equal(shouldCollect(2.99, 0), false);
  assert.equal(shouldCollect(2.99, HOUR), false, "still inside the age window");
  assert.equal(shouldCollect(2.99, 2 * HOUR), true, "the age route takes it");
});

// ── the thin-band regression this rescale exists to fix ─────────────────────

test("the $0.33 band of the 21-band desk is now reachable, not stranded", () => {
  // Under the old ladder a $0.33 band was below the $2 hard floor forever, so
  // it could never be collected by either route at any age.
  assert.equal(shouldCollect(0.33, 0), false, "not instantly: it is still small");
  assert.equal(shouldCollect(0.33, 24 * HOUR), false, "and it stays below the hard floor");
  // But a band that accrues even modestly now banks on age within hours.
  assert.equal(shouldCollect(0.5, 2 * HOUR), true, "the hard floor is reachable at this size");
  assert.equal(shouldCollect(1.2, 2 * HOUR), true);
});

test("the old weekend numbers all bank now, and quickly", () => {
  const sundayPerBand = 23.12 / 4; // $5.78
  const saturdayPerBand = 41.1 / 4; // $10.28
  assert.equal(shouldCollect(sundayPerBand, 0), true, "what once banked never now collects on sight");
  assert.equal(shouldCollect(saturdayPerBand, 0), true);
});

test("age alone is not enough: dust never pays for its own collect", () => {
  assert.equal(shouldCollect(0.49, 24 * HOUR), false);
  assert.equal(shouldCollect(0.05, 365 * 24 * HOUR), false);
  assert.equal(shouldCollect(0, 999 * HOUR), false);
});

test("the hard floor is the boundary, and it holds on both sides", () => {
  assert.equal(shouldCollect(0.5, 2 * HOUR), true);
  assert.equal(shouldCollect(0.499, 2 * HOUR), false);
});

test("a small accrual that keeps growing collects on whichever route arrives first", () => {
  assert.equal(shouldCollect(4, 0.5 * HOUR), true, "size wins when volume returns mid-wait");
  assert.equal(shouldCollect(1, 3 * HOUR), true, "age wins when it does not");
});

// ── ordering: the daily budget goes to the biggest accrual ──────────────────

test("collects are ordered biggest first so a small band cannot eat the last slot", () => {
  const bands = [
    { tokenId: "a", feesUsd: 2.4 },
    { tokenId: "b", feesUsd: 41.0 },
    { tokenId: "c", feesUsd: 0 },
    { tokenId: "d", feesUsd: 12.5 },
  ];
  assert.deepEqual(collectOrder(bands).map((b) => b.tokenId), ["b", "d", "a", "c"]);
});

test("ordering does not mutate the caller's array", () => {
  const bands = [{ feesUsd: 1 }, { feesUsd: 9 }];
  collectOrder(bands);
  assert.deepEqual(bands.map((b) => b.feesUsd), [1, 9]);
});

test("ordering survives ties and an empty book", () => {
  assert.deepEqual(collectOrder([]), []);
  const tied = [{ tokenId: "x", feesUsd: 5 }, { tokenId: "y", feesUsd: 5 }];
  assert.equal(collectOrder(tied).length, 2);
});

// ── the properties that must survive any recalibration ──────────────────────

test("no accrual above the hard floor can be ignored forever", () => {
  for (const usd of [0.5, 0.9, 1.5, 2.4, 2.99]) {
    assert.equal(shouldCollect(usd, 0), false, `$${usd} should not collect instantly`);
    assert.equal(shouldCollect(usd, 2 * HOUR), true, `$${usd} must eventually be banked`);
  }
});

test("the ladder is monotone: more fees or more age never makes a collect less likely", () => {
  for (const age of [0, HOUR, 2 * HOUR, 10 * HOUR]) {
    for (const [lo, hi] of [[0.4, 0.6], [1, 3], [2.9, 3.1], [5, 50]] as const) {
      if (shouldCollect(lo, age)) assert.equal(shouldCollect(hi, age), true, `$${hi} at ${age}ms must collect if $${lo} does`);
    }
  }
  for (const usd of [0.6, 1, 3, 10]) {
    if (shouldCollect(usd, HOUR)) assert.equal(shouldCollect(usd, 5 * HOUR), true, `$${usd} must still collect when older`);
  }
});
