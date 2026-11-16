import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFlow } from "../src/signals/flowScan.js";
import { WATCHED, markouts, hourRows, seatView, windowSum, watchFlags, type WatchSwap, type LedgerHour } from "../src/signals/poolWatch.js";

/**
 * THE POOL WATCH: the pure parts.
 *
 * It moves no capital, so its job is to be RIGHT about what a pool paid its
 * LPs hour by hour: the markout must be the same number the desk's own scorer
 * produces, every dollar of flow must land in exactly one hour, a quiet hour
 * must read as quiet and not as missing, and the flags must fire on the things
 * that have cost the desk before (a dump, LPs leaving, volume dying).
 */

const H = 3600;
const T0 = 1_800_000_000 - (1_800_000_000 % H); // an exact hour boundary

function tape(n: number, seed = 7): WatchSwap[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: WatchSwap[] = [];
  let px = 1;
  let t = T0;
  for (let i = 0; i < n; i++) {
    t += Math.floor(rnd() * 400) + 5;
    px *= 1 + (rnd() - 0.5) * 0.04;
    out.push({ t, usd: Math.round(rnd() * 900) + 10, px, sqrtP: Math.sqrt(1e12 / px), L: 5e17, sender: `0x${(i % 9).toString(16)}` });
  }
  return out;
}

test("markouts add up to exactly what the desk's own scorer reports", () => {
  const swaps = tape(400);
  const ours = markouts(swaps).reduce((a, b) => a + b, 0);
  const desk = scoreFlow("0xpool", "0x0000000000000000000000000000000000000001", 10000, swaps.map((x) => ({ t: x.t, px: x.px, usd: x.usd, dir: 0 })), 5);
  assert.ok(desk);
  assert.ok(Math.abs(ours - desk!.markoutUsd24h) < 0.011, `ours ${ours} vs desk ${desk!.markoutUsd24h}`);
});

test("a swap with nothing after it inside thirty minutes has no markout yet", () => {
  const swaps: WatchSwap[] = [
    { t: T0, usd: 100, px: 1, sqrtP: 1, L: 1, sender: "a" },
    { t: T0 + 60, usd: 100, px: 1.02, sqrtP: 1, L: 1, sender: "b" },
    { t: T0 + 60 + 1801, usd: 100, px: 1.1, sqrtP: 1, L: 1, sender: "c" },
  ];
  const m = markouts(swaps);
  assert.equal(m[1], 0, "the next trade is past the horizon");
  assert.equal(m[2], 0, "the last swap has nothing after it");
});

test("every dollar of flow lands in exactly one hour, and fees are flow times the LP fee", () => {
  const swaps = tape(600);
  const from = T0, to = Math.ceil(swaps[swaps.length - 1].t / H) * H + H;
  const rows = hourRows(swaps, 0.01, from, to);
  const total = swaps.reduce((a, s) => a + s.usd, 0);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.volumeUsd, 0) - total) < 1e-6);
  assert.equal(rows.reduce((a, r) => a + r.swaps, 0), swaps.length);
  for (const r of rows) {
    assert.ok(Math.abs(r.feesUsd - r.volumeUsd * 0.01) < 1e-9);
    assert.ok(Math.abs(r.lpNetUsd - (r.feesUsd - r.markoutUsd)) < 1e-9);
    assert.ok(r.pxLow <= r.pxOpen && r.pxOpen <= r.pxHigh && r.pxLow <= r.pxClose && r.pxClose <= r.pxHigh);
  }
  const mk = markouts(swaps).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.markoutUsd, 0) - mk) < 1e-6, "markout is conserved across the hour split");
});

test("a markout is booked to the hour its swap happened in, not the hour it resolved in", () => {
  const swaps: WatchSwap[] = [
    { t: T0 + 3000, usd: 500, px: 1.0, sqrtP: 1, L: 1, sender: "a" },
    { t: T0 + 3300, usd: 1000, px: 1.05, sqrtP: 1, L: 1, sender: "b" }, // a buy at 55 minutes
    { t: T0 + H + 600, usd: 10, px: 1.2, sqrtP: 1, L: 1, sender: "c" }, // the price it ran to, 15 minutes later
  ];
  const rows = hourRows(swaps, 0.01, T0, T0 + 2 * H);
  assert.ok(rows[0].markoutUsd > 100, `the first hour carries the loss, got ${rows[0].markoutUsd}`);
  assert.equal(rows[1].markoutUsd, 0);
});

test("a quiet hour is a row of zero flow at the last known price, not a hole", () => {
  const swaps: WatchSwap[] = [
    { t: T0 + 100, usd: 50, px: 2, sqrtP: 3, L: 7, sender: "a" },
    { t: T0 + 3 * H + 100, usd: 70, px: 2.5, sqrtP: 4, L: 9, sender: "b" },
  ];
  const rows = hourRows(swaps, 0.01, T0 - 2 * H, T0 + 4 * H);
  assert.deepEqual(rows.map((r) => r.hourStart), [T0, T0 + H, T0 + 2 * H, T0 + 3 * H], "hours before anything is known are skipped");
  assert.equal(rows[1].swaps, 0);
  assert.equal(rows[1].volumeUsd, 0);
  assert.equal(rows[1].pxClose, 2);
  assert.equal(rows[1].liquidity, 7);
  assert.equal(rows[3].pxOpen, 2, "the next active hour opens at the carried price");
  assert.equal(rows[3].pxClose, 2.5);
  const carried = hourRows([], 0.01, T0, T0 + H, { px: 9, sqrtP: 1, L: 3 });
  assert.equal(carried.length, 1);
  assert.equal(carried[0].pxClose, 9, "a carry from the previous run keeps a silent pool on the ledger");
});

