import { test } from "node:test";
import assert from "node:assert/strict";
import { recenterVerdict, floorBreached, effectiveFloorUsd, outOfRangeManaged, collectDue, inferredDepositUsd, autoEntryVerdict, bidShareOfPool, paybackFeePerHour, recenterPaysBack, idleBidVerdict, gasRefillVerdict, type AutoEntryCandidate } from "../src/pilotGuard.js";
import { flowUsdPerHour } from "../src/dumpWatch.js";
import { bidBelowBounds } from "../src/venues/lpPositions.js";
import { skimAmountUsd } from "../src/treasurySkim.js";

/**
 * THE PILOT GUARD'S THREE DECISIONS, the pure parts. This guard exists
 * because of one specific afternoon: a position slid out of its band into a
 * falling tape, and the two wrong answers were doing nothing forever and
 * re-centering into the knife. Every test here encodes a rule agreed with
 * the operator on 2026-08-14.
 */

const MIN = 60_000;
const mk = (ticks: number[], now: number, stepMs = 3 * MIN) =>
  ticks.map((tick, i) => ({ t: now - (ticks.length - 1 - i) * stepMs, tick }));

// ── out of range, which side (2026-09-01) ────────────────────────────────────

test("the below-band clock is ON by default: the replay with the settle test and break exit modeled had it worth +$10 to +$32 per event", () => {
  assert.equal(outOfRangeManaged(true), true);
});

test("with below-band management switched off, a seat below its band holds for the floor and the dump exit", () => {
  assert.equal(outOfRangeManaged(true, false), false);
});

test("above the band (all USDG, nothing to realize) the fast re-center always runs", () => {
  assert.equal(outOfRangeManaged(false, false), true);
  assert.equal(outOfRangeManaged(false, true), true);
});

// ── the re-center bid (2026-09-01): never re-buy the top ─────────────────────

test("depth-0 bid bounds sit strictly out of range with the top price edge at spot (USDG currency0)", () => {
  // USDG is currency0 (token is currency1): token price falls as the tick
  // rises, so the bid occupies ticks ABOVE spot and holds only USDG.
  const b = bidBelowBounds(303046, 90, false, 0, 25);
  assert.ok(b.tickLower > 303046, "strictly above the current tick: the mint pulls only USDG");
  assert.ok(b.tickLower - 303046 <= 90, "top price edge lands within one spacing of spot");
  const span = b.tickUpper - b.tickLower;
  const wantTicks = Math.log(1.25) / Math.log(1.0001); // widthPct 25 one-sided = the width-50 balanced band's lower half
  assert.ok(Math.abs(span - wantTicks) <= 2 * 90, "the bid spans the balanced band's lower half");
});

test("depth-0 bid bounds mirror for a currency0 token", () => {
  const b = bidBelowBounds(1000, 90, true, 0, 25);
  assert.ok(b.tickUpper <= 1000, "price falls with the tick: the bid occupies ticks below spot");
  assert.ok(1000 - b.tickUpper <= 90, "top price edge within one spacing of spot");
});

// ── collect cadence (2026-09-01): a clock, gas-guarded ───────────────────────

test("a seat that has not collected this process life collects on the first tick with fees above the gas guard", () => {
  assert.equal(collectDue(undefined, 1_000_000, 1.5, 5 * MIN, 1), true);
});

test("inside the cadence it waits, whatever has accrued: one 150s tick after a collect is never its turn", () => {
  assert.equal(collectDue(1_000_000 - 150_000, 1_000_000, 40, 5 * MIN, 1, 150_000), false);
  assert.equal(collectDue(1_000_000 - 3 * MIN, 1_000_000, 40, 5 * MIN, 1, 150_000), false, "3 minutes is still short of the 3.75-minute slack window");
});

