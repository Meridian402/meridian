import { test } from "node:test";
import assert from "node:assert/strict";
import { targetRange, bandAmounts, tickDriftPctPerHour, fastFlipCondition, shouldConcentrate, type MemeBand } from "../src/memeGuard.js";
import { vetRow, poolYardstick, type AnalystRow } from "../src/signals/tokenAnalyst.js";
import { ETH_POOLS } from "../src/venues/ethPools.js";

/**
 * The rotor's whole decision is "would a fresh quote sit somewhere else":
 * targetRange must reproduce the builders' placement exactly, and equality
 * with the live range must mean no move (the 08-04 STONK rotation re-minted
 * the identical [116600,118200] because this check did not exist yet).
 */

test("eth-side target matches the proven live placements", () => {
  // CASHCAT rung 1 minted 08-04 at spot 101571 landed [101616,101848].
  assert.deepEqual(targetRange(ETH_POOLS.CASHCAT, 101571, "eth"), { tickLower: 101616, tickUpper: 101848 });
  // STONK starts one spacing up like the live band, but at widthSpacings=4:
  // the original 8-spacing band spread capital across 16% of price and earned
  // $0.18 in a day; halving the width doubles fee density in range.
  assert.deepEqual(targetRange(ETH_POOLS.STONKBROKER, 116480, "eth"), { tickLower: 116600, tickUpper: 117400 });
});

test("token-side target matches the proven live placement", () => {
  // The CASHCAT sell band minted 08-04 at spot 101561 landed [101297,101529].
  assert.deepEqual(targetRange(ETH_POOLS.CASHCAT, 101561, "token"), { tickLower: 101297, tickUpper: 101529 });
});

test("an unmoved market produces the same range: rotation is a no-op", () => {
  const p = ETH_POOLS.STONKBROKER;
  const live = targetRange(p, 116480, "eth");
  const again = targetRange(p, 116489, "eth"); // drift smaller than a spacing
  assert.deepEqual(again, live);
});

test("bandAmounts: below-range bands are pure ETH, above-range pure token", () => {
  const L = 1e20;
  const lower = 101616;
  const upper = 101848;
  const below = bandAmounts(L, lower, upper, Math.sqrt(1.0001 ** (lower - 300)));
  assert.ok(below.eth > 0);
  assert.equal(below.token, 0);
  const above = bandAmounts(L, lower, upper, Math.sqrt(1.0001 ** (upper + 300)));
  assert.equal(above.eth, 0);
  assert.ok(above.token > 0);
  const inside = bandAmounts(L, lower, upper, Math.sqrt(1.0001 ** (lower + 116)));
  assert.ok(inside.eth > 0 && inside.token > 0);
});

test("tick drift measures direction: rising tick = dumping token, in pct/hr", () => {
  const now = 3_600_000 * 10;
  // 300 ticks up over one hour on a fine-spacing pool: ~3%/hr dump.
  const dumping = [
    { t: now - 3_600_000, tick: 101_500 },
    { t: now - 1_800_000, tick: 101_650 },
    { t: now, tick: 101_800 },
  ];
  const d = tickDriftPctPerHour(dumping, now);
  assert.ok(d != null && d > 2.9 && d < 3.2, `expected ~3%/hr, got ${d}`);
  const pumping = dumping.map((s) => ({ t: s.t, tick: 203_300 - s.tick }));
  const p = tickDriftPctPerHour(pumping, now);
  assert.ok(p != null && p < -2.8, `pump must read negative, got ${p}`);
  assert.equal(tickDriftPctPerHour(dumping.slice(2), now), null, "too little history reads null, never zero");
});

test("fast flip fires only on a band filled through its top", () => {
  const band = {
    side: "eth",
    tickUpper: 101848,
    tickLower: 101616,
  } as MemeBand;
  assert.equal(fastFlipCondition(band, 101900), true, "tick past the top = filled, flip");
  assert.equal(fastFlipCondition(band, 101700), false, "in range = earning, never touch");
  assert.equal(fastFlipCondition(band, 101500), false, "below = waiting, the slow clock owns bids");
  assert.equal(fastFlipCondition({ ...band, side: "token" } as MemeBand, 101900), false, "already a sell band: nothing to flip");
});

