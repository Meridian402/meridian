import { test } from "node:test";
import assert from "node:assert/strict";
import { bleedVerdict, type BleedSample } from "../src/dumpWatch.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** Build a series of samples ending at NOW, one every 2 minutes. */
function series(prices: number[], sellPct: number | number[]): BleedSample[] {
  const n = prices.length;
  return prices.map((px, i) => ({
    ts: NOW - (n - 1 - i) * 2 * MIN,
    px,
    sellSharePct: Array.isArray(sellPct) ? sellPct[i] : sellPct,
  }));
}

/** A grinding decline: mostly-down steps from `from` to `to` over `n` samples. */
function grind(from: number, to: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = from + ((to - from) * i) / (n - 1);
    // small up-wiggle every 5th step so it is a grind, not a monotone line
    out.push(i % 5 === 4 ? base * 1.002 : base);
  }
  return out;
}

const opts = { bleedPct: 6, minHours: 3, windowHours: 8, negShare: 0.55, sellPct: 50, minSamples: 20 };

test("the CASHCAT scenario fires: -10% grind over 5h with sellers present", () => {
  const v = bleedVerdict(series(grind(1.0, 0.9, 150), 58), NOW, opts);
  assert.equal(v.bleeding, true);
  assert.ok(v.drawdownPct <= -6, `drawdown ${v.drawdownPct}`);
  assert.ok(v.reason.startsWith("slow bleed"));
});

test("a spike that recovered does NOT fire: down 8% then back near the peak", () => {
  const down = grind(1.0, 0.92, 60);
  const up = grind(0.92, 0.99, 60);
  const v = bleedVerdict(series([...down, ...up], 55), NOW, opts);
  assert.equal(v.bleeding, false);
});

test("a buyer-led decline does NOT fire (avg sell-share below the bar)", () => {
  const v = bleedVerdict(series(grind(1.0, 0.9, 150), 35), NOW, opts);
  assert.equal(v.bleeding, false);
});

test("a short window never fires, whatever it shows", () => {
  // 25 samples * 2min = 50 minutes, well under minHours
  const v = bleedVerdict(series(grind(1.0, 0.85, 25), 70), NOW, opts);
  assert.equal(v.bleeding, false);
  assert.match(v.reason, /too short|too thin/);
});

test("a thin window never fires", () => {
  const v = bleedVerdict(series(grind(1.0, 0.8, 10), 70), NOW, opts);
  assert.equal(v.bleeding, false);
  assert.match(v.reason, /too thin/);
});

test("a flat market is steady", () => {
  const flatPrices = Array.from({ length: 150 }, (_, i) => 1 + (i % 3) * 0.0005);
  const v = bleedVerdict(series(flatPrices, 45), NOW, opts);
  assert.equal(v.bleeding, false);
});

test("samples older than the window are ignored", () => {
  // an ancient crash followed by a recent flat market must not fire
  const ancient: BleedSample[] = grind(2.0, 1.0, 50).map((px, i) => ({ ts: NOW - 20 * 3_600_000 + i * 2 * MIN, px, sellSharePct: 80 }));
  const recent = series(Array.from({ length: 100 }, () => 1.0), 40);
  const v = bleedVerdict([...ancient, ...recent], NOW, opts);
  assert.equal(v.bleeding, false);
});
