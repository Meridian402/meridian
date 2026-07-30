import { test } from "node:test";
import assert from "node:assert/strict";
import { trailingMovePct } from "../src/marketData.js";

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
