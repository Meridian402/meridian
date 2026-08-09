import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCollect, collectOrder } from "../src/memeGuard.js";

/**
 * THE WEEKEND THE DESK EARNED AND BANKED NOTHING.
 *
 * Measured from /api/consistency, 2026-08-05 to 2026-08-09:
 *
 *   Wed  $108.77 fees   5 collects
 *   Thu  $115.20 fees   2 collects
 *   Fri  $103.30 fees   4 collects
 *   Sat   $41.10 fees   0 collects        <-- both weekend days
 *   Sun   $23.12 fees   0 collects        <-- collected zero times
 *
 * The cause was a flat $10 floor applied PER BAND. Weekday accrual clears it
 * easily; $23 spread across four bands is under $6 each and never does. So the
 * harvester switched itself off exactly when earnings were thinnest, the
 * treasury skim never ran, and the weekend's fees sat as meme tokens until a
 * stop liquidated them at whatever price it fired at.
 *
 * These tests pin the fix to those real numbers. If the weekday path ever
 * changes, or the weekend path ever stops firing, this suite is where it shows.
 */

const HOUR = 60 * 60 * 1000;

// ── the weekday path must not change ────────────────────────────────────────

test("a weekday-sized accrual collects immediately, with no waiting", () => {
  assert.equal(shouldCollect(12, 0), true);
  assert.equal(shouldCollect(41, 0), true);
  assert.equal(shouldCollect(10, 0), true, "exactly the floor still collects");
});

test("just under the weekday floor waits rather than collecting on size", () => {
  assert.equal(shouldCollect(9.99, 0), false);
  assert.equal(shouldCollect(9.99, HOUR), false);
});

// ── the weekend regression this exists to fix ───────────────────────────────

test("the Sunday band that used to be ignored forever now banks on age", () => {
  // $23.12 across four bands is $5.78 each over a whole day: under the old
  // floor at every moment, so it was never collected once.
  const perBand = 23.12 / 4;
  assert.equal(shouldCollect(perBand, 0), false, "not instantly: it is still small");
  assert.equal(shouldCollect(perBand, 5 * HOUR), false, "and not before it has aged");
  assert.equal(shouldCollect(perBand, 6 * HOUR), true, "but it does get banked");
  assert.equal(shouldCollect(perBand, 18 * HOUR), true);
});

test("the Saturday band banks too", () => {
  const perBand = 41.1 / 4; // $10.28, would have squeaked over only if evenly split
  assert.equal(shouldCollect(perBand, 0), true);
});

test("age alone is not enough: dust never pays for its own collect", () => {
  assert.equal(shouldCollect(1.99, 24 * HOUR), false);
  assert.equal(shouldCollect(0.05, 365 * 24 * HOUR), false);
  assert.equal(shouldCollect(0, 999 * HOUR), false);
});

test("the hard floor is the boundary, and it holds on both sides", () => {
  assert.equal(shouldCollect(2, 6 * HOUR), true);
  assert.equal(shouldCollect(1.999, 6 * HOUR), false);
});

test("a small accrual that keeps growing collects on whichever route arrives first", () => {
  // Size wins when volume returns mid-wait.
  assert.equal(shouldCollect(11, 2 * HOUR), true);
  // Age wins when it does not.
  assert.equal(shouldCollect(3, 7 * HOUR), true);
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

// ── the property that actually matters ──────────────────────────────────────

test("no accrual above the hard floor can be ignored forever", () => {
  // The old rule had a permanent dead zone between the hard floor and the
  // weekday floor. Nothing may live there now, given enough time.
  for (const usd of [2, 3.5, 5.78, 7, 9.99]) {
    assert.equal(shouldCollect(usd, 0), false, `$${usd} should not collect instantly`);
    assert.equal(shouldCollect(usd, 6 * HOUR), true, `$${usd} must eventually be banked`);
  }
});
