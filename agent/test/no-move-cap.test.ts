import { test } from "node:test";
import assert from "node:assert/strict";
import { worthRequoting } from "../src/memeGuard.js";

/**
 * WHAT BOUNDS RE-QUOTING NOW THAT THE DAILY TALLY DOES NOT.
 *
 * DAILY_MOVE_CAP was 24, then 36, then 60, and it was deleted on 2026-08-09
 * along with CHASE_RESERVE_MOVES and THIN_HOURS_MOVE_SHARE, both of which only
 * existed to escape it.
 *
 * Its own comment had already conceded the argument twice: "the cap is a
 * runaway brake, not a pacing tool", and "the breaker now bounds the money, not
 * the moves". Both true, and both reasons it should not have existed. A runaway
 * brake that fires on a tally cannot tell a runaway from a good day.
 *
 *   2026-08-05  at 24, a trending day froze the desk out of range by evening
 *   2026-08-06  at 36, a whipsaw night stalled it by morning
 *   2026-08-09  at 60, hit at 16:37Z: "holding new quotes until UTC midnight"
 *               with bands in range and earning, on a venue moving 9.32%/hr
 *
 * Re-quoting is not a risk. Re-quoting is HOW A BAND EARNS: it keeps liquidity
 * centred on the price. Cap it and the desk stops following the tape, the bands
 * drift out of range, and the book holds inventory until midnight. The cap did
 * not bound losses, it guaranteed them.
 *
 * worthRequoting is the control that replaced it, and it always was the real
 * one: a move happens when it is WORTH it, not when there is budget left.
 */

const SPACING = 200;
const band = (lower: number, upper: number) => ({ tickLower: lower, tickUpper: upper });

test("a move that barely improves the quote is refused, whatever the day's count", () => {
  // One spacing of drift is not worth two transactions.
  assert.equal(worthRequoting(band(1000, 2000), band(1200, 2200), SPACING, 2), false);
});

test("a move that materially improves the quote is taken", () => {
  assert.equal(worthRequoting(band(1000, 2000), band(1400, 2400), SPACING, 2), true);
  assert.equal(worthRequoting(band(1000, 2000), band(5000, 6000), SPACING, 2), true);
});

test("THE REGRESSION: a stranded band may always follow the price", () => {
  // An out-of-range band earns nothing where it is, so any improvement is worth
  // having and the caller passes a threshold of 1. Under the old cap this was
  // the case that got frozen out: bands stranded 5-7% under a rising market
  // with the budget spent. It must never depend on a tally again.
  assert.equal(worthRequoting(band(1000, 2000), band(1200, 2200), SPACING, 1), true);
});

test("the gate measures the LARGER of the two edge shifts", () => {
  // A band whose upper edge moves far but lower edge barely moves is still a
  // material re-quote; taking the min would let real moves slip through.
  assert.equal(worthRequoting(band(1000, 2000), band(1000, 2600), SPACING, 2), true);
  assert.equal(worthRequoting(band(1000, 2000), band(400, 2000), SPACING, 2), true);
});

test("an identical target is never worth a move", () => {
  assert.equal(worthRequoting(band(1000, 2000), band(1000, 2000), SPACING, 1), false);
  assert.equal(worthRequoting(band(1000, 2000), band(1000, 2000), SPACING, 2), false);
});

test("direction does not matter: following price up or down are the same decision", () => {
  const up = worthRequoting(band(1000, 2000), band(1600, 2600), SPACING, 2);
  const down = worthRequoting(band(1000, 2000), band(400, 1400), SPACING, 2);
  assert.equal(up, down);
  assert.equal(up, true);
});

test("THE INVARIANT: merit alone decides, so the same move is judged the same all day", () => {
  // The whole point of the deletion. This function takes no counter, no clock
  // and no budget, so a re-quote worth making at 00:01 UTC is still worth making
  // at 23:59. If a tally ever creeps back in, it cannot come through here.
  const decide = () => worthRequoting(band(1000, 2000), band(1800, 2800), SPACING, 2);
  const first = decide();
  for (let i = 0; i < 500; i++) assert.equal(decide(), first, `decision drifted on repeat ${i}`);
  assert.equal(first, true);
});

test("the spacing scales the bar, so a wide-tick pool is not judged on tick counts", () => {
  // 400 ticks is two spacings at 200 and less than one at 1000.
  assert.equal(worthRequoting(band(1000, 2000), band(1400, 2400), 200, 2), true);
  assert.equal(worthRequoting(band(1000, 2000), band(1400, 2400), 1000, 2), false);
});
