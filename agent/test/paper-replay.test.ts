import { test } from "node:test";
import assert from "node:assert/strict";
import { DESK_FINAL, bidBand, balancedBand, bandAt, inRangeFraction, poolLiquidity, refLiquidity, refSeatNet, replay, passive, gateOf, seatNetScore, variants, type ReplayPool, type Rules } from "../src/signals/paperReplay.js";
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

// ---- few pools, stay put (2026-11-18) --------------------------------------------------------
//
// The operator's ask: fewer pools, and stop bouncing between them. The replay learned four
// optional settings for it. Each is pinned on its own below, and so is the thing that matters
// more than any of them: the rule sets that were already running must not move.

test("THE CONTROL: the five sets that were already running carry no stay-put setting, and the new set is sixth", () => {
  const v = variants();
  assert.deepEqual(v.slice(0, 5).map((r) => r.name), ["desk rules as closed", "no flow bar", "bars for small pools", "two $500 seats", "no entry gates"]);
  for (const r of v.slice(0, 5)) for (const k of ["feeLookbackHours", "trailEveryHours", "stayFeeUsdPerDay", "startAt", "balancedWidth", "steadyRangePct", "rankOnSeatNet", "leaveOnSeatLossPct"] as const) assert.equal(r[k], undefined, `${r.name} gained ${k}`);
  for (const r of v.slice(5, 7)) for (const k of ["rankOnSeatNet", "leaveOnSeatLossPct"] as const) assert.equal(r[k], undefined, `${r.name} gained ${k}`);
  assert.equal(v.length, 8);
  assert.equal(v[5].balancedWidth, undefined, "the stay-put set keeps the desk's bid");
  const few = v[5];
  assert.match(few.name, /few pools, stay put/);
  assert.ok(few.startAt! > 0, "it is scored only on hours after it was added");
  assert.match(few.note, /takes no seat before/, "and the page says so");
  assert.ok(few.maxSeats * few.seatUsd + few.reserveUsd <= few.capitalUsd, "its seats fit the book with the reserve intact");
});

test("a set added late takes no seat before it was added, and counts no refusal before it either", () => {
  const rules: Rules = { ...DESK_FINAL, startAt: T0 + 20 * H };
  const res = replay([pool(wiggle(40))], rules);
  assert.equal(res.seats.length, 1);
  assert.equal(res.seats[0].openedAt, T0 + 20 * H, "the first hour it may act on is the one that ends when it starts");
  const early = replay([pool(wiggle(19))], rules);
  assert.equal(early.seats.length, 0);
  assert.equal(early.candidateHours, 0, "hours before it existed are not hours it turned anything away");
});

test("a pool is chosen on a full day of what a seat would have earned, not on one hot hour", () => {
  // 26 hours that pay nothing, then one hour that pays a lot, then nothing again
  const rows = Array.from({ length: 32 }, (_, i) => row(i, { open: 1, close: 1, high: 1.01, low: 0.99 }, { feesUsd: i === 26 ? 1000 : 0 }));
  const hot = replay([pool(rows)], { ...DESK_FINAL, minFlowUsdPerHour: 0 });
  assert.equal(hot.seats.length, 1, "judged on its last hour, the desk takes the seat");
  assert.equal(hot.seats[0].openedAt, T0 + 27 * H);
  const day = replay([pool(rows)], { ...DESK_FINAL, minFlowUsdPerHour: 0, feeLookbackHours: 24, minHistoryHours: 24 });
  assert.equal(day.seats.length, 0, "one hour of fees spread over a day does not clear the same bar");
  // and a pool that pays every hour clears it as soon as there is a day on record
  const steady = replay([pool(wiggle(30))], { ...DESK_FINAL, minFlowUsdPerHour: 0, feeLookbackHours: 24, minHistoryHours: 24 });
  assert.equal(steady.seats[0].openedAt, T0 + 24 * H);
});

