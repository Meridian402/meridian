import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMintPlan } from "../src/venues/lpPositions.js";

// USDG (currency0, 6dec) / a token (currency1, 18dec), 0.3% tier, spacing 60.
const KEY = {
  currency0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const, // USDG
  currency1: "0x39dBED3a2bd333467115dE45665cC57F813C4571" as const, // PONS
  fee: 3000,
  tickSpacing: 60,
};
const Q96 = 2 ** 96;
const DESK = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe" as const;
const USER = "0x1111111111111111111111111111111111111111" as const;
const BAL0 = 1_000_000000n; // 1000 USDG (6dec)
const BAL1 = 1_000_000000000000000000n; // 1000 token (18dec)

function plan(recipient: `0x${string}`, extra: Partial<Parameters<typeof computeMintPlan>[0]> = {}) {
  return computeMintPlan({ key: KEY, sqrtP: Q96, tick: 0, widthPct: 20, bal0Raw: BAL0, bal1Raw: BAL1, recipient, nowMs: 1_700_000_000_000, ...extra });
}

test("ticks snap to spacing and bracket spot (±10% at tick 0, spacing 60)", () => {
  const p = plan(DESK);
  assert.equal(p.tickLower, -960);
  assert.equal(p.tickUpper, 960);
  assert.equal(Math.abs(p.tickLower % KEY.tickSpacing), 0);
  assert.equal(Math.abs(p.tickUpper % KEY.tickSpacing), 0);
  assert.ok(p.liquidity > 0n);
});

test("amountMax bounds the per-side deposit, not the whole wallet (slippage guard)", () => {
  const p = plan(DESK);
  // Never exceeds the real balance on either side...
  assert.ok(p.amountMax0 <= BAL0, `amountMax0 ${p.amountMax0} must not exceed the balance`);
  assert.ok(p.amountMax1 <= BAL1, `amountMax1 ${p.amountMax1} must not exceed the balance`);
  assert.ok(p.amountMax0 > 0n && p.amountMax1 > 0n);
  // ...and the non-binding side is bounded FAR below the full wallet. The old
  // bug capped both sides at the whole balance, so a mid-inclusion price move
  // could pull the entire side; the ratio guard keeps that from happening.
  assert.ok(p.amountMax1 < BAL1 / 2n, `amountMax1 ${p.amountMax1} should be well under half the wallet, not the full balance`);
});

test("deadline is now + 300s", () => {
  assert.equal(plan(DESK).deadline, BigInt(1_700_000_000 + 300));
});

test("identical inputs are byte-identical (no drift, deterministic)", () => {
  assert.equal(plan(DESK).tx.data, plan(DESK).tx.data);
  assert.equal(plan(DESK).unlockData, plan(DESK).unlockData);
});

test("recipient flows into the calldata: desk and user get DIFFERENT mints to the RIGHT owner", () => {
  const desk = plan(DESK);
  const user = plan(USER);
  // Same range and liquidity (same brain)...
  assert.equal(desk.tickLower, user.tickLower);
  assert.equal(desk.liquidity, user.liquidity);
  // ...but the position is minted to whoever signs.
  assert.notEqual(desk.tx.data, user.tx.data);
  assert.ok(desk.tx.data.toLowerCase().includes(DESK.slice(2).toLowerCase()));
  assert.ok(user.tx.data.toLowerCase().includes(USER.slice(2).toLowerCase()));
});

test("maxUsd cap shrinks the mint vs uncapped", () => {
  const capped = plan(DESK, { maxUsd: 50 }).liquidity;
  const full = plan(DESK).liquidity;
  assert.ok(capped < full, `capped ${capped} should be < full ${full}`);
  assert.ok(capped > 0n);
});

test("the mint always targets the position manager", () => {
  assert.equal(plan(DESK).tx.to.toLowerCase(), "0x58daec3116aae6d93017baaea7749052e8a04fa7");
});

// ---- the dump bid: one-sided USDG bands below a falling price ---------------
import { bidBelowBounds } from "../src/venues/lpPositions.js";

test("bidBelowBounds (token=currency0): band sits strictly below spot, aligned, at depth", () => {
  const b = bidBelowBounds(1000, 60, true, 8, 6);
  assert.ok(b.tickUpper < 1000, "bid must sit below spot in ticks");
  assert.equal(Math.abs(b.tickLower % 60), 0);
  assert.equal(Math.abs(b.tickUpper % 60), 0);
  assert.ok(b.tickLower < b.tickUpper);
  // ~8% depth in ticks is ln(1.08)/ln(1.0001) ~ 770; spacing-aligned below.
  assert.ok(1000 - b.tickUpper >= 720 && 1000 - b.tickUpper <= 900, `depth landed at ${1000 - b.tickUpper} ticks`);
});

test("bidBelowBounds (token=currency1): 'below spot in price' is above in ticks", () => {
  const b = bidBelowBounds(1000, 60, false, 8, 6);
  assert.ok(b.tickLower > 1000, "for a currency1 token the bid sits above in ticks");
  assert.equal(Math.abs(b.tickLower % 60), 0);
  assert.equal(Math.abs(b.tickUpper % 60), 0);
  assert.ok(b.tickUpper > b.tickLower);
});

test("a bid-side plan is single-sided: it pulls only USDG, and the bid budget caps it", () => {
  // Fixture pool: USDG is currency0, token currency1 -> bid is above in ticks.
  const bounds = bidBelowBounds(0, 60, false, 8, 6);
  const p = plan(DESK, { bounds, maxUsd: 200 }); // $100 bid rides as maxUsd 2x
  assert.ok(p.liquidity > 0n);
  assert.equal(p.amountMax1, 0n, "the token side of a resting bid must pull nothing");
  assert.ok(p.amountMax0 > 0n, "the USDG side carries the whole bid");
  // capped at ~$100 of USDG (6 decimals), with the planner's ~1.5% headroom
  assert.ok(p.amountMax0 <= 103_000000n, `amountMax0 ${p.amountMax0} should be ~$100 of USDG`);
});

test("misaligned or inverted explicit bounds are refused outright", () => {
  assert.throws(() => plan(DESK, { bounds: { tickLower: -601, tickUpper: -300 } }));
  assert.throws(() => plan(DESK, { bounds: { tickLower: 300, tickUpper: -300 } }));
});
