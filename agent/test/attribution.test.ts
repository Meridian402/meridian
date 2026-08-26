import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateAttribution, gasUsdOf, churnCycleAdmits, type AttributionRow } from "../src/attribution.js";

const row = (over: Partial<AttributionRow>): AttributionRow => ({
  ts: 1_787_000_000_000,
  sleeve: "usdg",
  venue: "PONS",
  mech: "collect",
  usdIn: 0,
  usdOut: 0,
  feeUsd: 0,
  gasUsd: 0,
  ethUsd: 1900,
  ...over,
});

test("a closed cycle nets exactly: cash out minus cash in minus gas", () => {
  const { venues, totals } = aggregateAttribution([
    row({ mech: "token-buy", usdIn: 75, gasUsd: 0.02 }),
    row({ mech: "mint", usdIn: 73, gasUsd: 0.03 }),
    row({ mech: "collect", usdOut: 4.1, feeUsd: 5.2, gasUsd: 0.01 }),
    row({ mech: "floor-exit", usdOut: 68, gasUsd: 0.02 }),
    row({ mech: "sell", usdOut: 61.5, gasUsd: 0.02 }),
  ]);
  assert.equal(venues.length, 1);
  const v = venues[0];
  assert.equal(v.venue, "PONS");
  assert.equal(v.ops, 5);
  assert.equal(v.netUsd, -14.5, "the venue took $14.50 of real money and the ledger says so");
  assert.equal(v.feeUsd, 5.2, "income stated separately from cash flow");
  assert.equal(totals.netUsd, v.netUsd);
});

test("worst venue prints first: the report is a triage list", () => {
  const { venues } = aggregateAttribution([
    row({ venue: "CASHCAT", mech: "collect", usdOut: 9, feeUsd: 9 }),
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "band-mint", usdIn: 500 }),
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "stop-exit", usdOut: 430 }),
    row({ venue: "PONS", mech: "collect", usdOut: 2, feeUsd: 2 }),
  ]);
  assert.deepEqual(venues.map((v) => v.venue), ["STONKBROKER", "CASHCAT", "PONS"].sort((a, b) => {
    const net: Record<string, number> = { STONKBROKER: -70, CASHCAT: 9, PONS: 2 };
    return net[a] - net[b];
  }));
  assert.equal(venues[0].venue, "STONKBROKER");
  assert.equal(venues[0].netUsd, -70);
});

test("same symbol in two sleeves stays two lines: the cross-sleeve collision is visible", () => {
  const { venues } = aggregateAttribution([
    row({ venue: "STONKBROKER", sleeve: "usdg", mech: "mint", usdIn: 100 }),
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "band-mint", usdIn: 50 }),
  ]);
  assert.equal(venues.length, 2);
});

test("mech breakdown carries the drill-down and approx rows mark the venue", () => {
  const { venues } = aggregateAttribution([
    row({ mech: "collect", usdOut: 3, feeUsd: 3 }),
    row({ mech: "collect", usdOut: 4, feeUsd: 4 }),
    row({ mech: "floor-exit", usdOut: 50, approx: true, backfilled: true }),
  ]);
  const v = venues[0];
  assert.equal(v.byMech["collect"].ops, 2);
  assert.equal(v.byMech["collect"].feeUsd, 7);
  assert.equal(v.byMech["floor-exit"].usdOut, 50);
  assert.equal(v.hasApprox, true, "backfilled history cannot masquerade as measured truth");
});

test("gas math: gasUsed x effectiveGasPrice at the stamped price", () => {
  assert.equal(gasUsdOf(500_000n, 20_000_000n, 1900), (500_000 * 20_000_000 / 1e18) * 1900);
  assert.equal(gasUsdOf(500_000n, undefined, 1900), 0, "no effective price reads as zero, never NaN");
  assert.equal(gasUsdOf(500_000n, 20_000_000n, 0), 0);
});

test("empty window aggregates to clean zeros", () => {
  const { venues, totals } = aggregateAttribution([]);
  assert.equal(venues.length, 0);
  assert.equal(totals.netUsd, 0);
  assert.equal(totals.ops, 0);
});

// THE CHURN-CYCLE BRAKE: a run of small losing recenters must be caught
// within hours, not wait out the slower 7-day realized floor.
test("churn brake: fewer cycles than the threshold always admits", () => {
  const rows = [
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 90 }), // -10 net, but only 1 cycle
  ];
  const v = churnCycleAdmits(rows, "usdg", "PONS", 3, 0);
  assert.equal(v.ok, true);
  assert.equal(v.cycles, 1);
});

test("churn brake: several losing cycles refuse another recenter", () => {
  const rows = [
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 90 }),
    row({ mech: "mint", usdIn: 90 }),
    row({ mech: "recenter-close", usdOut: 80 }),
    row({ mech: "mint", usdIn: 80 }),
    row({ mech: "recenter-close", usdOut: 70 }),
  ];
  const v = churnCycleAdmits(rows, "usdg", "PONS", 3, 0);
  assert.equal(v.ok, false, "three cycles that lost $30 net must not get a fourth");
  assert.equal(v.cycles, 3);
  assert.equal(v.netUsd, -30);
});

test("churn brake: the same cycle count but a real net gain still admits", () => {
  const rows = [
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 100, feeUsd: 5 }),
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 100, feeUsd: 5 }),
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 105, feeUsd: 5 }), // fees genuinely landed as cash
  ];
  const v = churnCycleAdmits(rows, "usdg", "PONS", 3, 0);
  assert.equal(v.ok, true, "three cycles that netted +$5 real cash earned another shot");
  assert.equal(v.netUsd, 5);
});

test("churn brake: a different venue's losing streak never blocks this one", () => {
  const rows = [
    row({ venue: "CASHCAT", mech: "mint", usdIn: 100 }),
    row({ venue: "CASHCAT", mech: "recenter-close", usdOut: 50 }),
    row({ venue: "CASHCAT", mech: "mint", usdIn: 50 }),
    row({ venue: "CASHCAT", mech: "recenter-close", usdOut: 10 }),
    row({ venue: "CASHCAT", mech: "mint", usdIn: 10 }),
    row({ venue: "CASHCAT", mech: "recenter-close", usdOut: 1 }),
  ];
  const v = churnCycleAdmits(rows, "usdg", "PONS", 3, 0);
  assert.equal(v.ok, true);
  assert.equal(v.cycles, 0, "no PONS rows exist at all in this window");
});

test("churn brake: backfilled and approx rows never count toward the streak", () => {
  const rows = [
    row({ mech: "mint", usdIn: 100, backfilled: true }),
    row({ mech: "recenter-close", usdOut: 1, backfilled: true }),
    row({ mech: "mint", usdIn: 100, approx: true }),
    row({ mech: "recenter-close", usdOut: 1, approx: true }),
    row({ mech: "mint", usdIn: 100 }),
    row({ mech: "recenter-close", usdOut: 1 }), // only ONE live cycle
  ];
  const v = churnCycleAdmits(rows, "usdg", "PONS", 3, 0);
  assert.equal(v.ok, true, "only one live, non-backfilled cycle exists; the brake needs 3");
  assert.equal(v.cycles, 1);
});
