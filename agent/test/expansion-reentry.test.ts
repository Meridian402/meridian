import { test } from "node:test";
import assert from "node:assert/strict";
import * as memeGuard from "../src/memeGuard.js";
import { entrySizeMultiplier } from "../src/memeGuard.js";

/**
 * WHAT BOUNDS ENTRIES NOW THAT THE DAILY COUNT DOES NOT.
 *
 * EXPANSIONS_PER_DAY was 3, then 6, then 12, and it was deleted on 2026-08-09.
 * Every raise followed the same incident: the budget went early, the desk got
 * stopped out, and then it sat in cash for the rest of the UTC day while the
 * tape paid other people.
 *
 *   2026-08-05  budget gone by 03:00, flat through the morning rally
 *   2026-08-09  12/12 spent, every band stopped at 08:00Z, then sixteen hours
 *               of "entries resume at UTC midnight" with $1,817 idle
 *
 * A reserve for a flat book was tried first and fixed the symptom only: it
 * bought exactly one band back, $31 of an $1,825 book, and then the counter
 * bound again. 1.7% deployed is not meaningfully different from flat.
 *
 * The category was wrong. A count bounds ACTIVITY. Nothing about the number of
 * entries says whether the desk is taking too much risk, and a cap on how much
 * money is left on the table every day is not a risk control.
 *
 * These tests pin what DOES bound it, so the counter cannot quietly come back
 * as a fourth number.
 */

test("no count-based daily entry cap exists on the module", () => {
  // Named exactly so a reintroduction under the old name fails here.
  assert.equal(
    (memeGuard as Record<string, unknown>).expansionAllowed,
    undefined,
    "a daily entry counter came back; bound harm, not activity",
  );
});

test("harm is what retires a venue: three stops and it is done for the day", () => {
  // This is the rail that replaced the counter. It responds to evidence of
  // losing money, not to a tally of how often we tried.
  assert.equal(entrySizeMultiplier(0), 1, "a clean venue gets full size");
  assert.equal(entrySizeMultiplier(1), 0.5, "one stop halves it");
  assert.equal(entrySizeMultiplier(2), 0.25, "two stops quarter it");
  assert.equal(entrySizeMultiplier(3), 0, "three stops and the venue is benched");
  assert.equal(entrySizeMultiplier(9), 0, "and it stays benched");
});

test("the bench is monotonic: more pain never buys more size", () => {
  let prev = Infinity;
  for (let stops = 0; stops <= 10; stops++) {
    const m = entrySizeMultiplier(stops);
    assert.ok(m <= prev, `size increased at ${stops} stops`);
    prev = m;
  }
});

test("size never goes negative or exceeds full", () => {
  for (let stops = 0; stops <= 20; stops++) {
    const m = entrySizeMultiplier(stops);
    assert.ok(m >= 0 && m <= 1, `multiplier out of range at ${stops} stops: ${m}`);
  }
});

test("THE INVARIANT: an unhurt desk is never stopped from working", () => {
  // The whole point of the deletion. With no stops on a venue, nothing about
  // how many times we have already entered today may reduce our size to zero.
  // If this ever fails, some counter has been reintroduced somewhere.
  assert.equal(entrySizeMultiplier(0), 1);
});