test("a bid the price leaves behind is moved up at most every N hours, and the moves it skips are not charged", () => {
  // three quiet hours to get in, one more at the price, then the price climbs 5% an hour for twelve hours
  const rows = wiggle(4);
  let p = 1;
  for (let i = 4; i < 16; i++) { rows.push(row(i, { open: p, close: p * 1.05 }, { feesUsd: 0 })); p *= 1.05; }
  const stay = { ...DESK_FINAL, idleBidMaxMin: 100 * 60 };
  const everyHour = replay([pool(rows)], stay).seats[0];
  const everySix = replay([pool(rows)], { ...stay, trailEveryHours: 6 }).seats[0];
  assert.equal(everyHour.exit, "still open");
  assert.equal(everySix.exit, "still open");
  // bnb is $0.10 an action and a move is two actions: twelve moves against two
  assert.ok(near(everyHour.costsUsd - everySix.costsUsd, 10 * 0.2, 1e-9), `skipped moves cost ${everyHour.costsUsd - everySix.costsUsd}`);
  assert.ok(near(everySix.principalUsd, 0, 1e-9) && near(everyHour.principalUsd, 0, 1e-9), "an unfilled bid is all dollars either way");
});

test("a seat is left after a full day of paying under the bar, and only then", () => {
  // three paying hours to get in, then the pool goes quiet at the same price
  const rows = Array.from({ length: 40 }, (_, i) => row(i, { open: 1, close: 1, high: 1.01, low: 0.99 }, { feesUsd: i < 3 ? 200 : 0 }));
  const kept = replay([pool(rows)], DESK_FINAL).seats[0];
  assert.equal(kept.exit, "still open", "the desk as it closed would sit in a dead pool for ever");
  const res = replay([pool(rows)], { ...DESK_FINAL, stayFeeUsdPerDay: 3 });
  const s = res.seats[0];
  assert.equal(s.exit, "stopped paying");
  assert.equal(s.hours, 24, "a full day of its own fees, not an hour less");
  assert.equal(s.closedAt, T0 + 27 * H);
  assert.ok(near(s.principalUsd, 0, 1e-9), "it left at the price it came in at, all dollars");
});

// ---- steady range (2026-11-18) ---------------------------------------------------------------
//
// The operator's criterion: fewer, larger seats, in pools with high volume and a steady range.
// A previewed run of this set over the hours it was written from lost money in two stock-token
// pools that had been steady for a day and then fell, so nothing below claims it earns. The
// tests pin only that it does what its description says.

test("the steady-range set is two seats of under half the book, whatever the book, and says when it starts", () => {
  const small = variants(1600)[6], large = variants(3000)[6];
  assert.match(small.name, /steady range/);
  assert.equal(small.maxSeats, 2);
  assert.equal(large.maxSeats, 2, "a bigger book means bigger seats, not more of them");
  assert.equal(small.seatUsd, 650);
  assert.equal(large.seatUsd, 1350);
  for (const r of [small, large]) {
    assert.ok(2 * r.seatUsd + r.reserveUsd <= r.capitalUsd);
    assert.ok(near(r.minFeeUsdPerHour * 24, r.seatUsd * 0.01, 1e-9), "the bar is 1% of the seat a day");
    assert.ok(r.startAt! > 0);
    assert.match(r.note, /takes no seat before/);
    assert.ok(r.balancedWidth! > 1 && r.balancedWidth! < 1.1, "a tight band, not the desk's wide bid");
  }
});

test("a pool whose price wandered outside the bar over the day is not steady, and the tally says so", () => {
  const rules: Rules = { ...DESK_FINAL, minFlowUsdPerHour: 0, feeLookbackHours: 24, minHistoryHours: 24, steadyRangePct: 6 };
  const calm = replay([pool(wiggle(30))], rules);
  assert.equal(calm.seats.length, 1, "a 2% range clears a 6% bar");
  assert.equal(calm.seats[0].openedAt, T0 + 24 * H);
  const wild = Array.from({ length: 30 }, (_, i) => row(i, { open: 1, close: 1, high: 1.1, low: 0.99 }));
  const res = replay([pool(wild)], rules);
  assert.equal(res.seats.length, 0);
  assert.equal(res.refusals["not steady"], 7, "every hour it was old enough to be judged");
  const onePrint = wiggle(30);
  onePrint[10] = row(10, { open: 1, close: 1, high: 1.01, low: 0.0001 });
  assert.equal(replay([pool(onePrint)], rules).seats.length, 0, "one wild print in the day fails the pool, which is the cautious way to be wrong");
});

