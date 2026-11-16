import { test } from "node:test";
import assert from "node:assert/strict";
import { DESK_FINAL, bidBand, balancedBand, bandAt, inRangeFraction, poolLiquidity, refLiquidity, replay, passive, gateOf, variants, type ReplayPool, type Rules } from "../src/signals/paperReplay.js";
import type { LedgerHour } from "../src/signals/poolWatch.js";

/**
 * THE PAPER REPLAY.
 *
 * It is the evidence the cross-chain strategy will be judged on, so the ways
 * it could flatter the desk are pinned here: a seat must be worth what its own
 * formula says, a decision must not see the hour after it, a dump must cost
 * what the floor costs and not less, a bid nobody fills must earn nothing, and
 * every dollar the report prints must add up to the change in the book.
 */

const H = 3600;
const T0 = 1_800_000_000 - (1_800_000_000 % H);
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

function row(i: number, px: { open: number; close: number; high?: number; low?: number }, o: Partial<LedgerHour> = {}): LedgerHour {
  const high = px.high ?? Math.max(px.open, px.close), low = px.low ?? Math.min(px.open, px.close);
  return { ts: (T0 + (i + 1) * H) * 1000, kind: "hour", id: "0xpool", symbol: "T", quote: "USD", feePct: 1, enterable: true, hour: "", hourStart: T0 + i * H, swaps: 50, traders: 20, volumeUsd: 200_000, feesUsd: 200, markoutUsd: 0, lpNetUsd: 200, pxOpen: px.open, pxClose: px.close, pxHigh: high, pxLow: low, sqrtPClose: 1, liquidity: 1, depth2pctUsd: 5000, seatSharePct: 2, seatNetUsd: 4, ...o };
}
const pool = (rows: LedgerHour[], key = "bnb:0xaaa", label = "FOO/USDT"): ReplayPool => ({ key, chain: key.split(":")[0], label, feePct: 1, rows });
/** a pool that wiggles 1% around a price and pays: clears every one of the desk's bars */
const wiggle = (n: number, price = 1) => Array.from({ length: n }, (_, i) => row(i, { open: price, close: price, high: price * 1.01, low: price * 0.99 }));

test("a bid seat is all dollars at and above spot, converts on the way down, and is worth its formula", () => {
  const b = bidBand(1000, 1, 50);
  assert.ok(near(b.pb, 1) && near(b.pa, 0.8), "width 50 reaches from spot down to spot / 1.25");
  assert.ok(near(bandAt(b, 1).valueUsd, 1000) && near(bandAt(b, 1).tokenUsd, 0));
  assert.ok(near(bandAt(b, 1.5).valueUsd, 1000), "a price above the band cannot change an all-dollar seat");
  const bottom = bandAt(b, 0.8);
  assert.ok(near(bottom.quoteUsd, 0) && near(bottom.valueUsd, 1000 / Math.sqrt(1.25), 1e-6), "at the bottom edge it is all token, worth 89.4% of the deposit");
  assert.ok(near(bandAt(b, 0.4).valueUsd, bottom.valueUsd / 2, 1e-6), "below the band the value falls with the token");
  let prev = 0;
  for (const p of [0.3, 0.6, 0.8, 0.85, 0.9, 0.95, 1, 1.2]) { const v = bandAt(b, p).valueUsd; assert.ok(v >= prev - 1e-9, "value never falls as the price rises"); prev = v; }
  const bal = balancedBand(1000, 2);
  assert.ok(near(bandAt(bal, 2).valueUsd, 1000) && near(bandAt(bal, 2).quoteUsd, 500, 1e-6), "a balanced seat is half and half at spot");
  assert.ok(near(b.L, 2 * refLiquidity(1), 1e-6), "the same dollars on one side are twice the liquidity");
});