test("concentration needs a printing leader with a 3x window edge", () => {
  assert.equal(shouldConcentrate(9, 0.5), true, "clear leader takes waiting capital");
  assert.equal(shouldConcentrate(9, 4), false, "close race: capital stays put");
  assert.equal(shouldConcentrate(0.6, 0), false, "a leader below the printing floor moves nothing");
});

test("a knife gets deeper bids: offset override moves the target away from spot", () => {
  const p = ETH_POOLS.CASHCAT;
  const calm = targetRange(p, 102_009, "eth");
  const knife = targetRange(p, 102_009, "eth", p.offsetAbove + 2);
  assert.equal(knife.tickLower - calm.tickLower, 2 * p.tickSpacing);
});

const row = (over: Partial<AnalystRow>): AnalystRow => ({
  poolId: "0xabc",
  token: "0x0000000000000000000000000000000000000001",
  feeTierPct: 1,
  swaps24h: 3000,
  volumeUsd24h: 1_800_000,
  feesUsd24h: 18_000,
  markoutUsd24h: 9_000,
  lpNetUsd24h: 9_000,
  recentMovePct: 1,
  verdict: "fees beat toxicity",
  ...over,
});

test("vetting gate: a STONK-shaped pool clears, every census failure mode is refused", () => {
  assert.equal(vetRow(row({})).ok, true);
  assert.equal(vetRow(row({ verdict: "toxic: fees lose" })).ok, false, "toxic pools never clear");
  assert.equal(vetRow(row({ feeTierPct: 5 })).ok, false, "predator fee tiers never clear");
  assert.equal(vetRow(row({ feeTierPct: 0.05 })).ok, false, "dust tiers cannot pay for toxicity");
  assert.equal(vetRow(row({ swaps24h: 120 })).ok, false, "sparse pools die between scans");
  assert.equal(vetRow(row({ volumeUsd24h: 20_000 })).ok, false, "thin volume: our size becomes the market");
  assert.equal(vetRow(row({ feesUsd24h: 200 })).ok, false, "fee flow below the floor");
  assert.equal(vetRow(row({ recentMovePct: -8 })).ok, false, "dumping on arrival: the knife stays uncaught");
  assert.equal(vetRow(row({ recentMovePct: 22 })).ok, false, "freshly pumped: the retrace stays unbought");
  assert.equal(vetRow(row({ recentMovePct: -3 })).ok, true, "modest drift still clears");
});

test("yardstick ranks fees per unit of liquidity, not raw fees", () => {
  // Same fees, 10x the resting liquidity: 10x worse for a marginal LP.
  const crowded = poolYardstick(10_000, 1e-5, 1e21);
  const empty = poolYardstick(10_000, 1e-5, 1e20);
  assert.ok(empty > crowded * 9.9 && empty < crowded * 10.1);
  assert.equal(poolYardstick(10_000, 1e-5, 0), 0, "zero-liquidity pools score zero, not Infinity");
});

test("bandAmounts reproduces a real mint: rung 1 holds its deposited ETH below range", () => {
  // #462716: 0.1387 ETH (after the 1% haircut) at L computed by the builder.
  // Rebuild the builder's L for the recorded inputs and confirm the geometry
  // returns the deposit when the band sits below range.
  const ethIn = 0.140089984867120901 * 0.99;
  const sA = Math.sqrt(1.0001 ** 101616);
  const sB = Math.sqrt(1.0001 ** 101848);
  const L = ((ethIn * 1e18) * (sA * sB)) / (sB - sA);
  const { eth, token } = bandAmounts(L, 101616, 101848, Math.sqrt(1.0001 ** 101571));
  assert.equal(token, 0);
  assert.ok(Math.abs(eth - ethIn) / ethIn < 1e-6, `geometry must return the deposit, got ${eth} for ${ethIn}`);
});
