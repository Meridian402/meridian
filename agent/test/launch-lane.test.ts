import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLaunchPush, launchSymbol, expiredLaunchVenues, pushedStatsFor, type LaunchVenue } from "../src/launchLane.js";
import { autoEntryVerdict, type AutoEntryCandidate } from "../src/pilotGuard.js";

/**
 * THE LAUNCH LANE (2026-09-04): the desk accepts only what it can mint into,
 * names venues safely, forgets them on time, and the pilot sizes and gates
 * them as a separate lane inside the same verdict.
 */
const TOKEN = "0x66e73ef65528baf192679222c6d2810d7d7e2c68";
const ID = "0xe0e5deeec338dd231384f777d733d5d1769f51e079d49a1fbaec18c07dbf8893";
const computeId = (token: string, fee: number, ts: number) => (token === TOKEN && fee === 40000 && ts === 400 ? (ID as `0x${string}`) : ("0x" + "1".repeat(64)) as `0x${string}`);
const goodStats = { ts: 1_000, hour: 2, flowUsdH: 360_000, movePct: 12, hourlyMovePcts: [23, 12], senders: 52, poolL: "373320185624380350", sqrtP: 0.000028, gate: true, source: "pons-v2" };

test("validateLaunchPush: only a gate-passing token in the exact hooks-free USDG pool the desk would mint into", () => {
  const ok = validateLaunchPush({ symbol: "BLOKKS", token: TOKEN, fee: 40000, tickSpacing: 400, poolId: ID, stats: goodStats }, computeId);
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.venue.fee, 40000); assert.equal(ok.venue.stats.hourlyMovePcts.length, 2); assert.equal(ok.venue.symbolRaw, "BLOKKS"); }
  const wrongId = validateLaunchPush({ symbol: "X", token: TOKEN, fee: 40000, tickSpacing: 400, poolId: "0x" + "a".repeat(64), stats: goodStats }, computeId);
  assert.equal(wrongId.ok, false);
  assert.match(wrongId.ok ? "" : wrongId.error, /cannot mint into it/);
  const hooked = validateLaunchPush({ symbol: "X", token: TOKEN, fee: 0x800000, tickSpacing: 400, poolId: ID, stats: goodStats }, computeId);
  assert.equal(hooked.ok, false, "a dynamic-fee flag is not a static tier");
  const noGate = validateLaunchPush({ symbol: "X", token: TOKEN, fee: 40000, tickSpacing: 400, poolId: ID, stats: { ...goodStats, gate: false } }, computeId);
  assert.equal(noGate.ok, false);
  assert.match(noGate.ok ? "" : noGate.error, /gate-passing/);
  assert.equal(validateLaunchPush({ token: "nope" }, computeId).ok, false);
});

test("launchSymbol: registry-safe names that never collide", () => {
  assert.equal(launchSymbol("blokks", TOKEN, () => false), "BLOKKS");
  assert.equal(launchSymbol("Pixel Cat!", TOKEN, () => false), "PIXELCAT");
  assert.equal(launchSymbol("", TOKEN, () => false), "L66E73", "no name: derived from the token");
  assert.equal(launchSymbol("PONS", TOKEN, (s) => s === "PONS"), "PONS2C68", "a taken name gets the token's tail");
});

test("expiredLaunchVenues: past the TTL and no seat open", () => {
  const now = 10_000_000_000;
  const mk = (symbol: string, updatedTs: number): LaunchVenue => ({ symbol, token: TOKEN as `0x${string}`, fee: 40000, tickSpacing: 400, poolId: ID as `0x${string}`, addedTs: updatedTs, updatedTs, stats: goodStats });
  const all = [mk("OLD", now - 25 * 3_600_000), mk("HELD", now - 25 * 3_600_000), mk("FRESH", now - 3_600_000)];
  assert.deepEqual(expiredLaunchVenues(all, new Set(["HELD"]), now, 24 * 3_600_000), ["OLD"]);
});

test("pushedStatsFor: fresh pushes feed the pilot, stale ones do not", () => {
  const v: LaunchVenue = { symbol: "BLOKKS", token: TOKEN as `0x${string}`, fee: 40000, tickSpacing: 400, poolId: ID as `0x${string}`, addedTs: 0, updatedTs: 0, stats: { ...goodStats, ts: 5_000_000 } };
  const s = pushedStatsFor(v, 5_000_000 + 30 * 60_000, 90 * 60_000);
  assert.ok(s, "30 minutes old: usable");
  assert.equal(s!.flowUsdPerHour, 360_000);
  assert.equal(s!.medianAbsHourlyPct, 17.5, "median of |23|,|12|");
  assert.equal(s!.last60mPct, 12);
  assert.equal(s!.activeL, 373320185624380350n);
  assert.ok(Math.abs(s!.tick - Math.round((2 * Math.log(0.000028)) / Math.log(1.0001))) <= 1, "tick from sqrtP");
  assert.equal(pushedStatsFor(v, 5_000_000 + 120 * 60_000, 90 * 60_000), null, "two hours old: the desk's own tape must take over");
});

