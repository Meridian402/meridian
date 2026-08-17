import { test } from "node:test";
import assert from "node:assert/strict";
import { venueAdmits, plannedRange } from "../src/memeGuard.js";

/**
 * THE AFTERNOON THE DESK HELD SIXTEEN BANDS IN ONE TOKEN.
 *
 * 2026-08-16, measured from /api/proof:
 *   STONKBROKER 1%   16 bands   $700 working   $0.91 accruing   $0.13 per $100
 *   POOLS 0.25%       1 band     $97 working   $0.54 accruing   $0.56 per $100
 *
 * The compound arm re-enters the best-ranked venue and mints a fresh band
 * each time; the only brake was total headroom, so raising the allowance from
 * $250 to $1,200 let the loop run five times longer. And because a band's
 * range comes from the current tick, a calm tape put every one of them on the
 * SAME range: one position minted sixteen times, splitting one fee stream.
 *
 * These tests pin the rule that makes that impossible.
 */

const band = (valueUsd: number, tickLower = 0, tickUpper = 100) => ({ valueUsd, tickLower, tickUpper });
const ALLOWANCE = 1200;

test("the sixteenth band is refused: the band ceiling stops the loop", () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => band(44, i * 10, i * 10 + 100));
  const v = venueAdmits(sixteen, ALLOWANCE, { tickLower: 999, tickUpper: 1099 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /already 16 bands/);
});

test("four bands is the wall, three still admits", () => {
  const three = [band(50, 0, 100), band(50, 200, 300), band(50, 400, 500)];
  assert.equal(venueAdmits(three, ALLOWANCE, { tickLower: 600, tickUpper: 700 }).ok, true);
  const four = [...three, band(50, 600, 700)];
  assert.equal(venueAdmits(four, ALLOWANCE, { tickLower: 800, tickUpper: 900 }).ok, false);
});

test("no venue may become the book: the share cap bites before the band count", () => {
  // Two fat bands already hold 35% of a $1,200 allowance.
  const fat = [band(210, 0, 100), band(210, 200, 300)];
  const v = venueAdmits(fat, ALLOWANCE, { tickLower: 400, tickUpper: 500 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /venue cap/);
});

test("the duplicate range is refused, which is the specific bug of 08-16", () => {
  const existing = [band(80, 111800, 112600)];
  const dup = venueAdmits(existing, ALLOWANCE, { tickLower: 111800, tickUpper: 112600 });
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already quoted/);
  // A genuinely different rung in the same venue is still welcome.
  assert.equal(venueAdmits(existing, ALLOWANCE, { tickLower: 112600, tickUpper: 113400 }).ok, true);
});

test("an empty venue always admits", () => {
  assert.equal(venueAdmits([], ALLOWANCE, { tickLower: 0, tickUpper: 100 }).ok, true);
});

// ── the range arithmetic must match the mint's own ──────────────────────────

test("plannedRange reproduces the mint's range, and a calm tape repeats it", () => {
  // STONKBROKER: spacing 200, width 4, offset 1.
  const a = plannedRange(111849, 200, 4, 1);
  assert.deepEqual(a, { tickLower: 112000, tickUpper: 112800 });
  // Ten ticks later (a calm tape) the arithmetic lands on the SAME range,
  // which is exactly how sixteen identical bands were minted.
  assert.deepEqual(plannedRange(111859, 200, 4, 1), a);
  // A real move produces a genuinely different rung.
  assert.notDeepEqual(plannedRange(112500, 200, 4, 1), a);
});

test("offset is floored at one spacing above spot", () => {
  const r = plannedRange(1000, 100, 4, 0);
  assert.equal(r.tickLower, 1100, "never at or below spot");
});

// ── the cap breathes with the venue count ────────────────────────────────────

test("a solo venue may take half the allowance; a second venue tightens it to 35%", async () => {
  const { venueShareCapPct } = await import("../src/memeGuard.js");
  assert.equal(venueShareCapPct(0), 50, "empty book: the first venue gets the solo cap");
  assert.equal(venueShareCapPct(1), 50, "one venue holding bands: still solo");
  assert.equal(venueShareCapPct(2), 35, "the moment a second venue exists, diversification is possible and required");
  assert.equal(venueShareCapPct(5), 35);
});

test("the solo cap never drops below the base cap", async () => {
  const { venueShareCapPct } = await import("../src/memeGuard.js");
  assert.equal(venueShareCapPct(1, 40, 30), 40, "a misconfigured solo cap cannot tighten below base");
});

// ── one dump is one lesson ───────────────────────────────────────────────────

test("stops inside the episode window collapse into one strike", async () => {
  const { isNewStopEpisode } = await import("../src/memeGuard.js");
  const MIN = 60_000;
  const t0 = 1_000_000_000;
  assert.equal(isNewStopEpisode(undefined, t0), true, "the first stop always counts");
  assert.equal(isNewStopEpisode(t0, t0 + 5 * MIN), false, "five minutes later: same dump, same lesson");
  assert.equal(isNewStopEpisode(t0, t0 + 29 * MIN), false, "still inside the episode");
  assert.equal(isNewStopEpisode(t0, t0 + 30 * MIN), true, "a spaced repeat is a genuinely new failure");
});
