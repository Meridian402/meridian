import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * phaseOf is the only clock in the LP guard: it alone decides when real
 * capital gets re-tiled tight, widened for the weekend, or deliberately left
 * alone. A boundary off by one minute re-tightens a position into the Friday
 * closing churn, or chases an informed off-hours move the guard was built to
 * sit out. Nothing else exercises these edges, so this file pins them.
 *
 * The code reads getUTCDay/getUTCHours/getUTCMinutes, so every instant below
 * is a fixed UTC instant, against the hardcoded DST-era offsets: open 13:30,
 * close 20:00, Friday widen 19:50, Monday settle 14:00 (all UTC). lpGuard.ts
 * says to revisit those offsets at the November clock change; when the
 * constants move, these instants must be moved with them. That is a feature:
 * this file is the tripwire.
 */

// lpGuard loads its durable anti-churn state through dataPath at import time,
// and dataDir resolves MERIDIAN_DATA_DIR when IT is imported. The env must
// therefore point at a scratch dir before the module graph loads, hence the
// dynamic import below the assignment.
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "lp-guard-phases-"));
const { phaseOf } = await import("../src/lpGuard.js");

// 2026-07-20 through 2026-07-26 is a plain Monday-to-Sunday week; the 27th is
// the following Monday. All helpers below take an ISO instant with a Z.
const at = (iso: string) => phaseOf(new Date(iso));

test("a Wednesday inside market hours is weekday-market", () => {
  assert.equal(at("2026-07-22T15:00:00Z"), "weekday-market");
});

test("a Wednesday outside market hours is weekday-off, morning and evening alike", () => {
  assert.equal(at("2026-07-22T08:00:00Z"), "weekday-off");
  assert.equal(at("2026-07-22T21:00:00Z"), "weekday-off");
});

test("Saturday and Sunday are weekend at any hour, even during would-be market hours", () => {
  assert.equal(at("2026-07-25T00:00:00Z"), "weekend"); // Saturday, first minute
  assert.equal(at("2026-07-25T15:00:00Z"), "weekend"); // Saturday, mid market time on a weekday
  assert.equal(at("2026-07-26T23:59:00Z"), "weekend"); // Sunday, last minute
});

test("the open is inclusive: 13:29 UTC is still off, 13:30 UTC is market", () => {
  assert.equal(at("2026-07-22T13:29:00Z"), "weekday-off");
  assert.equal(at("2026-07-22T13:30:00Z"), "weekday-market");
});

test("the close is exclusive: 19:59 UTC is still market, 20:00 UTC is off", () => {
  assert.equal(at("2026-07-22T19:59:00Z"), "weekday-market");
  assert.equal(at("2026-07-22T20:00:00Z"), "weekday-off");
});

test("Friday hands over to the weekend at 19:50 UTC, ten minutes before the close", () => {
  // The widen must land BEFORE the closing churn, not after it; that is why
  // the weekend starts earlier than the market ends.
  assert.equal(at("2026-07-24T19:49:00Z"), "weekday-market");
  assert.equal(at("2026-07-24T19:50:00Z"), "weekend");
  assert.equal(at("2026-07-24T23:59:00Z"), "weekend");
});

test("until that handover Friday is an ordinary weekday", () => {
  assert.equal(at("2026-07-24T08:00:00Z"), "weekday-off");
  assert.equal(at("2026-07-24T15:00:00Z"), "weekday-market");
});

test("Monday stays weekend through the settle: the 13:30 open does not flip it, 14:00 does", () => {
  // Re-tightening at the raw open would re-tile straight into the Monday
  // gap-and-settle; the guard waits 30 minutes on purpose.
  assert.equal(at("2026-07-27T02:00:00Z"), "weekend");
  assert.equal(at("2026-07-27T13:30:00Z"), "weekend");
  assert.equal(at("2026-07-27T13:59:00Z"), "weekend");
  assert.equal(at("2026-07-27T14:00:00Z"), "weekday-market");
});

test("Monday evening is plain weekday-off: the settle special case covers only the morning", () => {
  assert.equal(at("2026-07-27T21:00:00Z"), "weekday-off");
});

test("seconds never move a boundary: the phase flips on whole minutes only", () => {
  // The machine truncates to minutes; 59.999 seconds must not open the market
  // early on one side or close it early on the other.
  assert.equal(at("2026-07-22T13:29:59.999Z"), "weekday-off");
  assert.equal(at("2026-07-22T19:59:59.999Z"), "weekday-market");
});
