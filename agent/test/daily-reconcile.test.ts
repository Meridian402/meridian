import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSplit } from "../src/dailyReconcile.js";

test("50/50 split of the day's realized profit", () => {
  const s = reconcileSplit(100, 0.5);
  assert.equal(s.skimUsd, 50);
  assert.equal(s.compoundUsd, 50);
});

test("skim + compound always sum to the profit", () => {
  for (const [p, pct] of [[87.33, 0.5], [12.5, 0.7], [1000, 0.4]] as const) {
    const s = reconcileSplit(p, pct);
    assert.ok(Math.abs(s.skimUsd + s.compoundUsd - p) < 0.01, `${p}@${pct}`);
  }
});

test("negative or zero profit skims nothing", () => {
  assert.deepEqual(reconcileSplit(-5, 0.5), { skimUsd: 0, compoundUsd: 0 });
  assert.deepEqual(reconcileSplit(0, 0.5), { skimUsd: 0, compoundUsd: 0 });
});

test("100% skim leaves nothing to compound", () => {
  assert.deepEqual(reconcileSplit(40, 1), { skimUsd: 40, compoundUsd: 0 });
});
