import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerHour } from "../src/signals/poolWatch.js";

/**
 * THE SEAT-KEPT RULES, LIVE SIDE (seatKept.ts).
 *
 * These decide whether the live desk may enter a pool and when it leaves one, from the same
 * hourly record and the same arithmetic the paper desk scores them on. So the tests pin the
 * ways that could go wrong without announcing itself: a stale or broken record treated as a
 * reading, the live number drifting from the paper one, an exit that the next tick's entry
 * undoes, and switches that do something while off.
 */

// The record is read from MERIDIAN_DATA_DIR, fixed when dataDir.ts loads, so it is set first.
const dir = mkdtempSync(join(tmpdir(), "seat-kept-"));
process.env.MERIDIAN_DATA_DIR = dir;
const K = await import("../src/seatKept.js");
const M = await import("../src/signals/seatMath.js");

const H = 3600;
const T0 = 1_800_000_000 - (1_800_000_000 % H);
const POOL = "0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8";
function row(i: number, px: { open: number; close: number; high?: number; low?: number }, o: Partial<LedgerHour> = {}): LedgerHour {
  const high = px.high ?? Math.max(px.open, px.close), low = px.low ?? Math.min(px.open, px.close);
  return { ts: (T0 + (i + 1) * H) * 1000, kind: "hour", id: POOL, symbol: "PRIORS", quote: "USDG", feePct: 1, enterable: true, hour: "", hourStart: T0 + i * H, swaps: 50, traders: 20, volumeUsd: 200_000, feesUsd: 200, markoutUsd: 0, lpNetUsd: 200, pxOpen: px.open, pxClose: px.close, pxHigh: high, pxLow: low, sqrtPClose: 1, liquidity: 1, depth2pctUsd: 5000, seatSharePct: 2, seatNetUsd: 4, ...o };
}
const wiggle = (n: number, from = 0) => Array.from({ length: n }, (_, k) => row(from + k, { open: 1, close: 1, high: 1.01, low: 0.99 }));
const slide = (i0: number, n: number, stepPct: number) => Array.from({ length: n }, (_, k) => row(i0 + k, { open: (1 - stepPct / 100) ** k, close: (1 - stepPct / 100) ** (k + 1) }));
const SEAT = { usd: 650, widthPct: 50, floorUsd: 455, gasUsd: 0.19, feePct: 1 };
/** the moment the latest row's hour has just ended */
const justAfter = (rows: LedgerHour[]) => (rows[rows.length - 1].hourStart + H) * 1000 + 60_000;

test("a calm, paying pool with two unbroken days of record reads as kept money, as of its latest hour", () => {
  const rows = wiggle(60);
  const k = K.keptReading(rows, justAfter(rows), SEAT);
  assert.ok(k.ok, k.ok ? "" : k.reason);
  if (!k.ok) return;
  assert.ok(k.reading.avg > 0 && k.reading.lastDay > 0);
  assert.equal(k.reading.asOfHour, rows[59].hourStart);
  assert.equal(K.keptEntryRefusal(k.reading, 650), null);
});

test("THE LIVE NUMBER IS THE PAPER NUMBER: the same rows give the replay's own score", () => {
  const rows = [...wiggle(50), ...slide(50, 10, 1.5)];
  const k = K.keptReading(rows, justAfter(rows), SEAT);
  assert.ok(k.ok);
  if (!k.ok) return;
  const paper = M.seatNetScore(rows.length - 1, (i0) => M.refSeatNet(rows, i0, 24, 650, 50, 455, 0.19, 1));
  assert.equal(k.reading.avg, paper.avg);
  assert.equal(k.reading.lastDay, paper.lastDay);
});