test("a balanced seat in a tight band earns while the price stays inside it, and holds half of each side", () => {
  const rules: Rules = { ...DESK_FINAL, minFlowUsdPerHour: 0, balancedWidth: 1.03 };
  const s = replay([pool(wiggle(30))], rules).seats[0];
  assert.equal(s.exit, "still open");
  assert.equal(s.hoursInRange, s.hours, "a 1% wiggle never leaves a 3% band");
  assert.ok(near(s.principalUsd, 0, 1e-6), "the price ended where it started");
  const bid = replay([pool(wiggle(30))], { ...DESK_FINAL, minFlowUsdPerHour: 0 }).seats[0];
  assert.ok(s.feesUsd > bid.feesUsd, "the same dollars in a tighter band are a larger share of the trading");
});

test("putting a balanced seat back around the price is charged for the swap it takes", () => {
  // in at 1, then the price steps to 1.10 and sits there: above a 3% band
  const rows = wiggle(4);
  for (let i = 4; i < 16; i++) rows.push(row(i, { open: 1.1, close: 1.1, high: 1.105, low: 1.095 }));
  const base: Rules = { ...DESK_FINAL, minFlowUsdPerHour: 0, balancedWidth: 1.03 };
  const parked = replay([pool(rows)], { ...base, trailEveryHours: 1000 }).seats[0];
  const moved = replay([pool(rows)], base).seats[0];
  assert.ok(moved.hoursInRange > parked.hoursInRange, "back around the price, it earns again");
  // half of about $1,015 swapped at the pool's 1% fee plus 0.3% slippage, and two actions of gas
  assert.ok(moved.costsUsd - parked.costsUsd > 6.5, `the move cost ${moved.costsUsd - parked.costsUsd}`);
});

// ---- ranked on what a seat kept (2026-11-20) -------------------------------------------------
//
// The study behind it found one signal that held in both halves of the record: where a seat had
// lost money over the last day, the next day lost too. Fees alone did not hold, because a dump
// is busy. These pin that the set ranks on what a seat KEPT, never sees the future to do it,
// and leaves a pool once a fresh seat there would be losing.

/** n hours falling `stepPct` an hour, starting at `from` and at row index `i0` */
const slide = (i0: number, n: number, from: number, stepPct: number, o: Partial<LedgerHour> = {}) =>
  Array.from({ length: n }, (_, k) => row(i0 + k, { open: from * (1 - stepPct / 100) ** k, close: from * (1 - stepPct / 100) ** (k + 1) }, o));

test("what a seat kept: fees less costs in a calm pool, a loss in a dump, nothing known across a gap", () => {
  const calm = wiggle(30);
  const k = refSeatNet(calm, 0, 24, 650, 50, 455, 0.1, 1);
  assert.ok(k > 0, `a calm pool that pays keeps money: ${k}`);
  // a 1% wiggle around the top of the bid: half of each hour's range is inside it
  const b = bidBand(650, 1, 50), share = b.L / (poolLiquidity(calm[1]) + b.L), f = inRangeFraction(0.99, 1.01, b.pa, b.pb);
  const fees = 24 * 200 * share * f;
  assert.ok(near(k, fees - 0.1 - 0.1 - 24 * 0.1, 1e-6), `fees ${fees} less the open, the close and one collect an hour, got ${k}`);
  const dump = [...wiggle(1), ...slide(1, 24, 1, 3)];
  assert.ok(refSeatNet(dump, 0, 24, 650, 50, 455, 0.1, 1) < -100, "a 3%-an-hour slide costs far more than it pays");
  const gap = calm.filter((_, i) => i !== 10);
  assert.ok(Number.isNaN(refSeatNet(gap, 0, 24, 650, 50, 455, 0.1, 1)), "a missing hour is not guessed across");
  assert.ok(Number.isNaN(refSeatNet(calm, 10, 24, 650, 50, 455, 0.1, 1)), "nor is an hour the record has not reached");
});