test("at the cadence it collects, and a tick that lands a hair short still counts (half-tick slack)", () => {
  assert.equal(collectDue(1_000_000 - 5 * MIN, 1_000_000, 1.5, 5 * MIN, 1, 150_000), true);
  assert.equal(collectDue(1_000_000 - 5 * MIN + 40, 1_000_000, 1.5, 5 * MIN, 1, 150_000), true, "299.96s since the last collect is this tick's turn, not the next one's");
  assert.equal(collectDue(1_000_000 - 150_000, 1_000_000, 1.5, 5 * MIN, 1, 150_000), false, "one tick after a collect is inside the cadence");
});

test("pennies wait for the gas guard; a guard of 0 only refuses an empty seat", () => {
  assert.equal(collectDue(undefined, 1_000_000, 0.4, 5 * MIN, 1), false, "paying ~$0.19 of gas to move $0.40 is refused");
  assert.equal(collectDue(undefined, 1_000_000, 0.05, 5 * MIN, 0), true);
  assert.equal(collectDue(undefined, 1_000_000, 0, 5 * MIN, 0), false);
});

// ── deposit inference (2026-09-01): a bid is not half of a bigger seat ───────

test("a balanced mint's deposit is twice its USDG side; a single-sided bid's is its USDG side alone", () => {
  assert.equal(inferredDepositUsd(true, 495, 12345), 990, "balanced: half the budget went in as token");
  assert.equal(inferredDepositUsd(true, 990, 0), 990, "bid: the whole budget IS the USDG side; doubling it floored a healthy seat");
  assert.equal(inferredDepositUsd(false, 990, 0), 0);
  assert.equal(inferredDepositUsd(true, 0, 0), 0);
});

// ── re-center: patience first ────────────────────────────────────────────────

test("no re-center before the minimum out-of-range age, even on a calm tape", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 10 * MIN, now, mk([100, 100, 100, 100], now), true, 45 * MIN);
  assert.equal(v.act, false, "a wick out of range must not trigger a knee-jerk re-band");
});

test("no re-center while the tape is still falling away below the band", () => {
  const now = 1_000_000_000;
  // token-as-currency0, exited below: away = tick down. Tape keeps sliding
  // 300 ticks (~3%) across the window: still the knife, still refuse.
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1000, -1100, -1200, -1300], now), true, 45 * MIN);
  assert.equal(v.act, false);
  assert.match(v.reason, /moving away/);
});

test("re-center once out long enough AND the tape has settled", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1300, -1305, -1298, -1302], now), true, 45 * MIN);
  assert.equal(v.act, true, "sideways tape after the minimum wait is exactly the re-entry the guard exists to allow");
});

test("a recovering tape (coming back toward the band) also allows re-center", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 60 * MIN, now, mk([-1300, -1250, -1200, -1150], now), true, 45 * MIN);
  assert.equal(v.act, true, "price walking home is stability, not danger");
});

test("orientation flips for a token exited ABOVE its band", () => {
  const now = 1_000_000_000;
  // away is now tick UP; a tape still climbing away must refuse.
  const v = recenterVerdict(now - 60 * MIN, now, mk([1000, 1100, 1200, 1300], now), false, 45 * MIN);
  assert.equal(v.act, false);
});

test("no verdict without tape history: never act blind", () => {
  const now = 1_000_000_000;
  const v = recenterVerdict(now - 120 * MIN, now, [], true, 45 * MIN);
  assert.equal(v.act, false);
});

// ── the asymmetric clocks: patience down, speed up ───────────────────────────

test("an above-band exit re-centers on the fast clock: 15 minutes of settled tape suffice", () => {
  const now = 1_000_000_000;
  // exited above (all USDG, nothing to realize); away is tick UP here.
  // 15 minutes out, tape settled: the fast clock (12m) acts where the slow
  // clock (30m) would still sit earning nothing on a busy pool.
  const flat = mk([1200, 1201, 1199, 1200], now);
  assert.equal(recenterVerdict(now - 15 * MIN, now, flat, false, 12 * MIN, 1.0, 12 * MIN).act, true);
  assert.equal(recenterVerdict(now - 15 * MIN, now, flat, false, 30 * MIN).act, false);
});