test("seatView: a bigger seat is a bigger share, and an empty pool is all ours", () => {
  const sqrtP = Math.sqrt(1e12 / 0.5);
  const small = seatView(250, 1.25, sqrtP, 4e17, true, 1);
  const big = seatView(1000, 1.25, sqrtP, 4e17, true, 1);
  assert.ok(small.sharePct > 0 && small.sharePct < big.sharePct && big.sharePct < 100);
  assert.ok(big.depth2pctUsd > 0);
  assert.ok(Math.abs(seatView(1000, 1.25, sqrtP, 0, true, 1).sharePct - 100) < 1e-9);
  const narrow = seatView(1000, 1.05, sqrtP, 4e17, true, 1);
  assert.ok(narrow.sharePct > big.sharePct, "the same dollars in a tighter band are more liquidity");
  assert.deepEqual(seatView(1000, 1.25, 0, 4e17, true, 1), { sharePct: 0, depth2pctUsd: 0 });
});

function hour(i: number, o: Partial<LedgerHour> = {}): LedgerHour {
  const px = o.pxClose ?? 1;
  return { ts: (T0 + (i + 1) * H) * 1000, kind: "hour", id: "0xpool", symbol: "T", quote: "USDG", feePct: 1, enterable: true, hour: "", hourStart: T0 + i * H, swaps: 20, traders: 8, volumeUsd: 5000, feesUsd: 50, markoutUsd: 10, lpNetUsd: 40, pxOpen: px, pxClose: px, pxHigh: px, pxLow: px, sqrtPClose: 1, liquidity: 1e18, depth2pctUsd: 2000, seatSharePct: 2, seatNetUsd: 0.8, ...o };
}

test("windowSum totals the last N hours and reads the move and the range off them", () => {
  const rows = [hour(0, { pxOpen: 1, pxClose: 1.1, pxHigh: 1.2, pxLow: 0.9 }), hour(1, { pxOpen: 1.1, pxClose: 1.3, pxHigh: 1.35, pxLow: 1.1 })];
  const w = windowSum(rows, 24);
  assert.equal(w.hours, 2);
  assert.equal(w.volumeUsd, 10000);
  assert.equal(w.lpNetUsd, 80);
  assert.ok(Math.abs(w.movePct - 30) < 1e-9);
  assert.ok(Math.abs(w.rangePct - 50) < 1e-9);
  assert.equal(windowSum(rows, 1).volumeUsd, 5000);
  assert.equal(windowSum([], 24).hours, 0);
});

test("watchFlags: silent on a calm pool, loud on a dump, an LP exit, dying volume and a losing day", () => {
  const calm = Array.from({ length: 30 }, (_, i) => hour(i));
  assert.deepEqual(watchFlags(calm), []);
  assert.deepEqual(watchFlags(calm.slice(0, 5)), [], "too little history to judge");

  const dump = calm.map((r, i) => (i >= 26 ? { ...r, pxClose: 0.7 } : r));
  assert.ok(watchFlags(dump).some((f) => /price -30% in 6h/.test(f)));

  const pump = calm.map((r, i) => (i >= 26 ? { ...r, pxClose: 1.5 } : r));
  assert.ok(watchFlags(pump).some((f) => /price \+50% in 6h/.test(f)));

  const exit = calm.map((r, i) => (i >= 20 ? { ...r, liquidity: 3e17 } : r));
  assert.ok(watchFlags(exit).some((f) => /LPs leaving/.test(f)));

  const crowd = calm.map((r, i) => (i >= 20 ? { ...r, liquidity: 3e18 } : r));
  assert.ok(watchFlags(crowd).some((f) => /crowding/.test(f)));

  const fade = calm.map((r, i) => (i >= 24 ? { ...r, volumeUsd: 300, swaps: 3 } : r));
  assert.ok(watchFlags(fade).some((f) => /volume fading/.test(f)));

  const quiet = calm.map((r, i) => (i >= 24 ? { ...r, volumeUsd: 0, swaps: 0 } : r));
  assert.ok(watchFlags(quiet).some((f) => /quiet: 0 swaps in 6h/.test(f)));

  const losing = calm.map((r) => ({ ...r, markoutUsd: 90, lpNetUsd: -40 }));
  assert.ok(watchFlags(losing).some((f) => /LPs net negative/.test(f)));
});

test("the watch list is well formed", () => {
  const ids = WATCHED.map((p) => p.id.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, "no pool is listed twice");
  for (const p of WATCHED) {
    assert.match(p.id, /^0x[0-9a-f]{64}$/);
    assert.match(p.token, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(p.lpFee > 0 && p.lpFee <= 100000, `${p.symbol} fee in pips`);
    assert.ok(p.quote === "USDG" || p.quote === "ETH");
  }
  assert.ok(WATCHED.some((p) => p.enterable));
});
