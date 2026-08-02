import { test } from "node:test";
import assert from "node:assert/strict";
import { trailingMovePct, trimAndPickBaseline, type PoolSample } from "../src/marketData.js";

// The whole live price feed hung on this function and it was returning null for
// every symbol, on every cycle, for weeks: "live refresh: 0/18" in production,
// dataSource().live false, seed prices on the site, and a swarm that never once
// opened a conversation on live prices. The cause was an ordinary off-by-a-day:
// a 240-minute lookback asked of a feed that only ever holds ~390 minutes of
// regular-session bars, so for the first four hours of every session (and all
// night, and all weekend) no bar sat at or before the window start.

const OPEN = 1_700_000_000; // an arbitrary session open; only deltas matter
const bars = (n: number, priceAt: (i: number) => number | null) => ({
  timestamps: Array.from({ length: n }, (_, i) => OPEN + i * 300), // 5-minute bars
  closes: Array.from({ length: n }, (_, i) => priceAt(i)),
});

test("a full lookback measures exactly that window, not more", () => {
  // 5 hours of bars, 4 hour lookback. The baseline is the bar 48 back (index
  // 11), so the hour before it is priced absurdly: if any of it leaked into the
  // answer the number would be unmissable rather than subtly wrong.
  const { timestamps, closes } = bars(60, (i) => (i <= 10 ? 999 : 100 + i));
  const last = 100 + 59;
  const baseline = 100 + 11;
  assert.equal(trailingMovePct(timestamps, closes, 240), ((last - baseline) / baseline) * 100);
});

test("early in the session it measures since the open instead of refusing", () => {
  // One hour in, asked for four. This returned null before, which is why the
  // feed was dead every morning. "Since the open" is the honest answer that a
  // partial session can support.
  const { timestamps, closes } = bars(12, (i) => 100 + i);
  const pct = trailingMovePct(timestamps, closes, 240);
  assert.ok(pct != null, "a partial session must still produce a quote");
  assert.equal(pct, ((111 - 100) / 100) * 100);
});

test("a single bar is a flat session, not a failure", () => {
  const { timestamps, closes } = bars(1, () => 200);
  assert.equal(trailingMovePct(timestamps, closes, 240), 0);
});

test("gaps in the bars are skipped at both ends", () => {
  // Yahoo nulls out bars with no trades. Neither end may anchor on one.
  const { timestamps, closes } = bars(20, (i) => (i === 0 || i >= 18 ? null : 100 + i));
  const pct = trailingMovePct(timestamps, closes, 240);
  assert.equal(pct, ((117 - 101) / 101) * 100, "anchors on the last and first real closes");
});

test("nothing usable returns null rather than a made-up number", () => {
  assert.equal(trailingMovePct([], [], 240), null);
  assert.equal(trailingMovePct([1, 2], [null, null], 240), null);
  // Mismatched arrays mean the response is not what we think it is.
  assert.equal(trailingMovePct([1, 2, 3], [1, 2], 240), null);
  // A zero baseline would divide by zero and report Infinity as a price move.
  const { timestamps, closes } = bars(4, (i) => (i === 0 ? 0 : 100));
  assert.equal(trailingMovePct(timestamps, closes, 240), null);
});

test("the window is anchored to the last bar, so an off-hours call still works", () => {
  // Wall-clock is irrelevant: these bars are from an arbitrary point in history
  // and the function must still measure the end of that session.
  const { timestamps, closes } = bars(60, (i) => 100 + i);
  assert.equal(trailingMovePct(timestamps, closes, 240), trailingMovePct(timestamps.map((t) => t - 86_400 * 30), closes, 240));
});

// ── pool-price history retention ────────────────────────────────────────────
//
// The second freeze, and the one Merd narrated in public for days: pool
// momentum silently stopped computing because the history trim was tighter
// than the sampling interval, so the baseline sample was evicted a cycle
// before the code went looking for it. The symptom was identical percentages
// standing for 12+ hours while prices drifted, which reads as a data feed
// lying rather than a window being one sample too short.

const LOOKBACK = 240 * 60_000; // the shipped 240-minute momentum window
const TTL = 180_000; // the shipped 3-minute sampling interval

/** Replay the real sampling loop: one sample every ttl, for `minutes`. */
function replay(minutes: number, ttlMs = TTL): { hist: PoolSample[]; now: number } {
  const start = 1_700_000_000_000;
  let hist: PoolSample[] = [];
  let now = start;
  for (let elapsed = 0; elapsed <= minutes * 60_000; elapsed += ttlMs) {
    now = start + elapsed;
    hist.push({ ts: now, priceUsd: 100 + elapsed / 60_000 / 100 });
    hist = trimAndPickBaseline(hist, now, LOOKBACK, ttlMs).kept;
  }
  return { hist, now };
}

test("a baseline survives the trim on every cycle once history is deep enough", () => {
  // Six hours of sampling at the shipped cadence. Past the 4h lookback there
  // must ALWAYS be a baseline; the old 120s margin lost it on most cycles.
  const { hist, now } = replay(360);
  for (let step = 0; step < 20; step++) {
    const t = now + step * TTL;
    const { baseline } = trimAndPickBaseline([...hist, { ts: t, priceUsd: 104 }], t, LOOKBACK, TTL);
    assert.ok(baseline, `no baseline at step ${step}: momentum would silently freeze`);
    assert.ok(t - baseline.ts >= LOOKBACK, "the baseline must sit at or before the window start");
  }
});

test("the retention margin scales with the sampling interval, not a fixed guess", () => {
  // A slower cadence must not reintroduce the bug. At a 10-minute interval the
  // old fixed 120s margin would evict the baseline immediately.
  const slow = 600_000;
  const { hist, now } = replay(360, slow);
  const { baseline } = trimAndPickBaseline([...hist, { ts: now + slow, priceUsd: 104 }], now + slow, LOOKBACK, slow);
  assert.ok(baseline, "a slower sampler must still keep a usable baseline");
});

test("history is still bounded: it does not grow without limit", () => {
  const { hist } = replay(600); // ten hours at 3-minute samples
  const span = hist[hist.length - 1].ts - hist[0].ts;
  assert.ok(span <= LOOKBACK + 2 * TTL + TTL, `retained span ${span}ms should stay near the window`);
  assert.ok(hist.length < 100, `retained ${hist.length} samples, expected the window's worth`);
});

test("early on, with no sample old enough, there is no baseline and no invented number", () => {
  const { hist, now } = replay(30); // half an hour in, far short of the window
  const { baseline } = trimAndPickBaseline(hist, now, LOOKBACK, TTL);
  assert.equal(baseline, undefined, "the equity feed's number must stand until pool history is deep enough");
});
