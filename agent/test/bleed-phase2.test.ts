import { test } from "node:test";
import assert from "node:assert/strict";

// Production env, pinned (dry runs wear prod's clothes).
process.env.MERIDIAN_VENUE_REALIZED_FLOOR_USD = "25";
process.env.MERIDIAN_VENUE_REALIZED_DAYS = "7";
const { venueRealizedAdmits } = await import("../src/attribution.js");
const { boardRegimeMultiplier } = await import("../src/memeGuard.js");
const { sleeveBoardRed } = await import("../src/pilotGuard.js");

// ── the realized-P&L admission gate ──────────────────────────────────────────

test("a venue under the admission floor is refused, whatever the tape says", () => {
  assert.equal(venueRealizedAdmits(-25.01).ok, false, "past the floor: no new capital");
  assert.equal(venueRealizedAdmits(-300).ok, false, "the STONKBROKER case");
});

test("small scars and profits admit", () => {
  assert.equal(venueRealizedAdmits(-25).ok, true, "the floor itself still admits: one small stop is not a ban");
  assert.equal(venueRealizedAdmits(-10).ok, true);
  assert.equal(venueRealizedAdmits(0).ok, true);
  assert.equal(venueRealizedAdmits(42).ok, true);
});

test("the refusal explains itself: the window has to roll off", () => {
  const r = venueRealizedAdmits(-80);
  assert.match(r.reason, /admission floor/);
  assert.match(r.reason, /window/);
});

// ── the board gauge: ten red pools are one trade ─────────────────────────────
// Convention: positive drift = dump.

test("a calm or mixed board takes no size off", () => {
  assert.equal(boardRegimeMultiplier([0.5, -1, 2, 1]), 1);
  assert.equal(boardRegimeMultiplier([8, -3, 0, -1, 1]), 1, "one pool dumping is that pool's problem, not the board's");
});

test("a board red in the median scales entries down and then off", () => {
  assert.equal(boardRegimeMultiplier([3, 3, 3]), 0.5, "median 3%/hr: half size everywhere");
  assert.equal(boardRegimeMultiplier([4, 5, 6]), 0, "median past the calm bar: no entries at all");
  assert.equal(boardRegimeMultiplier([8, 9, 10, 2, 12]), 0, "the 08-18 shape: most of the board dumping");
});

test("too little evidence judges nothing: per-pool gates stand alone", () => {
  assert.equal(boardRegimeMultiplier([]), 1);
  assert.equal(boardRegimeMultiplier([9, null]), 1);
  assert.equal(boardRegimeMultiplier([null, null, null, 9, 9]), 1, "two measured pools are not a board");
});

// ── the sleeve board: seats falling together are one move ────────────────────
// Convention here is price drift: negative = falling.

test("two hands-off pools falling past the bar blocks re-centers sleeve-wide", () => {
  assert.equal(sleeveBoardRed([-2.5, -3.1, 0.4]), true);
  assert.equal(sleeveBoardRed([-2, -2]), true, "the bar itself counts");
});

test("one falling pool or a shallow drift is not a red board", () => {
  assert.equal(sleeveBoardRed([-5, 0.2, 1.1]), false, "one pool falling is that pool's own wait");
  assert.equal(sleeveBoardRed([-1.9, -1.9, -1.9]), false, "shallow drift everywhere is chop, not a move");
  assert.equal(sleeveBoardRed([]), false);
});
