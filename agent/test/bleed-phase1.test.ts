import { test } from "node:test";
import assert from "node:assert/strict";
import { pumpChaseQualifies } from "../src/memeGuard.js";

// B1, the bleed audit's biggest finding: the fast chase clock used to run on
// "currentTick < tickLower", which is true for every resting bid. It now
// requires a MEASURED pump inside a window. File convention: negative drift
// = tick falling = price rising (a pump); positive = a dump.

test("a dump never qualifies for the fast clock, at any speed", () => {
  assert.equal(pumpChaseQualifies(0.5), false, "slow dump");
  assert.equal(pumpChaseQualifies(3.7), false, "the 08-18 conveyor regime");
  assert.equal(pumpChaseQualifies(8.7), false, "knife-speed dump");
});

test("no tape evidence, no fast clock", () => {
  assert.equal(pumpChaseQualifies(null), false);
  assert.equal(pumpChaseQualifies(0), false, "flat tape is not a pump");
  assert.equal(pumpChaseQualifies(-1.9), false, "under the 2%/hr bar is noise, not a trend worth chasing");
});

test("a measured pump inside the window chases", () => {
  assert.equal(pumpChaseQualifies(-2), true, "the bar itself qualifies");
  assert.equal(pumpChaseQualifies(-5), true, "the CASHCAT +5%/hr case the chase was built for");
  assert.equal(pumpChaseQualifies(-8), true, "the ceiling itself still qualifies");
});

test("a vertical pump is not chased to its top", () => {
  assert.equal(pumpChaseQualifies(-8.1), false, "past the ceiling the retrace risk owns the decision");
  assert.equal(pumpChaseQualifies(-16.7), false, "the 08-18 catcher-grade knife, mirrored upward");
});
