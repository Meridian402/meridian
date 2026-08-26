import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSplit, cashCollectedSince } from "../src/dailyReconcile.js";

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

// The bleed lesson (2026-08-26): profit is CASH (usdOut), never the token mark.
const SINCE = 1000;
test("reconcile profit counts the USDG cash side of collects, not token marks", () => {
  const rows = [
    // a collect that returned $10 USDG cash but whose feeUsd marked $120 (bleeding token side)
    { ts: 2000, mech: "collect", usdOut: 10, feeUsd: 120 },
    { ts: 3000, mech: "collect", usdOut: 8, feeUsd: 95 },
  ] as { ts: number; mech: string; usdOut: number }[];
  // Real cash profit is $18, not the $215 the old feeUsd basis would have booked.
  assert.equal(cashCollectedSince(rows, SINCE), 18);
});

test("only collect rows since the window count; mints/backfills/old rows excluded", () => {
  const rows = [
    { ts: 500, mech: "collect", usdOut: 100 }, // before window
    { ts: 2000, mech: "collect", usdOut: 5, backfilled: true }, // backfilled
    { ts: 2500, mech: "mint", usdOut: 999 }, // not a collect
    { ts: 3000, mech: "collect", usdOut: 7 }, // counts
  ] as { ts: number; mech: string; usdOut: number; backfilled?: boolean }[];
  assert.equal(cashCollectedSince(rows, SINCE), 7);
});