test("the fast clock still refuses to chase a tape that is running away upward", () => {
  const now = 1_000_000_000;
  // still pumping away from the band: re-entering would buy the top. Wait.
  const pumping = mk([1200, 1300, 1400, 1500], now);
  assert.equal(recenterVerdict(now - 20 * MIN, now, pumping, false, 12 * MIN, 1.0, 12 * MIN).act, false);
});

// ── the floor: bounded worst case ────────────────────────────────────────────

test("floor bounds principal alone: fees no longer widen the tolerated loss", () => {
  assert.equal(floorBreached(118, 120), true, "$118 of principal is under a $120 floor, whatever fees accrued");
  assert.equal(floorBreached(121, 120), false);
  assert.equal(floorBreached(120, 120), false, "exactly at the floor holds");
  // The bleed-audit change: $118 principal with $3 of accrued fees used to
  // read as $121 all-in and HOLD. Earned income no longer buys drawdown room.
});

test("the floor scales with the deposit, so bigger positions keep proportional protection", () => {
  assert.equal(effectiveFloorUsd(146, 120), 120, "small pilot: the env floor is already the tighter bound");
  assert.equal(effectiveFloorUsd(300, 120), 240, "a $300 position is floored at 80% of deposit, not a fixed $120");
  assert.equal(effectiveFloorUsd(0, 120), 120, "no cost basis falls back to the env floor");
  assert.equal(effectiveFloorUsd(700, 120, 70), 490, "the floor percent is a knob: 70% of a $700 seat");
  assert.equal(effectiveFloorUsd(150, 120, 70), 120, "a 70% floor still never drops under the env floor");
});

// ── the skim: float target, not events ───────────────────────────────────────

test("skim sweeps only the excess above the float target", () => {
  assert.equal(skimAmountUsd(350, 300, 10), 50);
  assert.equal(skimAmountUsd(305, 300, 10), 0, "sub-minimum excess is not worth a transaction");
  assert.equal(skimAmountUsd(250, 300, 10), 0, "under target sweeps nothing, ever");
});

// ── the dump bid: when the desk stands below a fall and gets paid ────────────
import { dumpBidDecision } from "../src/pilotGuard.js";

const BID_BASE = {
  enabled: true,
  lockoutUntil: 2_000_000 as number | undefined,
  now: 1_000_000,
  venueSeats: 0,
  hasActiveBid: false,
  usdgAvailUsd: 500,
  bidUsd: 150,
  envFloorUsd: 120,
  bidsToday: 0,
  bidsPerDay: 3,
  stoodDown: false,
};

test("a flattened venue in lockout with budget gets exactly one bid", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE }).act, true);
  assert.equal(dumpBidDecision({ ...BID_BASE, hasActiveBid: true }).act, false, "one bid per lockout");
});

test("no lockout means no bid: this is a dump response, not a standing strategy", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, lockoutUntil: undefined }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, now: 3_000_000 }).act, false, "an expired lockout is no lockout");
});

test("a venue still holding seats is not flat; no bid on top of exposure", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, venueSeats: 1 }).act, false);
});

test("the stand-down, the daily budget, the wallet, and the kill switch all veto", () => {
  assert.equal(dumpBidDecision({ ...BID_BASE, stoodDown: true }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, bidsToday: 3 }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, usdgAvailUsd: 60 }).act, false);
  assert.equal(dumpBidDecision({ ...BID_BASE, enabled: false }).act, false);
});

// ── the sliver-mint abort: a mint that barely deployed is a malfunction ──────
import { isUndersizedMint } from "../src/lpGuard.js";

test("a mint deploying a sliver of its budget is refused; normal drift is not", () => {
  assert.equal(isUndersizedMint(76, 444), true, "the measured live failure: 17% deployed");
  assert.equal(isUndersizedMint(200, 444), true, "45% is still a malfunction");
  assert.equal(isUndersizedMint(380, 444), false, "86% is price drift inside the caps");
  assert.equal(isUndersizedMint(444, 444), false);
  assert.equal(isUndersizedMint(100, 0), false, "no budget, no verdict");
});

