import { test } from "node:test";
import assert from "node:assert/strict";

process.env.MERIDIAN_RECENTER_PAYBACK_HOURS = "12";
delete process.env.MERIDIAN_MEME_VENUE_DENYLIST; // exercise the shipped default
const { recenterPaysBack } = await import("../src/pilotGuard.js");
const { venueDenied } = await import("../src/memeGuard.js");

// ── the payback gate: churn must earn its keep ───────────────────────────────

test("a re-center runs only when measured fees repay the churn in the horizon", () => {
  assert.equal(recenterPaysBack(4, 0.5, 12), true, "$6 of expected fees repays $4 of churn");
  assert.equal(recenterPaysBack(4, 0.33, 12), false, "$3.96 does not");
  assert.equal(recenterPaysBack(4, 4 / 12, 12), true, "exactly at breakeven still runs");
});

test("a venue that banked nothing earns no churn", () => {
  assert.equal(recenterPaysBack(0.25, 0, 12), false, "$0/hr never repays anything");
});

test("the PONS case: a real earner clears the gate easily", () => {
  // ~$18/day banked -> $0.75/hr; a $430 seat in a 0.3% pool costs ~$1.80 to churn.
  assert.equal(recenterPaysBack(1.8, 0.75, 12), true);
});

// ── the denylist: what we know but cannot prove to the gate ──────────────────

test("POOLS is denied by default, in any casing", () => {
  assert.equal(venueDenied("POOLS"), true);
  assert.equal(venueDenied("pools"), true);
});

test("earners are not denied", () => {
  assert.equal(venueDenied("STONKBROKER"), false);
  assert.equal(venueDenied("PONS"), false);
});
