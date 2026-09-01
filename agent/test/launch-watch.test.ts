import { test } from "node:test";
import assert from "node:assert/strict";
import { bytecodeMatches, proxyTarget, gateToken, ignitionTime, seatLiquidity, seatValueUsd, simulateSeat, hourlyTable, type SwapSample } from "../src/launch/watchCore.js";

const ref = "0x" + "ab".repeat(1000);
const nearRef = "0x" + "ab".repeat(990) + "cd".repeat(10); // 1% different
const farRef = "0x" + "ab".repeat(500) + "cd".repeat(500);

test("bytecodeMatches accepts immutable-sized differences and rejects different code", () => {
  assert.equal(bytecodeMatches(nearRef, ref), true);
  assert.equal(bytecodeMatches(farRef, ref), false);
  assert.equal(bytecodeMatches(ref + "00", ref), false, "length must match");
  assert.equal(bytecodeMatches("0x", ref), false);
});

test("proxyTarget decodes EIP-1167 and the Solady minimal proxy, and nothing else", () => {
  const impl = "3be8b97fd0e713b5abe0649fa830223b6b4bc599";
  assert.equal(proxyTarget(`0x3d3d3d3d363d3d37363d73${impl}5af43d3d93803e602a57fd5bf3`), `0x${impl}`);
  assert.equal(proxyTarget(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`), `0x${impl}`);
  assert.equal(proxyTarget(ref), null);
});

test("gateToken passes a known standard with sane params and fails closed otherwise", () => {
  const base = { references: [{ name: "PonsV2LauncherToken", code: ref }], proxyImplementations: [{ name: "DopplerERC20V1", address: "0x3be8b97fd0e713b5abe0649fa830223b6b4bc599" }], pairAllowlist: ["0xusdg"] };
  assert.deepEqual(gateToken({ ...base, code: nearRef, creatorTaxBps: 100, pairToken: "0xUSDG", decimals: 18 }), { ok: true, standard: "PonsV2LauncherToken", reason: "" });
  assert.equal(gateToken({ ...base, code: farRef }).ok, false);
  assert.match(gateToken({ ...base, code: nearRef, creatorTaxBps: 250 }).reason, /creator tax/);
  assert.match(gateToken({ ...base, code: nearRef, pairToken: "0xother" }).reason, /allowlist/);
  assert.match(gateToken({ ...base, code: nearRef, decimals: 6 }).reason, /decimals/);
  const proxy = `0x3d3d3d3d363d3d37363d733be8b97fd0e713b5abe0649fa830223b6b4bc5995af43d3d93803e602a57fd5bf3`;
  assert.equal(gateToken({ ...base, code: proxy }).standard, "DopplerERC20V1");
  assert.match(gateToken({ ...base, code: proxy.replace("3be8", "0000") }).reason, /unknown implementation/);
});

function tape(n: number, opts: { start?: number; usd?: number; px?: number; L?: number; senders?: number; stepSec?: number } = {}): SwapSample[] {
  const { start = 1000, usd = 100, px = 0.01, L = 1e18, senders = 5, stepSec = 10 } = opts;
  const sqrtP = Math.sqrt(1e12 / px);
  return Array.from({ length: n }, (_, i) => ({ t: start + i * stepSec, usd, px, sqrtP, L, sender: `0x${(i % senders).toString(16).padStart(40, "0")}` }));
}

test("ignitionTime fires at the first swap that clears every cumulative threshold, inside the window", () => {
  const s = tape(100, { start: 1000, senders: 30, usd: 200 });
  const cfg = { windowSec: 600, minSwaps: 60, minSenders: 20, minUsd: 10000 };
  assert.equal(ignitionTime(1000, s, cfg), 1000 + 59 * 10);
  assert.equal(ignitionTime(1000, tape(100, { senders: 3 }), cfg), null, "too few senders");
  assert.equal(ignitionTime(0, s, { ...cfg, windowSec: 100 }), null, "outside the window");
});

test("seatLiquidity reproduces the BONER seat within 10%", () => {
  // BONER #1347056: ~$250 at +/-10%, USDG currency0, sqrtP raw ~4.153e6, on-chain L 1.0286e16
  const L = seatLiquidity(250, 4.153e6, 1.1, true);
  assert.ok(Math.abs(L / 1.0286e16 - 1) < 0.12, `L ${L.toExponential(3)}`);
});

test("seatValueUsd is the deposit at entry, all-USDG above the band, all-token below, for a USDG-currency0 pool", () => {
  const px = 0.01;
  const sqrtP = Math.sqrt(1e12 / px);
  const w = Math.sqrt(1.5);
  const L = seatLiquidity(1000, sqrtP, 1.5, true);
  const at = seatValueUsd(L, sqrtP, sqrtP / w, sqrtP * w, true, px);
  assert.ok(Math.abs(at - 1000) < 1, `entry value ${at}`);
  // token price doubles -> tick falls -> sqrtP falls below the lower bound: all USDG, capped
  const above = seatValueUsd(L, sqrtP / 2, sqrtP / w, sqrtP * w, true, px * 4);
  assert.ok(above > 1000 && above < 1300, `above-band value ${above}`);
  // token price halves -> sqrtP rises past the upper bound: all token, marked at the lower price
  const below = seatValueUsd(L, sqrtP * 2, sqrtP / w, sqrtP * w, true, px / 4);
  assert.ok(below < 600, `below-band value ${below}`);
});

test("simulateSeat earns pro-rata fees, scales at ignition, and exits on the time stop", () => {
  const s = tape(2000, { start: 0, usd: 500, L: 1e17, senders: 40, stepSec: 15 }); // 8.3h of steady $500 swaps
  const r = simulateSeat(s, 0.03, true, { probeUsd: 150, scaleUsd: 1500, width: 1.5, ignitionTs: 300, maxAgeSec: 6 * 3600, rolloverDropPct: 30, crowdingMultiple: 3, outOfRangeExitSec: 1800, floorFrac: 0.6 });
  assert.equal(r.exitReason, "time stop");
  assert.equal(r.scaledTs, 300);
  assert.ok(r.feesUsd > 0);
  assert.ok(Math.abs(r.valueAtExitUsd - 1500) < 2, `flat price keeps the seat at par: ${r.valueAtExitUsd}`);
  assert.ok(r.netUsd > 0 && r.netUsd < r.feesUsd, `net ${r.netUsd} fees ${r.feesUsd}`);
});

test("simulateSeat floors out of a dump instead of riding it for the whole out-of-range window", () => {
  // Price collapses to a quarter within minutes: without the floor the sim
  // held this for outOfRangeExitSec and marked the entire ride.
  const px = (sqrtP: number) => sqrtP * sqrtP;
  const mk = (t: number, sqrtP: number): SwapSample => ({ t, sqrtP, px: px(sqrtP), usd: 100, L: 1e18, sender: "0xa" });
  const tape = [mk(0, 1), mk(60, 0.95), mk(120, 0.85), mk(180, 0.7), mk(240, 0.5), mk(3000, 0.4), mk(3600, 0.3)];
  const r = simulateSeat(tape, 0.03, true, { probeUsd: 150, scaleUsd: 1500, width: 1.5, ignitionTs: null, maxAgeSec: 24 * 3600, rolloverDropPct: 30, crowdingMultiple: 100, outOfRangeExitSec: 1800, floorFrac: 0.6 });
  assert.equal(r.exitReason, "floor", "the hard bound fires before the slow exits");
  assert.ok(r.exitTs !== null && r.exitTs <= 300, "floored during the collapse, not after the window");
  assert.ok(r.netUsd > -150 * 0.65, "loss bounded near (1 - floorFrac) of capital plus costs");
});

test("simulateSeat exits when the pool gets crowded and reports no tape on empty input", () => {
  const s = tape(50, { start: 0, L: 1e17 });
  s[30].L = 5e17;
  const r = simulateSeat(s, 0.03, true, { probeUsd: 150, scaleUsd: 1500, width: 1.5, ignitionTs: null, maxAgeSec: 6 * 3600, rolloverDropPct: 30, crowdingMultiple: 3, outOfRangeExitSec: 1800, floorFrac: 0.6 });
  assert.equal(r.exitReason, "crowded out");
  assert.equal(r.exitTs, s[30].t);
  assert.equal(simulateSeat([], 0.03, true, { probeUsd: 150, scaleUsd: 1500, width: 1.5, ignitionTs: null, maxAgeSec: 1, rolloverDropPct: 30, crowdingMultiple: 3, outOfRangeExitSec: 1, floorFrac: 0.6 }).exitReason, "no tape");
});

test("simulateSeat exits on a two-hour volume roll-over", () => {
  const a = tape(360, { start: 0, usd: 1000, stepSec: 10, L: 1e17 }); // hour 0: $360k
  const b = tape(360, { start: 3600, usd: 1000, stepSec: 10, L: 1e17 }); // hour 1: $360k
  const c = tape(360, { start: 7200, usd: 500, stepSec: 10, L: 1e17 }); // hour 2: -50%
  const d = tape(360, { start: 10800, usd: 200, stepSec: 10, L: 1e17 }); // hour 3: -60%
  const e = tape(60, { start: 14400, usd: 200, stepSec: 10, L: 1e17 }); // hour 4: the check runs here
  const r = simulateSeat([...a, ...b, ...c, ...d, ...e], 0.03, true, { probeUsd: 150, scaleUsd: 1500, width: 1.5, ignitionTs: null, maxAgeSec: 24 * 3600, rolloverDropPct: 30, crowdingMultiple: 100, outOfRangeExitSec: 1800, floorFrac: 0.6 });
  assert.equal(r.exitReason, "volume roll-over");
  assert.equal(r.exitTs, 14400);
});

test("hourlyTable aggregates per hour with distinct senders", () => {
  const t = hourlyTable(tape(120, { start: 0, stepSec: 60, senders: 7 }), 0.01);
  assert.equal(t.length, 2);
  assert.equal(t[0].swaps, 60);
  assert.equal(t[0].senders, 7);
  assert.equal(Math.round(t[0].fees), 60);
});