test("pool liquidity recovered from the recorded share gives that share back", () => {
  const r = row(0, { open: 2, close: 2 }, { seatSharePct: 2.5 });
  const L = poolLiquidity(r);
  const seat = balancedBand(1000, 2);
  assert.ok(near(seat.L / (L + seat.L), 0.025, 1e-9));
  assert.equal(poolLiquidity(row(0, { open: 2, close: 2 }, { seatSharePct: 0 })), Infinity, "a seat that rounds to nothing earns nothing");
});

test("inRangeFraction is the share of the hour's range inside the band", () => {
  assert.equal(inRangeFraction(0.9, 0.95, 0.8, 1), 1);
  assert.equal(inRangeFraction(1.1, 1.2, 0.8, 1), 0);
  assert.equal(inRangeFraction(0.5, 0.7, 0.8, 1), 0);
  assert.ok(near(inRangeFraction(0.99, 1.01, 0.8, 1), Math.log(1 / 0.99) / Math.log(1.01 / 0.99), 1e-12));
  assert.equal(inRangeFraction(0.9, 0.9, 0.8, 1), 1, "an hour with one price is in or out");
  assert.equal(inRangeFraction(1.1, 1.1, 0.8, 1), 0);
});

test("a pool that clears the desk's bars gets a seat, on the hour after the evidence, and it earns its share", () => {
  const res = replay([pool(wiggle(30))], DESK_FINAL);
  assert.equal(res.seats.length, 1, "one $1,000 seat is all a $1,600 book can carry with a $300 reserve");
  const s = res.seats[0];
  assert.equal(s.openedAt, T0 + 3 * H, "three hours of history, then in at the end of the third");
  assert.equal(s.exit, "still open");
  assert.equal(s.hours, 27);
  // bid liquidity is twice the reference seat's; the pool holds 49 reference seats (2% share)
  const share = 2 / (49 + 2);
  const perHour = 200 * share * (Math.log(1 / 0.99) / Math.log(1.01 / 0.99));
  assert.ok(near(s.feesUsd, 27 * perHour, 1e-6), `fees ${s.feesUsd} vs ${27 * perHour}`);
  assert.ok(near(s.principalUsd, 0, 1e-6), "the price ended where it started, at the top of the band: all dollars");
  assert.ok(res.refusals["desk: cash N under seat N + reserve N"] > 0, "after that the book is capital-bound, and the tally says so");
});

test("the books add up: the change in the book is the sum of what the seats did", () => {
  const dump = [...wiggle(6), ...Array.from({ length: 12 }, (_, i) => row(6 + i, { open: 0.92 ** i, close: 0.92 ** (i + 1) }))];
  for (const rules of variants()) {
    const res = replay([pool(wiggle(40), "bnb:0xaaa", "CALM"), pool(dump, "base:0xbbb", "DUMP")], rules);
    const fromSeats = res.seats.reduce((a, s) => a + s.netUsd, 0);
    assert.ok(near(res.netUsd, fromSeats, 1e-6), `${rules.name}: book ${res.netUsd} vs seats ${fromSeats}`);
    assert.ok(near(res.netUsd, res.feesUsd + res.principalUsd - res.costsUsd, 1e-6));
    assert.ok(near(res.endBookUsd, rules.capitalUsd + res.netUsd, 1e-6));
  }
});

test("a dump costs what the floor costs: the seat leaves at 70% of its deposit, and the pool is not re-entered", () => {
  const rows = [...wiggle(4), ...Array.from({ length: 10 }, (_, i) => row(4 + i, { open: 0.9 ** i, close: 0.9 ** (i + 1) }))];
  const res = replay([pool(rows)], DESK_FINAL);
  assert.equal(res.seats.length, 1);
  const s = res.seats[0];
  assert.equal(s.exit, "floor");
  assert.ok(near(s.principalUsd, -300, 1e-6), `the floor is 70% of a $1,000 deposit, got ${s.principalUsd}`);
  assert.ok(s.costsUsd > 7, "and selling $700 of token at a 1% fee is not free");
  assert.ok(s.feesUsd > 0, "it earned fees on the way down: the price was inside its band");
  assert.ok(near(s.netUsd, s.feesUsd - 300 - s.costsUsd, 1e-6));
  assert.ok(s.netUsd < -250, `fees on a falling token do not come close to paying for the floor: ${s.netUsd}`);
  assert.ok((res.refusals["admission"] ?? 0) + (res.refusals["cooldown"] ?? 0) > 0, "its own losing record keeps the desk out afterwards");
});

