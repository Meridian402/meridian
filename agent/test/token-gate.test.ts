import { test } from "node:test";
import assert from "node:assert/strict";
import { clearsGate, type ConditionResult } from "../src/deploy/tokenGate.js";

/**
 * The one property that must never regress: the access gate is OR, not AND. A
 * wallet needs ANY ONE of staking 0.1% MERD, holding 0.25% PONS, or holding
 * 0.25% INDEX. Requiring all three would lock out almost everyone, so this pins
 * every combination of the three conditions against the OR rule.
 */

const c = (key: "MERD" | "PONS" | "INDEX", passed: boolean, kind: "hold" | "stake" = "hold"): ConditionResult => ({
  key,
  kind,
  requiredPct: key === "MERD" ? 0.1 : 0.25,
  heldPct: passed ? 1 : 0,
  passed,
});

test("any single condition passing clears the gate", () => {
  assert.equal(clearsGate([c("MERD", true, "stake"), c("PONS", false), c("INDEX", false)]), true, "MERD stake alone clears");
  assert.equal(clearsGate([c("MERD", false, "stake"), c("PONS", true), c("INDEX", false)]), true, "PONS alone clears");
  assert.equal(clearsGate([c("MERD", false, "stake"), c("PONS", false), c("INDEX", true)]), true, "INDEX alone clears");
});

test("failing two of three still clears if the third passes", () => {
  assert.equal(clearsGate([c("MERD", false, "stake"), c("PONS", false), c("INDEX", true)]), true);
});

test("only when ALL conditions fail is the wallet blocked", () => {
  assert.equal(clearsGate([c("MERD", false, "stake"), c("PONS", false), c("INDEX", false)]), false);
});

test("all passing also clears (OR is satisfied, not violated)", () => {
  assert.equal(clearsGate([c("MERD", true, "stake"), c("PONS", true), c("INDEX", true)]), true);
});

test("with only some conditions active (e.g. staking not wired yet), OR still holds", () => {
  // If the MERD staking source is not configured, only PONS and INDEX are in the
  // list. Holding either must still clear.
  assert.equal(clearsGate([c("PONS", true), c("INDEX", false)]), true);
  assert.equal(clearsGate([c("PONS", false), c("INDEX", false)]), false);
});

test("no active conditions means nothing passes (the enabled+configured caller handles dormancy separately)", () => {
  assert.equal(clearsGate([]), false);
});
