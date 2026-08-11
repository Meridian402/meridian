import { test } from "node:test";
import assert from "node:assert/strict";
import { stopsInWindow, entrySizeMultiplier, pulseSizeMultiplier, breakerStage } from "../src/memeGuard.js";

/**
 * THE THREE RAILS REBUILT AFTER THREE DAYS OF THE SAME LOSS.
 *
 * The decomposition that forced this (from /api/consistency and the journal):
 *
 *   08-08  fees $41.10   max DD $50.18   DD per $1 fee: 1.2
 *   08-09  fees $38.83   max DD $73.06   DD per $1 fee: 1.9
 *   08-10  fees $14.45   max DD $86.97   DD per $1 fee: 6.0
 *
 * Every stop in the 24h journal window read "maker exit unfilled 33-98min":
 * bids fill when price falls through them, the maker exit never fills in a
 * dead tape, and the desk crosses the spread to leave. Three rails made it
 * worse than it had to be:
 *
 *   1. the bench retired a venue until UTC MIDNIGHT on three stops, so one bad
 *      overnight patch cancelled whole sessions ($109/day deployed vs $14.45)
 *   2. entries went in at FULL SIZE regardless of pulse, so a 25-swap/hr tape
 *      got the same capital as a 500-swap/hr one
 *   3. the breaker's only response was to market-dump the ENTIRE book, which
 *      it did at 04:13Z into the thinnest tape of the day; the mark recovered
 *      $70 within the hour
 */

const H = 60 * 60 * 1000;
const NOW = 1_786_500_000_000;

// ── 1. the bench decays on a rolling window, not the calendar ────────────────

test("three fresh stops still bench the venue", () => {
  const times = [NOW - 30 * 60 * 1000, NOW - 20 * 60 * 1000, NOW - 10 * 60 * 1000];
  assert.equal(stopsInWindow(times, NOW), 3);
  assert.equal(entrySizeMultiplier(stopsInWindow(times, NOW)), 0, "benched, exactly as before");
});

test("THE REGRESSION: pre-dawn stops no longer cancel the afternoon session", () => {
  // The real 08-10 shape: stops at 03:30 and 04:13, read at 13:30 (US open).
  const preDawn = [NOW - 10 * H, NOW - 9.5 * H, NOW - 9.25 * H];
  assert.equal(stopsInWindow(preDawn, NOW), 0, "aged out; the session trades");
  assert.equal(entrySizeMultiplier(0), 1, "at full size");
});

test("the bench releases one stop at a time, not all at once", () => {
  const times = [NOW - 7 * H, NOW - 5 * H, NOW - 1 * H];
  assert.equal(stopsInWindow(times, NOW), 2, "the oldest aged out, the venue is at quarter size");
  assert.equal(entrySizeMultiplier(2), 0.25);
});

test("exactly the window boundary no longer counts", () => {
  assert.equal(stopsInWindow([NOW - 6 * H], NOW), 0);
  assert.equal(stopsInWindow([NOW - 6 * H + 1000], NOW), 1);
});

test("no history means no bench", () => {
  assert.equal(stopsInWindow(undefined, NOW), 0);
  assert.equal(stopsInWindow([], NOW), 0);
});

test("bench monotonicity: waiting can only ever reduce the count", () => {
  const times = [NOW - 5 * H, NOW - 3 * H, NOW - 1 * H];
  let prev = Infinity;
  for (let m = 0; m <= 8 * 60; m += 15) {
    const n = stopsInWindow(times, NOW + m * 60 * 1000);
    assert.ok(n <= prev, `count rose at +${m}min`);
    prev = n;
  }
  assert.equal(prev, 0, "everything eventually ages out");
});

// ── 2. the tape sizes the entry ──────────────────────────────────────────────

test("a live tape gets full size", () => {
  assert.equal(pulseSizeMultiplier(50), 1, "volumeMode's own bar");
  assert.equal(pulseSizeMultiplier(102), 1, "STONKBROKER at yesterday's session pulse");
  assert.equal(pulseSizeMultiplier(548), 1, "CASHCAT at its peak");
});

test("THE REGRESSION: the overnight tape that bled us three nights gets a fraction", () => {
  // 25 swaps/hr is what STONKBROKER did overnight while holding full size.
  assert.equal(pulseSizeMultiplier(25), 0.375);
  assert.ok(pulseSizeMultiplier(30) === 0.5);
});

test("a dead tape gets nothing at all", () => {
  assert.equal(pulseSizeMultiplier(10), 0);
  assert.equal(pulseSizeMultiplier(5), 0);
  assert.equal(pulseSizeMultiplier(0), 0);
});

test("the scale is monotonic and bounded", () => {
  let prev = -1;
  for (let p = 0; p <= 120; p++) {
    const m = pulseSizeMultiplier(p);
    assert.ok(m >= prev, `multiplier fell as pulse rose at ${p}`);
    assert.ok(m >= 0 && m <= 1);
    prev = m;
  }
});

// ── 3. the breaker matches its response to the damage ────────────────────────

test("an ordinary drawdown is stage 0", () => {
  assert.equal(breakerStage(0, 75), 0);
  assert.equal(breakerStage(50, 75), 0);
  assert.equal(breakerStage(74.99, 75), 0);
});

test("THE REGRESSION: the 04:13Z drawdown is stage 1, not a full dump", () => {
  // $87 below the high. Old code market-sold the whole book into a 4am tape.
  // New code halts quoting, withdraws the riskless ETH sides, and leaves the
  // token exits on the stop ladder's clock.
  assert.equal(breakerStage(86.97, 75), 1);
});

