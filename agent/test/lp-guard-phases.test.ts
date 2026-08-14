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
 * Since 2026-08-14 the clock computes US Eastern time properly (Intl,
 * America/New_York), so the same wall-clock boundaries hold on both sides of
 * a DST change: open 9:30 ET, close 16:00 ET, Friday widen 15:50 ET, Monday
 * settle 10:00 ET. The July instants below are the EDT half (UTC-4); the
 * December block at the bottom is the EST half (UTC-5), the exact case the
 * old fixed-UTC-offset clock would have silently shifted by an hour.
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

// ── the EST half of the year: the case the old fixed-UTC clock got wrong ─────
// 2026-12-09 is a plain Wednesday; EST is UTC-5, so 9:30 ET = 14:30 UTC.

test("December: the open is 14:30 UTC, not 13:30", () => {
  assert.equal(at("2026-12-09T13:30:00Z"), "weekday-off", "13:30 UTC is 8:30 ET in winter, pre-open");
  assert.equal(at("2026-12-09T14:29:00Z"), "weekday-off");
  assert.equal(at("2026-12-09T14:30:00Z"), "weekday-market");
});

test("December: the close is 21:00 UTC, not 20:00", () => {
  assert.equal(at("2026-12-09T20:59:00Z"), "weekday-market", "20:59 UTC is 15:59 ET in winter, still open");
  assert.equal(at("2026-12-09T21:00:00Z"), "weekday-off");
});

test("December Friday hands over to the weekend at 20:50 UTC (15:50 ET)", () => {
  assert.equal(at("2026-12-11T20:49:00Z"), "weekday-market");
  assert.equal(at("2026-12-11T20:50:00Z"), "weekend");
});

test("December Monday settles at 15:00 UTC (10:00 ET)", () => {
  assert.equal(at("2026-12-07T14:59:00Z"), "weekend");
  assert.equal(at("2026-12-07T15:00:00Z"), "weekday-market");
});