test("a bid that cannot survive its own fill is refused outright", () => {
  // The audit case: $100 bid, $120 env floor. At fill the seat's floor is
  // max(120, 80) = 120 > ~100 value, an instant buy-then-floor-sell machine.
  const v = dumpBidDecision({ ...BID_BASE, bidUsd: 100 });
  assert.equal(v.act, false);
  assert.match(v.reason, /under its own/);
  assert.equal(dumpBidDecision({ ...BID_BASE, bidUsd: 150 }).act, true, "$150 clears max(120, 120) with 10% room");
});

/**
 * AUTO-ENTRY (2026-09-03): the pilot may open a seat on its own only under the
 * hand rules, and it picks the venue with the most last-hour flow.
 */
const cand = (over: Partial<AutoEntryCandidate> & { symbol: string }): AutoEntryCandidate => ({
  flowUsdPerHour: 300_000,
  admitted: true,
  admissionNetUsd: 150,
  hasSeat: false,
  lockedOut: false,
  denied: false,
  ...over,
});
const baseArgs = {
  enabled: true,
  now: 1_000_000_000,
  openSeats: 0,
  maxSeats: 2,
  cashUsd: 2_000,
  reserveUsd: 300,
  seatUsd: 700,
  gasEth: 0.08,
  minGasEth: 0.01,
  stoodDown: false,
  opsAvailable: true,
  entriesToday: 0,
  perDay: 6,
  minFlowUsdPerHour: 150_000,
  cooldownMs: 120 * 60_000,
};

test("auto-entry: the desk gates refuse before any venue is looked at", () => {
  const c = [cand({ symbol: "MICRODUCK" })];
  assert.equal(autoEntryVerdict({ ...baseArgs, enabled: false, candidates: c }).act, false, "switch off");
  assert.equal(autoEntryVerdict({ ...baseArgs, stoodDown: true, candidates: c }).act, false, "stand-down");
  assert.equal(autoEntryVerdict({ ...baseArgs, openSeats: 2, candidates: c }).act, false, "seat cap");
  assert.equal(autoEntryVerdict({ ...baseArgs, gasEth: 0.005, candidates: c }).act, false, "gas line");
  assert.equal(autoEntryVerdict({ ...baseArgs, cashUsd: 900, candidates: c }).act, false, "seat plus reserve");
  assert.equal(autoEntryVerdict({ ...baseArgs, opsAvailable: false, candidates: c }).act, false, "ops budget");
  assert.equal(autoEntryVerdict({ ...baseArgs, entriesToday: 6, candidates: c }).act, false, "daily cap");
  const ok = autoEntryVerdict({ ...baseArgs, candidates: c });
  assert.equal(ok.act, true, "all gates clear: it opens");
  assert.equal(ok.act && ok.symbol, "MICRODUCK");
});

test("auto-entry: every hand rule applies per venue", () => {
  const refuse = (over: Partial<AutoEntryCandidate>): string => {
    const v = autoEntryVerdict({ ...baseArgs, candidates: [cand({ symbol: "BONER", ...over })] });
    assert.equal(v.act, false);
    return v.act ? "" : v.reason;
  };
  assert.match(refuse({ hasSeat: true }), /seat open/);
  assert.match(refuse({ denied: true }), /denylist/);
  assert.match(refuse({ lockedOut: true }), /locked out/);
  assert.match(refuse({ admitted: false, admissionNetUsd: -47 }), /under admission/);
  assert.match(refuse({ lastExitMs: baseArgs.now - 30 * 60_000 }), /cooldown/);
  assert.match(refuse({ flowUsdPerHour: Number.NaN }), /too thin/);
  assert.match(refuse({ flowUsdPerHour: 40_000 }), /under \$150k\/h/);
  const after = autoEntryVerdict({ ...baseArgs, candidates: [cand({ symbol: "BONER", lastExitMs: baseArgs.now - 121 * 60_000 })] });
  assert.equal(after.act, true, "the cooldown has passed");
});

