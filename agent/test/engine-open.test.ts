import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalStepsFor } from "../src/venues/lpPositions.js";

const TOKEN = "0x39dBED3a2bd333467115dE45665cC57F813C4571" as const; // PONS
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const HIGH = 1n << 200n; // clears both thresholds
const NOW = 1_700_000_000_000;

test("no steps when both allowances already clear the thresholds", () => {
  assert.deepEqual(approvalStepsFor(TOKEN, "PONS", HIGH, HIGH, NOW), []);
});

test("low erc20 allowance yields an erc20 approve to Permit2", () => {
  const steps = approvalStepsFor(TOKEN, "PONS", 0n, HIGH, NOW);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "approve-erc20");
  assert.equal(steps[0].to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(steps[0].value, "0");
});

test("low permit2 allowance yields a permit2 approve to the position manager", () => {
  const steps = approvalStepsFor(TOKEN, "PONS", HIGH, 0n, NOW);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "approve-permit2");
  assert.equal(steps[0].to.toLowerCase(), PERMIT2);
});

test("both low yields both steps, erc20 before permit2", () => {
  const steps = approvalStepsFor(TOKEN, "PONS", 0n, 0n, NOW);
  assert.deepEqual(steps.map((s) => s.kind), ["approve-erc20", "approve-permit2"]);
});

test("threshold is exact: just under trips, at/over does not", () => {
  assert.equal(approvalStepsFor(TOKEN, "PONS", (1n << 128n) - 1n, HIGH, NOW).length, 1);
  assert.equal(approvalStepsFor(TOKEN, "PONS", 1n << 128n, HIGH, NOW).length, 0);
  assert.equal(approvalStepsFor(TOKEN, "PONS", HIGH, (1n << 100n) - 1n, NOW).length, 1);
  assert.equal(approvalStepsFor(TOKEN, "PONS", HIGH, 1n << 100n, NOW).length, 0);
});