test("it fails closed on a record it cannot trust: none, under two days, a gap, or stale", () => {
  const none = K.keptReading([], Date.now(), SEAT);
  assert.ok(!none.ok && /no hourly record/.test(none.reason));
  const short = wiggle(40);
  const s = K.keptReading(short, justAfter(short), SEAT);
  assert.ok(!s.ok && /under two days/.test(s.reason), "forty hours cannot score a two-day average");
  const gapped = wiggle(60).filter((_, i) => i !== 30);
  const g = K.keptReading(gapped, justAfter(gapped), SEAT);
  assert.ok(!g.ok && /unbroken/.test(g.reason), "a missing hour is not read across");
  const rows = wiggle(60);
  const stale = K.keptReading(rows, justAfter(rows) + 4 * 3_600_000, SEAT);
  assert.ok(!stale.ok && /h old/.test(stale.reason), "a collector that stopped four hours ago is not a reading");
  assert.ok(K.keptReading(rows, justAfter(rows) + 2 * 3_600_000, SEAT).ok, "two hours late is still inside the three-hour allowance");
});

test("entry is refused where the seat lost money over two days or over the last day", () => {
  assert.match(K.keptEntryRefusal({ avg: -1, lastDay: 5, asOfHour: 0 }, 650)!, /kept \$-1\.00 a day on average over two days/);
  assert.match(K.keptEntryRefusal({ avg: 3, lastDay: -0.5, asOfHour: 0 }, 650)!, /kept \$-0\.50 over the last day/);
  assert.match(K.keptEntryRefusal({ avg: 0, lastDay: 5, asOfHour: 0 }, 650)!, /two days/, "breaking even is not keeping money");
  assert.equal(K.keptEntryRefusal({ avg: 3, lastDay: 0.5, asOfHour: 0 }, 650), null);
});

test("a pool has turned once a fresh seat lost more than the bar over the last day, and never while the bar is 0", () => {
  assert.equal(K.poolTurned({ avg: 1, lastDay: -6.6, asOfHour: 0 }, 650, 1), true, "1% of $650 is $6.50");
  assert.equal(K.poolTurned({ avg: 1, lastDay: -6.4, asOfHour: 0 }, 650, 1), false);
  assert.equal(K.poolTurned({ avg: 1, lastDay: -500, asOfHour: 0 }, 650, 0), false, "off is off");
});

test("the entry check: ranking on gates and ranks, the exit alone blocks only a turned pool, both off do nothing", () => {
  const good = { ok: true as const, reading: { avg: 12, lastDay: 4, asOfHour: 0 } };
  const losing = { ok: true as const, reading: { avg: 2, lastDay: -9, asOfHour: 0 } };
  const unread = { ok: false as const, reason: "hourly record 5.0h old" };
  assert.deepEqual(K.keptEntryCheck(good, true, 1, 650), { rankUsdPerHour: 0.5 }, "ranked on what it kept per hour");
  assert.match(K.keptEntryCheck(losing, true, 1, 650).refusal!, /last day/);
  assert.deepEqual(K.keptEntryCheck(unread, true, 1, 650), { refusal: "hourly record 5.0h old" }, "ranking on fails closed");
  assert.match(K.keptEntryCheck(losing, false, 1, 650).refusal!, /^pool turned/, "the exit alone still keeps the next tick from re-entering");
  assert.deepEqual(K.keptEntryCheck(good, false, 1, 650), {}, "a pool that has not turned is left to the desk's own ranking");
  assert.deepEqual(K.keptEntryCheck(unread, false, 1, 650), {}, "the exit alone cannot refuse on a reading it does not have");
  assert.deepEqual(K.keptEntryCheck(losing, false, 0, 650), {}, "both off: nothing");
});

test("the record is read from the data folder, by pool id in any case, and re-read when it changes", () => {
  const file = join(dir, "pool-watch.jsonl");
  const rows = wiggle(30);
  writeFileSync(file, rows.slice(0, 20).map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(K.ledgerRowsFor(POOL.toUpperCase().replace("0X", "0x")).length, 20);
  appendFileSync(file, rows.slice(20).map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(K.ledgerRowsFor(POOL).length, 30, "the appended hours are seen");
  assert.equal(K.ledgerRowsFor("0x" + "0".repeat(64)).length, 0, "an unwatched pool has no rows");
});

test("THE SWITCHES SHIP OFF: unset, ranking is off and the exit bar is 0", () => {
  assert.equal(process.env.MERIDIAN_PILOT_RANK_ON_KEPT, undefined, "the test runs with the switch unset");
  assert.equal(K.RANK_ON_KEPT, false);
  assert.equal(K.LEAVE_ON_LOSS_PCT, 0);
});