test("auto-entry: the venue with the most last-hour flow wins", () => {
  const v = autoEntryVerdict({
    ...baseArgs,
    candidates: [cand({ symbol: "CASHCAT", flowUsdPerHour: 220_000 }), cand({ symbol: "MICRODUCK", flowUsdPerHour: 280_000 }), cand({ symbol: "BONER", flowUsdPerHour: 900_000, admitted: false, admissionNetUsd: -47 })],
  });
  assert.equal(v.act, true);
  assert.equal(v.act && v.symbol, "MICRODUCK", "BONER had more flow but is not admitted");
});

test("flowUsdPerHour scales the hour's mean scan-window volume to USD/hour", () => {
  const now = 10_000_000;
  const samples = [1, 2, 3, 4].map((i) => ({ ts: now - i * 10 * 60_000, px: 1, sellSharePct: 50, usd: 15_000 }));
  assert.equal(flowUsdPerHour(samples, now, 180), 300_000, "15k per 3-minute window is 300k/hour");
  assert.ok(Number.isNaN(flowUsdPerHour(samples.slice(0, 2), now, 180)), "under 3 samples: no reading");
  assert.ok(Number.isNaN(flowUsdPerHour(samples, now, 0)), "no window: no reading");
});

test("auto-entry: a thin pool with less flow beats a deep pool with more (fee rate ranks)", () => {
  const v = autoEntryVerdict({
    ...baseArgs,
    candidates: [
      cand({ symbol: "PONS", flowUsdPerHour: 1_100_000, feeUsdPerHour: 3.5, sharePct: 0.09 }),
      cand({ symbol: "MICRODUCK", flowUsdPerHour: 280_000, feeUsdPerHour: 14, sharePct: 0.6 }),
    ],
  });
  assert.equal(v.act, true);
  assert.equal(v.act && v.symbol, "MICRODUCK", "PONS has 4x the flow but our seat earns 4x less there");
  assert.match(v.act ? v.reason : "", /~\$14\/h for our seat at 0.60%/);
  const noDepth = autoEntryVerdict({
    ...baseArgs,
    candidates: [cand({ symbol: "PONS", flowUsdPerHour: 1_100_000 }), cand({ symbol: "CASHCAT", flowUsdPerHour: 200_000, feeUsdPerHour: 1, sharePct: 0.1 })],
  });
  assert.equal(noDepth.act && noDepth.symbol, "CASHCAT", "a measured fee rate outranks an unknown depth, whatever the flow");
  const allUnknown = autoEntryVerdict({ ...baseArgs, candidates: [cand({ symbol: "PONS", flowUsdPerHour: 1_100_000 }), cand({ symbol: "BONER", flowUsdPerHour: 300_000 })] });
  assert.equal(allUnknown.act && allUnknown.symbol, "PONS", "with no depth anywhere, flow still decides");
  assert.match(allUnknown.act ? allUnknown.reason : "", /depth unknown/);
});

test("bidShareOfPool: v3 math for a bid-only seat against the pool's active liquidity", () => {
  // tick 0 (sqrtP = 1), token is currency0: L = 700e6 / (1 - 1/sqrt(1.25)) = 700e6 / 0.10557
  const seatL = 700e6 / (1 - 1 / Math.sqrt(1.25));
  const share = bidShareOfPool(700, BigInt(Math.round(seatL * 99)), 0, true);
  assert.ok(Math.abs(share - 1) < 0.01, `a seat equal to 1/99 of the pool holds ~1%: ${share}`);
  assert.ok(bidShareOfPool(700, BigInt(Math.round(seatL * 9)), 0, true) > share * 5, "a pool a tenth as deep gives a much larger share");
  assert.equal(bidShareOfPool(700, 0n, 0, true), 100, "an empty pool: the seat is the whole pool");
  assert.equal(bidShareOfPool(0, 1000n, 0, true), 0, "no seat, no share");
  // USDG as currency0 uses the other leg's formula and still lands in (0, 100)
  const other = bidShareOfPool(700, 10n ** 20n, -276_000, false);
  assert.ok(other > 0 && other < 100, `usdg-first pool share in range: ${other}`);
});

