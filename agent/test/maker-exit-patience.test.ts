import { test } from "node:test";
import assert from "node:assert/strict";
import { makerExitPatienceMs } from "../src/memeGuard.js";

/**
 * THE STOP THAT FIRED BECAUSE NOBODY WAS TRADING.
 *
 * The time-based exit used UTC hours to decide how long to let a maker order
 * work before crossing the spread. That was inferred from a journal in which
 * every timeout-stop had fired between 02:50 and 06:15, which is a fair read of
 * a weekday and wrong on a weekend, when the tape can be dead at any hour.
 *
 * 2026-08-09, both stops fired at 08:00Z:
 *
 *   [memeRotor] stop-loss CASHCAT      reason: maker exit unfilled 35min
 *   [memeRotor] stop-loss STONKBROKER  reason: maker exit unfilled 47min
 *
 * 08:00Z is outside the overnight window, so both got the 30-minute patience.
 * The tape was not busy: CASHCAT's pulse had collapsed from 548 swaps/hr to 35
 * the night before. A maker exit cannot fill in a pool nobody is trading, so the
 * desk waited out a clock it was never going to beat and then paid taker fees to
 * leave on a thin book. Sunday took five of those stops to earn $23 of fees.
 */

const MIN = 60 * 1000;
const NORMAL = 30 * MIN;
const PATIENT = 90 * MIN;

test("the regression: 08:00Z on a dead tape now gets the long patience", () => {
  // The exact conditions of the 2026-08-09 stops: the clock says it is not
  // overnight, and the pulse says nobody is there.
  assert.equal(makerExitPatienceMs(35, false), PATIENT);
});

test("a busy tape in daylight is unchanged, so normal trading is untouched", () => {
  assert.equal(makerExitPatienceMs(548, false), NORMAL, "CASHCAT at its healthy pulse");
  assert.equal(makerExitPatienceMs(149, false), NORMAL, "CASHCAT today");
  assert.equal(makerExitPatienceMs(102, false), NORMAL, "STONKBROKER today");
});

test("the overnight clock rule still applies on its own", () => {
  // The old behaviour has to survive: thin hours are patient regardless of what
  // the pulse says, including when the pulse is healthy.
  assert.equal(makerExitPatienceMs(548, true), PATIENT);
  assert.equal(makerExitPatienceMs(null, true), PATIENT);
});

test("an unknown pulse falls back to the clock rather than guessing", () => {
  assert.equal(makerExitPatienceMs(null, false), NORMAL);
  assert.equal(makerExitPatienceMs(null, true), PATIENT);
});

test("THE SAFETY INVARIANT: never less patient than the clock rule alone", () => {
  // This change may only ever delay a time-based cut, never hasten one. If a
  // future edit makes some input cut FASTER than the old rule would have, that
  // is a behaviour change nobody asked for and it fails here.
  for (const pulse of [null, 0, 1, 25, 49, 50, 51, 100, 548, 10_000]) {
    for (const clock of [true, false]) {
      const old = clock ? PATIENT : NORMAL;
      assert.ok(
        makerExitPatienceMs(pulse as number | null, clock) >= old,
        `pulse=${pulse} clock=${clock} became less patient than before`,
      );
    }
  }
});

test("the threshold is volumeMode's bar, and it is a strict floor", () => {
  assert.equal(makerExitPatienceMs(49, false), PATIENT, "below the bar is thin");
  assert.equal(makerExitPatienceMs(50, false), NORMAL, "at the bar is enough flow to lean on");
});

test("a dead pool is patient, not instant", () => {
  assert.equal(makerExitPatienceMs(0, false), PATIENT);
});

test("patience is bounded: it never exceeds the thin ceiling", () => {
  // No input may invent a third, longer timeout. Unbounded patience on a time
  // stop is just holding forever.
  for (const pulse of [null, 0, 35, 50, 1_000_000]) {
    for (const clock of [true, false]) {
      assert.ok(makerExitPatienceMs(pulse as number | null, clock) <= PATIENT);
    }
  }
});
