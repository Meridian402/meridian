import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The dials Merd turns himself. The property that matters: his judgment picks
// the value, the WALLS pick what values exist. Everything here is about the
// walls holding against bad input, and about a set actually persisting.

const DIR = mkdtempSync(join(tmpdir(), "merd-knobs-"));
process.env.MERIDIAN_DATA_DIR = DIR;

let knobValue: typeof import("../src/platformKnobs.js").knobValue;
let setKnob: typeof import("../src/platformKnobs.js").setKnob;
let knobsState: typeof import("../src/platformKnobs.js").knobsState;

before(async () => {
  ({ knobValue, setKnob, knobsState } = await import("../src/platformKnobs.js"));
});

test("with no ledger, every dial reads its configured default inside its walls", () => {
  const state = knobsState() as { knobs: Record<string, { value: number; min: number; max: number }> };
  for (const [name, k] of Object.entries(state.knobs)) {
    assert.ok(k.value >= k.min && k.value <= k.max, `${name} default must sit inside its own range`);
  }
});

test("an unknown dial and a non-finite value are refused outright", () => {
  assert.equal(setKnob("packPriceUsd", 1, "r", "merd").ok, false, "pricing is not a dial and must never become one by typo");
  assert.equal(setKnob("scoutBountyUsd", Number.NaN, "r", "merd").ok, false);
  assert.equal(setKnob("scoutBountyUsd", "0.2" as unknown as number, "r", "merd").ok, false);
});

test("a value outside the walls is refused, not clamped on write", () => {
  const out = setKnob("scoutBountyUsd", 25, "generosity", "merd");
  assert.equal(out.ok, false, "a $25 bounty is a drain, the wall must hold");
  assert.match(String(out.error), /between/);
});

test("a valid set persists, reads back, and is attributed", () => {
  assert.equal(setKnob("scoutBountyUsd", 0.15, "board went quiet, richer find fee", "merd").ok, true);
  assert.equal(knobValue("scoutBountyUsd"), 0.15);
  const state = knobsState() as { knobs: Record<string, { lastChange: { by?: string; reason?: string } | null }> };
  assert.equal(state.knobs.scoutBountyUsd.lastChange?.by, "merd");
  assert.match(String(state.knobs.scoutBountyUsd.lastChange?.reason), /quiet/);
});

test("integer dials round rather than store fractions", () => {
  assert.equal(setKnob("scoutMaxPerWalletPerDay", 2.6, "fewer junk runs", "merd").ok, true);
  assert.equal(knobValue("scoutMaxPerWalletPerDay"), 3);
});

test("the last write wins across multiple sets", () => {
  setKnob("scoutMinPayoutUsd", 1.0, "raise it", "merd");
  setKnob("scoutMinPayoutUsd", 0.5, "no, back down", "merd");
  assert.equal(knobValue("scoutMinPayoutUsd"), 0.5);
});