test("NO LOOKAHEAD: what a seat kept up to an hour does not change with anything after it", () => {
  const a = wiggle(60), b = [...wiggle(49), ...slide(49, 11, 1, 5)];
  for (let idx = 24; idx <= 48; idx++) {
    const sa = seatNetScore(idx, (i0) => refSeatNet(a, i0, 24, 650, 50, 455, 0.1, 1));
    const sb = seatNetScore(idx, (i0) => refSeatNet(b, i0, 24, 650, 50, 455, 0.1, 1));
    if (idx >= 47) assert.ok(near(sa.avg, sb.avg, 1e-9) && near(sa.lastDay, sb.lastDay, 1e-9), `hour ${idx}: identical rows up to it, identical score`);
    else assert.ok(Number.isNaN(sa.avg), `hour ${idx}: under two days of record, no score`);
  }
  const s = seatNetScore(47, (i0) => i0);
  assert.equal(s.lastDay, 23, "the latest full day is the seat opened 24 hours back");
  assert.equal(s.avg, (0 + 23) / 2, "and the average runs over the 24 seats that ended in the last 24 hours");
});

test("the set takes the pool where a seat kept money over the busier one where it lost", () => {
  const set = { ...variants()[7], startAt: undefined };
  const rich = slide(0, 60, 1, 3, { feesUsd: 600 }), calm = wiggle(60);
  const pools = [pool(rich, "bnb:0xaaa", "BUSY-DUMP"), pool(calm, "base:0xbbb", "CALM")];
  const res = replay(pools, set);
  assert.ok(res.seats.length >= 1);
  assert.ok(res.seats.every((s) => s.pool === "CALM"), `seated in ${res.seats.map((s) => s.pool).join(", ")}`);
  assert.ok((res.refusals["seat lost money over two days"] ?? 0) > 0, JSON.stringify(res.refusals));
  const byFees = replay(pools, { ...set, rankOnSeatNet: undefined, leaveOnSeatLossPct: undefined, feeLookbackHours: 24 });
  assert.equal(byFees.seats[0].pool, "BUSY-DUMP", "ranked on fees, the same rules walk into the dump");
});

test("a seat is left once a fresh seat in its pool would be losing, before the floor would take it", () => {
  // two quiet days to qualify, then a 1.5%-an-hour slide on thin fees
  const rows = [...wiggle(50).map((r) => ({ ...r, feesUsd: 50 })), ...slide(50, 40, 1, 1.5, { feesUsd: 50 })];
  const set = { ...variants()[7], startAt: undefined };
  const left = replay([pool(rows)], set).seats[0];
  assert.equal(left.exit, "pool turned");
  const kept = replay([pool(rows)], { ...set, leaveOnSeatLossPct: undefined }).seats[0];
  assert.equal(kept.exit, "floor", "without the exit the same seat rides the slide to its floor");
  assert.ok(left.closedAt! < kept.closedAt!, "the exit comes first");
  assert.ok(left.netUsd > kept.netUsd, `and loses less: ${left.netUsd.toFixed(2)} against ${kept.netUsd.toFixed(2)}`);
});

test("the seat-net set is two seats of under half the book, never moves a bid up, and says when it starts", () => {
  const small = variants(1600)[7], large = variants(3000)[7];
  assert.match(small.name, /what a seat kept/);
  for (const r of [small, large]) {
    assert.equal(r.maxSeats, 2);
    assert.ok(2 * r.seatUsd + r.reserveUsd <= r.capitalUsd);
    assert.equal(r.rankOnSeatNet, true);
    assert.equal(r.leaveOnSeatLossPct, 1);
    assert.ok(r.trailEveryHours! >= 24 * 365, "an unfilled bid is given back, not chased");
    assert.equal(r.minHistoryHours, 48, "two days of record before a pool can be scored");
    assert.ok(r.startAt! > 0);
    assert.match(r.note, /takes no seat before/);
  }
  assert.equal(small.seatUsd, 650);
  assert.equal(large.seatUsd, 1350);
});