test("a catastrophic drawdown still gets the full flatten", () => {
  assert.equal(breakerStage(150, 75), 2);
  assert.equal(breakerStage(400, 75), 2);
});

test("the boundary between stages is exactly twice the limit", () => {
  assert.equal(breakerStage(149.99, 75), 1);
  assert.equal(breakerStage(150, 75), 2);
});

test("stage escalation is monotonic in the drawdown", () => {
  let prev = 0;
  for (let d = 0; d <= 300; d += 5) {
    const s = breakerStage(d, 75);
    assert.ok(s >= prev, `stage fell as drawdown rose at $${d}`);
    prev = s;
  }
});

test("the limit scales the stages, not just stage 1", () => {
  assert.equal(breakerStage(120, 100), 1);
  assert.equal(breakerStage(200, 100), 2);
});

// ── stage 2 confirmation, added 2026-08-11 after the burn false-positive ─────
// The pure stage mapping is unchanged (these tests above still pin it); what
// changed is the IMPURE half: stage 2 now needs two consecutive marks and
// halts on a rolling clock. Those live in noteBookMark and are exercised in
// production rather than faked here; this block pins the one new pure fact.

test("stage 2 still begins at exactly twice the limit after the two-mark change", () => {
  assert.equal(breakerStage(149.99, 75), 1);
  assert.equal(breakerStage(150, 75), 2);
});

// ── the adaptive move clock, added 2026-08-11 at the operator's call ─────────

import { moveCooldownMs } from "../src/memeGuard.js";

test("the clock tightens ONLY for hot-and-calm, the regime that pays", () => {
  assert.equal(moveCooldownMs(500, 1.0), 3 * 60 * 1000, "hot and calm: three minutes");
  assert.equal(moveCooldownMs(57, 2.3), 3 * 60 * 1000, "modestly hot, calm: still fast");
});

test("hot-and-trending gets NO speedup: speed there buys adverse selection", () => {
  assert.equal(moveCooldownMs(500, 7.4), 7 * 60 * 1000, "the exact tape that ate today's bids");
  assert.equal(moveCooldownMs(95, -6.8), 7 * 60 * 1000, "direction does not matter");
});

test("cold tape keeps the slow clock no matter how calm", () => {
  assert.equal(moveCooldownMs(10, 0.5), 7 * 60 * 1000);
  assert.equal(moveCooldownMs(49, 1.0), 7 * 60 * 1000, "just under the volume bar");
  assert.equal(moveCooldownMs(null, null), 7 * 60 * 1000, "unknown tape is a slow tape");
});

test("THE INVARIANT: the adaptive clock only ever tightens, never loosens", () => {
  for (const pulse of [null, 0, 25, 49, 50, 100, 548]) {
    for (const drift of [null, 0, 2, 3.9, 4, 7, -7]) {
      const ms = moveCooldownMs(pulse as number | null, drift as number | null);
      assert.ok(ms <= 7 * 60 * 1000, `slower than the old clock at pulse=${pulse} drift=${drift}`);
      assert.ok(ms >= 3 * 60 * 1000, `faster than the hot-calm floor at pulse=${pulse} drift=${drift}`);
    }
  }
});

// ── the 5% rule, operator's call 2026-08-11 ──────────────────────────────────

import { pctOutOfRange, staleBandAction } from "../src/memeGuard.js";

test("in range is zero percent out, on either edge", () => {
  assert.equal(pctOutOfRange(1500, 1000, 2000), 0);
  assert.equal(pctOutOfRange(1000, 1000, 2000), 0);
  assert.equal(pctOutOfRange(2000, 1000, 2000), 0);
});

test("the tick-to-percent conversion is exact where it matters", () => {
  // 488 ticks is ~5.0% (1.0001^488 - 1). One side of the boundary holds, the
  // other rebalances, and both directions of out-of-range measure the same.
  assert.ok(pctOutOfRange(1000 - 487, 1000, 2000) < 5);
  assert.ok(pctOutOfRange(1000 - 489, 1000, 2000) > 5);
  assert.ok(pctOutOfRange(2000 + 489, 1000, 2000) > 5);
});

test("under five percent holds: the ordinary clocks keep owning the band", () => {
  assert.equal(staleBandAction(0, 500), "hold");
  assert.equal(staleBandAction(4.9, 500), "hold");
  assert.equal(staleBandAction(4.9, 0), "hold", "a quiet pool changes nothing under the line");
});

test("THE RULE: five percent out rebalances now, however long the band has sat", () => {
  assert.equal(staleBandAction(5, 57), "requote");
  assert.equal(staleBandAction(8.2, 500), "requote");
});

test("five percent out in a DEAD pool withdraws to cash instead", () => {
  // Re-quoting into a pool nobody trades is feeding a corpse; the capital
  // comes home and redeploys wherever the tape actually is.
  assert.equal(staleBandAction(5, 9), "withdraw");
  assert.equal(staleBandAction(12, 0), "withdraw");
  assert.equal(staleBandAction(5, 10), "requote", "the pulse bar is a strict floor");
});

test("the action is monotonic in distance: more stale never means more patient", () => {
  const rank = { hold: 0, requote: 1, withdraw: 1 } as const;
  for (const pulse of [0, 9, 10, 57, 500]) {
    let prev = 0;
    for (let pct = 0; pct <= 15; pct += 0.5) {
      const r = rank[staleBandAction(pct, pulse)];
      assert.ok(r >= prev, `went back to holding at ${pct}% pulse=${pulse}`);
      prev = r;
    }
  }
});
