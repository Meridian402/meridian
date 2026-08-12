import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFlow, swapToSample } from "../src/signals/flowScan.js";

/**
 * THE USDG FLOW SCANNER: the pure parts, where the bugs would hide.
 *
 * This surfaces the half of the chain the ETH-only discovery never saw. It
 * moves no capital, so its whole job is to be RIGHT about which pools pay: the
 * money leg must be read from the correct side whichever way USDG sorted, and
 * the fees-minus-markout verdict must match the desk's existing bar so a pool
 * this flags means the same thing a pool the desk already scans means.
 */

const Q96 = 2 ** 96;
const sqrtFor = (ratio: number) => BigInt(Math.round(Math.sqrt(ratio) * Q96));
const USDG6 = (usd: number) => BigInt(Math.round(usd * 1e6));

// ── the money leg is read from the USDG side, whichever index it is ──────────

test("USDG as currency0: the money leg is amount0, priced in dollars", () => {
  const s = swapToSample(USDG6(1000), 5_000n, sqrtFor(0.25), true, 100)!;
  assert.equal(s.usd, 1000, "a $1000 USDG-leg swap is $1000 of flow, not scaled by token decimals");
  assert.ok(s.px > 0);
});

test("USDG as currency1: the money leg flips to amount1", () => {
  const s = swapToSample(9_999n, USDG6(2500), sqrtFor(4), false, 100)!;
  assert.equal(s.usd, 2500, "when USDG is token1, the dollars come from amount1");
});

test("the token is priced in USDG the same way regardless of sort side", () => {
  // Same economic price (1 token = 2 USDG) expressed from both sides must land
  // on the same px, or a pool's markout would depend on address ordering.
  const a = swapToSample(USDG6(100), 1n, sqrtFor(2), true, 0)!; // ratio = token1/token0 = token/USDG = 2
  const b = swapToSample(1n, USDG6(100), sqrtFor(0.5), false, 0)!; // ratio = USDG/token = 0.5 -> px = 1/0.5 = 2
  assert.ok(Math.abs(a.px - b.px) < 1e-9, `px must be side-independent (${a.px} vs ${b.px})`);
});

test("a zero-dollar or degenerate swap is dropped, never scored as flow", () => {
  assert.equal(swapToSample(0n, 5n, sqrtFor(1), true, 0), null);
  assert.equal(swapToSample(USDG6(100), 1n, 0n, true, 0), null, "a zero sqrt price is unusable");
});

// ── the scorer matches the desk's fees-minus-markout meaning ─────────────────

const mkSwaps = (n: number, pxSeq: number[], usd = 1000) =>
  pxSeq.map((px, i) => ({ t: i * 60, px, usd, dir: 0 })).slice(0, n);

test("mean-reverting flow: fees beat toxicity, LP net positive", () => {
  // Price wobbles around a level: informed flow gives back what it took, so
  // markout is small and fees dominate. This is the desk's good regime.
  const px = Array.from({ length: 40 }, (_, i) => 1 + 0.001 * Math.sin(i));
  const row = scoreFlow("0xpool", "0xtok", 3000, mkSwaps(40, px), 30)!;
  assert.equal(row.verdict, "fees beat toxicity");
  assert.ok(row.lpNetUsd24h > 0);
  assert.ok(row.feesUsd24h > 0);
});

test("one-directional flow: markout eats the fees, flagged toxic", () => {
  // Price marches one way every swap: whoever traded was right, LPs bleed. This
  // is SNDK/SPCX, the pools our own markout bar already condemns.
  const px = Array.from({ length: 40 }, (_, i) => 1 + 0.01 * i);
  const row = scoreFlow("0xpool", "0xtok", 10000, mkSwaps(40, px), 30)!;
  assert.equal(row.verdict, "toxic: fees lose");
  assert.ok(row.lpNetUsd24h < 0, "a pool that only trends is a trap even with fat fees");
});

test("below the swap floor returns null: too thin to trust", () => {
  assert.equal(scoreFlow("0xp", "0xt", 3000, mkSwaps(10, [1, 1.1, 1, 1.1]), 30), null);
});

test("volume and fees scale with the tier, and both come from the USDG leg", () => {
  const flat = Array.from({ length: 40 }, () => 1);
  const lo = scoreFlow("0xp", "0xt", 500, mkSwaps(40, flat, 1000), 30)!; // 0.05%
  const hi = scoreFlow("0xp", "0xt", 10000, mkSwaps(40, flat, 1000), 30)!; // 1%
  assert.equal(lo.volumeUsd24h, hi.volumeUsd24h, "same flow, same measured volume");
  assert.ok(hi.feesUsd24h > lo.feesUsd24h * 15, "a 20x tier earns ~20x the fee on identical flow");
});

test("recentMovePct reads the trailing quarter, the pump-top guard", () => {
  // Flat for the first three quarters, then a sharp late rise: the score must
  // notice the recent move even though the 24h fee snapshot looks calm.
  const px = [...Array.from({ length: 30 }, () => 1), ...Array.from({ length: 10 }, (_, i) => 1 + 0.02 * (i + 1))];
  const row = scoreFlow("0xp", "0xt", 3000, mkSwaps(40, px), 30)!;
  assert.ok(row.recentMovePct > 5, `a late pump must surface as recent move, got ${row.recentMovePct}%`);
});
