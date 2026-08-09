import { test } from "node:test";
import assert from "node:assert/strict";
import { earningNow } from "../src/memeGuard.js";

/**
 * THE DESK COMPOUNDED INTO A VENUE THAT HAD STOPPED PAYING.
 *
 * The allocation policy's first rule is "COMPOUND into the venue that is
 * measurably printing". Printing was measured by poolEarnWindow, a 24-HOUR
 * cumulative, against MIN_PRINTING_USD of $1. So the test was really "did this
 * venue earn a dollar at any point since this time yesterday", and a pool that
 * stopped an hour ago still read as the best earner in the book.
 *
 * Measured live on 2026-08-09:
 *
 *   15:22Z  working $30   accruing $0.15   fees $393.01
 *   15:30Z  working $92   accruing $0.15   fees $393.01
 *   15:36Z  working $153  accruing $0.00   fees $393.01
 *   15:44Z  working $214  accruing $0.00   fees $393.01
 *
 * Four expansions into STONKBROKER in twenty minutes while it fell 6.82%/hr.
 * Deployed capital went up 7x, accrual went to zero, and the fee counter never
 * moved again. Single-sided ETH bids in a falling market get run through and
 * left out of range holding the token, and the 24-hour memory kept insisting the
 * venue was worth more money.
 *
 * The probe path already guards the same illusion by name ("window remembers a
 * move, tape is calm and heavy"). The compound path had nothing. Cumulative says
 * a venue HAS earned; this says it IS earning, and compounding now needs both.
 */

const MIN = 60 * 1000;
const NOW = 1_786_300_000_000; // fixed: Date.now() must not leak into a test

test("a pool earning right now is a compound target", () => {
  assert.equal(earningNow(NOW, NOW), true);
  assert.equal(earningNow(NOW - 5 * MIN, NOW), true);
  assert.equal(earningNow(NOW - 44 * MIN, NOW), true);
});

test("THE REGRESSION: a pool that stopped an hour ago is not", () => {
  // STONKBROKER's exact situation at 15:44Z: last real accrual before 15:22Z.
  assert.equal(earningNow(NOW - 60 * MIN, NOW), false);
  assert.equal(earningNow(NOW - 6 * 60 * MIN, NOW), false);
  assert.equal(earningNow(NOW - 23 * 60 * MIN, NOW), false, "still inside the 24h window, still not earning");
});

test("a pool never observed earning is never a compound target", () => {
  // Fails CLOSED. This also covers a cold restart with no persisted state:
  // the desk probes rather than compounding blind.
  assert.equal(earningNow(undefined, NOW), false);
});

test("the boundary is exact and closed at the top", () => {
  assert.equal(earningNow(NOW - 45 * MIN, NOW), true, "exactly at the edge still counts");
  assert.equal(earningNow(NOW - 45 * MIN - 1, NOW), false);
});

test("freshness is configurable without touching the rule", () => {
  assert.equal(earningNow(NOW - 90 * MIN, NOW, 120 * MIN), true);
  assert.equal(earningNow(NOW - 90 * MIN, NOW, 30 * MIN), false);
});

test("a clock skew into the future does not disqualify a pool", () => {
  // A timestamp slightly ahead of now must read as earning, not as stale.
  assert.equal(earningNow(NOW + 1000, NOW), true);
});

test("THE INVARIANT: staleness is monotonic, so waiting never re-qualifies", () => {
  // Once a venue goes stale it must stay stale until it actually earns again.
  // If this ever fails, the desk could resume compounding into a dead pool
  // purely by the passage of time.
  let sawFalse = false;
  for (let m = 0; m <= 240; m++) {
    const fresh = earningNow(NOW - m * MIN, NOW);
    if (!fresh) sawFalse = true;
    else assert.ok(!sawFalse, `re-qualified at ${m} minutes stale`);
  }
  assert.ok(sawFalse, "nothing ever went stale, so the gate does nothing");
});
