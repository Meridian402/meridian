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

// --- exact vs approx: the two must never be summed into one number ----------
import { receiptGasWei, withdrawnEthWei, weiToUsd } from "../src/attribution.js";

test("exact and approx totals split the same rows; the headline still holds every row", () => {
  const { venues, totals, exact, approx } = aggregateAttribution([
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "band-mint", usdIn: 500, backfilled: true, approx: true }),
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "collect", usdOut: 12, feeUsd: 12, backfilled: true, approx: true }),
    row({ venue: "STONKBROKER", sleeve: "meme", mech: "breaker-withdraw", usdOut: 470, gasUsd: 0.01 }),
    row({ venue: "PONS", mech: "collect", usdOut: 9, feeUsd: 9 }),
  ]);
  assert.equal(totals.ops, 4);
  assert.equal(totals.netUsd, -9.01, "every row, the number the history-with-holes produces");
  assert.equal(exact.ops, 2);
  assert.equal(exact.netUsd, 478.99, "live rows only: what the accountant actually measured");
  assert.equal(approx.ops, 2);
  assert.equal(approx.netUsd, -488, "the reconstructed history, reported on its own line");
  const stonk = venues.find((v) => v.venue === "STONKBROKER")!;
  assert.equal(stonk.hasApprox, true);
  assert.equal(stonk.approxOps, 2);
  assert.equal(stonk.exactNetUsd, 469.99, "per venue too, so a mixed venue can be read either way");
  const pons = venues.find((v) => v.venue === "PONS")!;
  assert.equal(pons.exactNetUsd, pons.netUsd, "a venue watched from its first row reads the same both ways");
});

test("a window with no history rows has exact equal to totals and an empty approx", () => {
  const { totals, exact, approx } = aggregateAttribution([row({ mech: "collect", usdOut: 3, feeUsd: 3 })]);
  assert.deepEqual(exact, totals);
  assert.equal(approx.ops, 0);
  assert.equal(approx.netUsd, 0);
});

test("withdrawn ETH adds the gas back: the balance delta understates what came home", () => {
  const before = 1_000_000_000_000_000_000n; // 1 ETH
  const after = 1_049_990_000_000_000_000n; // +0.05 ETH returned, minus 0.00001 ETH gas
  const gas = 10_000_000_000_000n;
  assert.equal(withdrawnEthWei(before, after, gas), 50_000_000_000_000_000n);
  assert.equal(withdrawnEthWei(after, before, gas), 0n, "a withdraw that returned nothing never reads negative");
});

test("receipt gas and wei pricing", () => {
  assert.equal(receiptGasWei({ gasUsed: 21_000n, effectiveGasPrice: 100_000_000n }), 2_100_000_000_000n);
  assert.equal(receiptGasWei({ gasUsed: 21_000n, effectiveGasPrice: null }), 0n, "a receipt without a price stamps zero, not a crash");
  assert.equal(weiToUsd(500_000_000_000_000_000n, 2000), 1000);
  assert.equal(weiToUsd(500_000_000_000_000_000n, 0), 0, "unknown price is zero so the caller can flag approx");
});