test("payback gate: a fresh venue is judged on the density estimate, not on fees it has not had time to bank", () => {
  // the PONS case, 2026-09-03: $0 banked, $0.17 accrued, ~$5/h by density, $2.75 churn
  const fresh = paybackFeePerHour(0, 0.17, 5);
  assert.equal(fresh, 5, "density is the floor of the estimate");
  assert.equal(recenterPaysBack(2.75, fresh), true, "the re-center now pays back inside the horizon");
  assert.equal(recenterPaysBack(2.75, paybackFeePerHour(0, 0.17, 0)), false, "without a density reading the old refusal stands");
  assert.equal(paybackFeePerHour(48, 0, 1), 2, "a worked venue's banked fees still win when they are higher");
  assert.equal(paybackFeePerHour(0, 0, Number.NaN), 0, "NaN density counts as nothing");
  assert.equal(paybackFeePerHour(0, 0, -3), 0, "negative density counts as nothing");
});

test("idle-bid exit: an unfilled bid gets the full window across re-centers, then gives the slot back", () => {
  const now = 5_000_000_000;
  const max = 180 * 60_000;
  assert.equal(idleBidVerdict(undefined, now, max).act, false, "a venue with a filled or in-range seat is never idle");
  assert.equal(idleBidVerdict(now - 170 * 60_000, now, max).act, false, "170m of 180m: still waiting");
  const v = idleBidVerdict(now - 181 * 60_000, now, max);
  assert.equal(v.act, true);
  assert.match(v.reason, /unfilled for 181m/);
});

test("gas refill: buys only under the line, with cash to spare, and not twice inside the cooldown", () => {
  const base = { enabled: true, ethBalance: 0.012, minEth: 0.02, cashUsd: 900, refillUsd: 60, minCashAfterUsd: 100, lastRefillMs: undefined, now: 9_000_000_000, cooldownMs: 360 * 60_000 };
  assert.equal(gasRefillVerdict(base).act, true, "under the line with cash: buy");
  assert.equal(gasRefillVerdict({ ...base, enabled: false }).act, false, "switch off");
  assert.equal(gasRefillVerdict({ ...base, ethBalance: 0.05 }).act, false, "above the line: nothing to do");
  assert.equal(gasRefillVerdict({ ...base, cashUsd: 150 }).act, false, "would leave under the cash floor");
  assert.equal(gasRefillVerdict({ ...base, lastRefillMs: base.now - 60 * 60_000 }).act, false, "refilled an hour ago: wait");
  assert.equal(gasRefillVerdict({ ...base, lastRefillMs: base.now - 361 * 60_000 }).act, true, "cooldown over: buy again if still under");
});

test("auto-entry: the fee-rate bar keeps a deep pool from taking a slot our seat cannot earn on", () => {
  const withBar = { ...baseArgs, minFeeUsdPerHour: 6 };
  const pons = cand({ symbol: "PONS", flowUsdPerHour: 1_100_000, feeUsdPerHour: 3.5, sharePct: 0.09 });
  const v = autoEntryVerdict({ ...withBar, candidates: [pons] });
  assert.equal(v.act, false);
  assert.match(v.act ? "" : v.reason, /~\$3.5\/h for our seat under the \$6\/h bar/);
  const unknown = autoEntryVerdict({ ...withBar, candidates: [cand({ symbol: "PONS", flowUsdPerHour: 1_100_000 })] });
  assert.equal(unknown.act, false, "no depth reading cannot clear the bar");
  assert.match(unknown.act ? "" : unknown.reason, /depth unknown/);
  const duck = cand({ symbol: "MICRODUCK", flowUsdPerHour: 280_000, feeUsdPerHour: 14, sharePct: 0.6 });
  const ok = autoEntryVerdict({ ...withBar, candidates: [pons, duck] });
  assert.equal(ok.act && ok.symbol, "MICRODUCK");
  const off = autoEntryVerdict({ ...baseArgs, minFeeUsdPerHour: 0, candidates: [pons] });
  assert.equal(off.act, true, "a zero bar disables the check");
});