test("an hour that opens below the floor is booked at the open, not at the floor", () => {
  const rows = [...wiggle(4), row(4, { open: 0.3, close: 0.3 })];
  const s = replay([pool(rows)], DESK_FINAL).seats[0];
  assert.equal(s.exit, "floor (gapped through)");
  const expected = bandAt(bidBand(1000, 1, 50), 0.3).valueUsd - 1000;
  assert.ok(near(s.principalUsd, expected, 1e-6) && expected < -600, `a gap is a real loss: ${s.principalUsd}`);
});

test("a bid the price runs away from earns nothing and gives its slot back", () => {
  // climbs 4% an hour: under the 10% spike bar, so entry is allowed, and never trades back into the bid.
  // The history bar is 4 so the seat opens at the end of the last calm hour, right before the climb.
  const rows = [...wiggle(4), ...Array.from({ length: 8 }, (_, i) => row(4 + i, { open: 1.04 ** i, close: 1.04 ** (i + 1) }))];
  const res = replay([pool(rows)], { ...DESK_FINAL, minYieldToMove: 0, minHistoryHours: 4 });
  const first = res.seats[0];
  assert.equal(first.exit, "idle bid");
  assert.ok(near(first.principalUsd, 0, 1e-6), "all dollars in, all dollars out");
  assert.ok(first.feesUsd < 1e-9, "it was never in range once the price left");
  assert.ok(first.costsUsd > 0 && first.netUsd < 0, "trailing a bid costs gas and nothing else");
  assert.equal(first.hours, 2, "two hours unfilled is the desk's limit");
});

test("the spike rule keeps the desk out of an hour that just ran, and the tally names the gate", () => {
  const rows = [...wiggle(3), row(3, { open: 1, close: 1.15 }), ...Array.from({ length: 4 }, (_, i) => row(4 + i, { open: 1.15, close: 1.15, high: 1.16, low: 1.14 }))];
  // history bar at 4 so the first decision falls on the spike hour itself
  const res = replay([pool(rows)], { ...DESK_FINAL, minHistoryHours: 4, minYieldToMove: 0 });
  assert.ok((res.refusals["spike"] ?? 0) >= 1, JSON.stringify(res.refusals));
  assert.ok(res.seats.every((s) => s.openedAt > T0 + 4 * H), "nothing was opened at the end of the spike hour");
});

test("each of the desk's entry bars is the one that refuses when it should", () => {
  const thin = wiggle(10).map((r) => ({ ...r, volumeUsd: 20_000 }));
  assert.ok(replay([pool(thin)], DESK_FINAL).refusals["flow bar"] > 0);
  const poor = wiggle(10).map((r) => ({ ...r, feesUsd: 50 }));
  const poorRes = replay([pool(poor)], DESK_FINAL);
  assert.ok(poorRes.refusals["seat fee bar"] > 0 && poorRes.seats.length === 0);
  const jumpy = Array.from({ length: 10 }, (_, i) => row(i, { open: 1, close: i % 2 ? 1.08 : 1 / 1.08 }, { feesUsd: 200 }));
  assert.ok(replay([pool(jumpy)], DESK_FINAL).refusals["yield to move"] > 0, "0.78%/h against 8% hourly moves does not clear 0.25");
  assert.equal(replay([pool(thin)], { ...DESK_FINAL, minFlowUsdPerHour: 0 }).seats.length, 1, "with the flow bar off the same pool is entered");
});