test("auto-entry: the launch lane has its own size, cap, and bars inside the same verdict", () => {
  const base = {
    enabled: true, now: 1_000_000_000, openSeats: 1, maxSeats: 2, cashUsd: 1_200, reserveUsd: 300, seatUsd: 1000, gasEth: 0.08, minGasEth: 0.01,
    stoodDown: false, opsAvailable: true, entriesToday: 0, perDay: 6, minFlowUsdPerHour: 150_000, minFeeUsdPerHour: 6, minYieldToMove: 0.25, maxSpikePct: 10, cooldownMs: 120 * 60_000,
    launch: { openSeats: 0, maxSeats: 1, minTierPct: 3, minHour: 2, minFlowUsdPerHour: 300_000, depthMinUsd: 15_000, depthMaxUsd: 80_000 },
  };
  const launch = (over: Partial<AutoEntryCandidate> = {}): AutoEntryCandidate => ({
    symbol: "BLOKKS", lane: "launch", seatUsd: 500, tierPct: 4, hour: 2, depthUsd: 34_000, flowUsdPerHour: 360_000, feeUsdPerHour: 200, sharePct: 1.4,
    hourlyMovePct: 17.5, last60mPct: 7, admitted: true, admissionNetUsd: 0, hasSeat: false, lockedOut: false, denied: false, ...over,
  });
  const v = autoEntryVerdict({ ...base, candidates: [launch()] });
  assert.equal(v.act, true);
  if (v.act) { assert.equal(v.symbol, "BLOKKS"); assert.equal(v.seatUsd, 500, "lane-sized seat"); assert.match(v.reason, /^launch lane: /); }
  // cash: $1,200 is short for a $1,000 registry seat but fine for a $500 launch seat
  assert.equal(autoEntryVerdict({ ...base, cashUsd: 900, candidates: [launch()] }).act, true);
  const refuse = (over: Partial<AutoEntryCandidate>, extra: Partial<typeof base> = {}): string => { const r = autoEntryVerdict({ ...base, ...extra, candidates: [launch(over)] }); assert.equal(r.act, false); return r.act ? "" : r.reason; };
  assert.match(refuse({}, { launch: { ...base.launch, openSeats: 1 } }), /lane cap 1/);
  assert.match(refuse({ tierPct: 1 }), /tier 1.00% under 3%/);
  assert.match(refuse({ hour: 1 }), /lane starts at hour 2/);
  assert.match(refuse({ flowUsdPerHour: 120_000, feeUsdPerHour: 60 }), /under the lane's \$300k\/h/);
  assert.match(refuse({ depthUsd: 900 }), /outside \$15k-\$80k/);
  assert.match(refuse({ depthUsd: 400_000 }), /outside \$15k-\$80k/);
  assert.match(refuse({ depthUsd: undefined }), /depth unknown/);
  assert.match(refuse({ last60mPct: 25 }), /not buying the spike/);
  assert.match(refuse({ feeUsdPerHour: 8, hourlyMovePct: 17.5 }), /earns 1.60%\/h vs moves 17.5%\/h/);
  assert.match(refuse({}, { launch: undefined }), /launch lane off/);
  // a rich launch venue still ranks against the registry by what our seat earns
  const registry: AutoEntryCandidate = { symbol: "MICRODUCK", flowUsdPerHour: 600_000, feeUsdPerHour: 60, sharePct: 2.3, hourlyMovePct: 10, last60mPct: 3, admitted: true, admissionNetUsd: 150, hasSeat: false, lockedOut: false, denied: false };
  const both = autoEntryVerdict({ ...base, cashUsd: 2_000, candidates: [launch(), registry] });
  assert.equal(both.act && both.symbol, "BLOKKS", "$200/h beats $60/h");
  const both2 = autoEntryVerdict({ ...base, cashUsd: 2_000, candidates: [launch({ feeUsdPerHour: 40 }), registry] });
  assert.equal(both2.act && both2.symbol, "MICRODUCK", "$60/h beats $40/h");
});
