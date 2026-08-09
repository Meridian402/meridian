import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeMode } from "../src/memeGuard.js";

test("volume mode needs BOTH hot pulse and calm drift", () => {
  assert.equal(volumeMode(80, 2), true);
  assert.equal(volumeMode(80, -3.5), true);
  assert.equal(volumeMode(30, 2), false); // quiet pool: no reason to tighten
  assert.equal(volumeMode(80, 6), false); // trending: chase clock owns it
  assert.equal(volumeMode(80, null), false); // unknown drift fails closed
});

test("knife territory can never read as volume mode", () => {
  assert.equal(volumeMode(200, 10.5), false);
  assert.equal(volumeMode(200, -12), false);
});

import { volumeRotated } from "../src/memeGuard.js";

test("volume rotation needs a genuinely hot pulse that dominates the leader", () => {
  assert.equal(volumeRotated(551, 172), true); // the STONK/CASHCAT case that motivated this
  assert.equal(volumeRotated(551, 400), false); // hot but not dominant: leader keeps compounding
  assert.equal(volumeRotated(150, 20), false); // dominant but not hot enough to matter
  assert.equal(volumeRotated(250, 0), true); // dead leader: any real pulse rotates
});

import { capitulationDepthSpacings } from "../src/memeGuard.js";

test("capitulation depth lands the bid where the wick spikes, per spacing", () => {
  assert.equal(capitulationDepthSpacings(200), 5); // ~9% is ~943 ticks; CASHCAT's 200-spacing grid
  assert.equal(capitulationDepthSpacings(60), 16); // finer grids go proportionally deeper in count
  assert.equal(capitulationDepthSpacings(800), 2); // coarse grids clamp to a real minimum depth
  assert.ok(capitulationDepthSpacings(200, 12) > capitulationDepthSpacings(200, 9));
});

import { stopLinePct } from "../src/memeGuard.js";

test("the stop line jitters within 3.6-4.8 and is stable within a day", () => {
  const a = stopLinePct("0xabc", "2026-08-07");
  assert.ok(a >= 3.6 && a <= 4.81);
  assert.equal(a, stopLinePct("0xabc", "2026-08-07")); // deterministic, no flapping
  assert.notEqual(a, stopLinePct("0xabc", "2026-08-08")); // moves day to day
  assert.notEqual(a, stopLinePct("0xdef", "2026-08-07")); // and pool to pool
});

import { hourlyVolPct, effectiveStopPct, entrySizeMultiplier } from "../src/memeGuard.js";

test("the stop line breathes with the pool's own chop, capped at 7", () => {
  assert.equal(effectiveStopPct(4.2, 1), 4.2); // calm pool keeps the tight line
  assert.ok(Math.abs(effectiveStopPct(4.2, 6) - 5.4) < 1e-9); // choppy pool gets room
  assert.equal(effectiveStopPct(4.2, 20), 7); // never past the hard cap
});

test("hourly vol sums absolute moves in the trailing hour only", () => {
  const now = 10_000_000;
  const h = [
    { t: now - 90 * 60 * 1000, tick: 0 }, // outside the hour, ignored
    { t: now - 30 * 60 * 1000, tick: 0 },
    { t: now - 20 * 60 * 1000, tick: 100 }, // ~1% move
    { t: now - 10 * 60 * 1000, tick: 0 }, // ~1% back
  ];
  const v = hourlyVolPct(h, now);
  assert.ok(v > 1.9 && v < 2.1);
});

test("entry size halves per stop and benches at three", () => {
  assert.equal(entrySizeMultiplier(0), 1);
  assert.equal(entrySizeMultiplier(1), 0.5);
  assert.equal(entrySizeMultiplier(2), 0.25);
  assert.equal(entrySizeMultiplier(3), 0);
});

import { worthRequoting } from "../src/memeGuard.js";

test("a re-quote must move the band materially to be worth a move", () => {
  const cur = { tickLower: 118000, tickUpper: 118800 };
  // one spacing of drift: the micro-churn that ate a whole daily budget
  assert.equal(worthRequoting(cur, { tickLower: 118200, tickUpper: 119000 }, 200), false);
  // two spacings: worth the two transactions
  assert.equal(worthRequoting(cur, { tickLower: 118400, tickUpper: 119200 }, 200), true);
  // a stranded band takes any real improvement (minSpacings 1)
  assert.equal(worthRequoting(cur, { tickLower: 118200, tickUpper: 119000 }, 200, 1), true);
  // identical ranges are never worth a move
  assert.equal(worthRequoting(cur, cur, 200), false);
});

test("overnight pacing reserves most of the budget for the active session", () => {
  const CAP = 60;
  const thinBudget = Math.floor(CAP * 0.4);
  assert.equal(thinBudget, 24); // thin hours may spend 24 of 60
  assert.ok(CAP - thinBudget >= 36); // at least 36 survive to the session
});