test("no lookahead: what happened after an hour cannot change what was decided in it", () => {
  const calm = wiggle(20);
  const thenDump = [...wiggle(8), ...Array.from({ length: 12 }, (_, i) => row(8 + i, { open: 0.9 ** i, close: 0.9 ** (i + 1) }))];
  const a = replay([pool(calm)], DESK_FINAL).seats[0];
  const b = replay([pool(thenDump)], DESK_FINAL).seats[0];
  assert.equal(a.openedAt, b.openedAt, "identical first eight hours, identical entry");
  assert.equal(b.exit, "floor");
});

test("with several pools the desk takes the one that pays its seat the most", () => {
  const rich = wiggle(12).map((r) => ({ ...r, feesUsd: 600 }));
  const res = replay([pool(wiggle(12), "bnb:0xaaa", "OK"), pool(rich, "base:0xbbb", "RICH")], DESK_FINAL);
  assert.equal(res.seats[0].pool, "RICH");
  assert.equal(res.seats[0].chain, "base");
  const two = replay([pool(wiggle(12), "bnb:0xaaa", "OK"), pool(rich, "base:0xbbb", "RICH")], { ...DESK_FINAL, capitalUsd: 3000 });
  assert.deepEqual(two.seats.map((s) => s.pool).sort(), ["OK", "RICH"], "more capital, a second seat in the next best");
});

test("the portfolio breaker flattens the book and stands the desk down", () => {
  const slide = (key: string, label: string) => pool([...wiggle(4), ...Array.from({ length: 8 }, (_, i) => row(4 + i, { open: 0.93 ** i, close: 0.93 ** (i + 1) }))], key, label);
  const rules: Rules = { ...DESK_FINAL, capitalUsd: 4000, breakerFloorUsd: 300, floorPct: 40 };
  const res = replay([slide("bnb:0xaaa", "A"), slide("base:0xbbb", "B")], rules);
  assert.ok(res.breakerFires >= 1);
  assert.ok(res.seats.some((s) => s.exit === "portfolio breaker"));
  assert.ok(res.maxDrawdownUsd >= 300);
});

test("gateOf reads the desk's own refusal wording", () => {
  assert.equal(gateOf("bnb:0xaaa: flow $20k/h under $150k/h"), "flow bar");
  assert.equal(gateOf("bnb:0xaaa: ~$1.2/h for our seat under the $6/h bar"), "seat fee bar");
  assert.equal(gateOf("bnb:0xaaa: earns 0.10%/h vs moves 3.0%/h (0.03 < 0.25)"), "yield to move");
  assert.equal(gateOf("bnb:0xaaa: up 15.0% in the last hour, not buying the spike"), "spike");
  assert.equal(gateOf("bnb:0xaaa: exited 60m ago, cooldown 120m"), "cooldown");
  assert.equal(gateOf("bnb:0xaaa: 7d net $-310 under admission"), "admission");
  assert.equal(gateOf("bnb:0xaaa: seat open"), "already seated");
});

test("the do-nothing baseline counts the inventory the watchers' LP net leaves out", () => {
  const down = Array.from({ length: 24 }, (_, i) => row(i, { open: 0.99 ** i, close: 0.99 ** (i + 1) }));
  const rows = passive([pool(wiggle(24), "bnb:0xaaa", "FLAT"), pool(down, "base:0xbbb", "SLIDE")]);
  const flat = rows.find((r) => r.pool === "FLAT")!, slide = rows.find((r) => r.pool === "SLIDE")!;
  assert.ok(flat.feesUsd > 0 && near(flat.principalUsd, 0, 1e-6) && flat.inRangePct === 100);
  assert.ok(slide.principalUsd < -90, `a 21% slide leaves a balanced seat holding the token: ${slide.principalUsd}`);
  assert.ok(slide.feesUsd > 0, "it still collected fees the whole way down");
  assert.equal(rows[0].pool, "FLAT", "ranked by what was actually kept");
});
