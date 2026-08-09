import { test } from "node:test";
import assert from "node:assert/strict";
import { expansionAllowed } from "../src/memeGuard.js";

/**
 * THE DAY THE DESK REFUSED TO TRADE FOR SIXTEEN HOURS.
 *
 * Measured 2026-08-09 from the Railway log, once per pass, all afternoon:
 *
 *   [memeRotor] pass: 0 band(s), $0 working
 *   [memeRotor] expansion budget spent (12/12); entries resume at UTC midnight
 *
 * Every band was stopped out at 08:00Z. The expansion budget was already spent,
 * so the desk sat flat with $1,817 idle and $0 working until UTC midnight, and
 * the rotor announced it every ten minutes without anything being able to act
 * on it.
 *
 * This had happened before. The constant was raised 3 -> 6 -> 12 across two
 * incidents, each time with a comment claiming the new number made all-day cash
 * paralysis impossible. A bigger number never fixes it, because the mistake is
 * the SHAPE of the rule: a throttle on adding exposure was also, silently, a
 * throttle on having any. You cannot add to a position you do not hold.
 *
 * The invariant these tests defend is one sentence, and it should outlive any
 * particular value of the cap:
 *
 *   A FLAT BOOK CAN ALWAYS GET BACK IN.
 */

test("the normal case is unchanged: a working book throttles at the cap", () => {
  assert.equal(expansionAllowed(0, 3), true);
  assert.equal(expansionAllowed(11, 3), true, "one slot left");
  assert.equal(expansionAllowed(12, 3), false, "spent, and the book is working");
  assert.equal(expansionAllowed(50, 3), false);
});

test("the regression: a FLAT book at a spent budget can still re-enter", () => {
  // The exact state on 2026-08-09: 12 spent, zero bands, $1,817 idle.
  assert.equal(expansionAllowed(12, 0), true, "this returned false for sixteen hours");
  assert.equal(expansionAllowed(13, 0), true);
  assert.equal(expansionAllowed(15, 0), true, "last reserve slot");
});

test("the reserve is bounded, not a way around the budget", () => {
  assert.equal(expansionAllowed(16, 0), false, "reserve is spent too");
  assert.equal(expansionAllowed(99, 0), false);
});

test("one band open is enough to be 'working', so the reserve is for flat only", () => {
  assert.equal(expansionAllowed(12, 1), false, "holding anything means the cap applies");
  assert.equal(expansionAllowed(12, 0), true, "holding nothing does not");
});

test("the reserve cannot be reached before the ordinary budget is spent", () => {
  // A flat book still consumes the ordinary budget first; the reserve is not
  // extra capacity handed out from the start of the day.
  for (let spent = 0; spent < 12; spent++) {
    assert.equal(expansionAllowed(spent, 0), true);
    assert.equal(expansionAllowed(spent, 2), true, "same allowance while working");
  }
});

test("THE INVARIANT: no spend count can strand a flat desk while the reserve holds", () => {
  // Written as the property rather than the arithmetic, so that changing either
  // constant cannot quietly reintroduce an all-day outage.
  for (let spent = 0; spent <= 15; spent++) {
    assert.equal(expansionAllowed(spent, 0), true, `flat at ${spent} spent must be able to re-enter`);
  }
});

test("a flat desk is never more restricted than a working one", () => {
  // The failure mode in plain form: it must never be easier to add to a book
  // than to rebuild one from nothing.
  for (let spent = 0; spent <= 30; spent++) {
    for (const open of [1, 2, 4]) {
      if (expansionAllowed(spent, open)) {
        assert.equal(expansionAllowed(spent, 0), true, `working could act at ${spent} but flat could not`);
      }
    }
  }
});
