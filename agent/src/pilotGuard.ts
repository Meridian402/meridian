// The 24/7 pilot-sleeve guard: the ONLY manager of the hands-off pools
// (PONS et al). Designed with the operator on 2026-08-14, hours after the
// first pilot slid out of its band with no reflexes at all, and deliberately
// small: it does exactly three things and nothing else.
//
//   1. COLLECT fees on a clock (every few minutes, gas-guarded) while a
//      position is in range.
//   2. RE-CENTER a position that fell out of range, but only once the tape
//      has STABILIZED: out for a minimum age AND no longer moving away.
//      Re-centering into a falling market is the meme desk's bleed pattern,
//      and it is the one move this guard exists to refuse. (Below-band
//      management can be switched off with MERIDIAN_PILOT_RECENTER_BELOW=off,
//      leaving the floor and the dump exit as the only below-band exits.)
//   3. THE FLOOR: position worth below a hard dollar floor -> withdraw to
//      cash and stop. Bounded worst case, no debate at 3am.
//
// It never opens fresh positions (operator-only via lp-open), never resizes,
// never chases venues. The stock guard's clock is US market hours and is
// wrong for these 24/7 pools; that is why this file exists.
import { lpPositionsWithValue, uncollectedFeesUsd, collectFees, withdrawPosition, poolTick, mintDumpBid, type LpPositionValue } from "./venues/lpPositions.js";
import { getPublicClient } from "./venues/signer.js";
import { parseAbiItem } from "viem";
import { realSellStockForUsdg, tokenAddressFor, poolFeePct, USDG } from "./venues/stockPools.js";
import { walletOpsAvailable } from "./risk.js";
import { openInPool, HANDS_OFF_SYMBOLS } from "./lpGuard.js";
import { getAgentSigner } from "./venues/signer.js";
import { withHouseWalletLock, operatorWaiting } from "./houseWallet.js";
import { appendLedger } from "./ledger.js";
import { enqueuePendingSell, retryPendingSells, sellSymbolsOrEnqueue } from "./pendingSells.js";
import { portfolioStoodDown } from "./portfolioBreaker.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { venueEarnsAdmission, venueFeeUsd24h, venueChurnAdmits } from "./attribution.js";
import { latestDumpReading, dumpExitVerdict, recordDumpExit, dumpLockoutUntil, switchedOff } from "./dumpWatch.js";

// The tick is half the collect cadence so a 5-minute collect lands on the
// interval instead of on the next 3-minute wake (2026-09-01, operator:
// collects every 5 minutes, not at a dollar amount).
const CHECK_MS = 150 * 1000;
// COLLECT ON A CLOCK, NOT A THRESHOLD (2026-09-01). An in-range seat collects
// on the first tick at or past MERIDIAN_COLLECT_EVERY_MIN since its last
// collect. The gas guard: a collect is ~145k gas, about $0.19 at ETH $2,433,
// so a seat that has accrued less than MERIDIAN_COLLECT_MIN_USD waits for the
// next tick rather than paying gas to move pennies (0 disables the guard).
// Collects never counted toward the wallet-ops runaway cap (only buys, sells,
// mints and skims do), so the cadence is bounded by gas alone.
const COLLECT_EVERY_MS = Number(process.env.MERIDIAN_COLLECT_EVERY_MIN ?? 5) * 60 * 1000;
const COLLECT_MIN_USD = Number(process.env.MERIDIAN_COLLECT_MIN_USD ?? 1);
const FLOOR_USD = Number(process.env.MERIDIAN_PILOT_FLOOR_USD ?? 120);
// THE WAIT IS ASYMMETRIC (operator insight, 2026-08-14). The two exits are
// not the same trade. Exit BELOW: the position holds the fallen token, and
// re-centering REALIZES the drift, so patience protects real money there.
// Exit ABOVE: the position holds pure USDG (it sold the token on the way up
// at good prices), there is nothing to realize, and every waiting minute on
// a pumping pool is fees not earned. Down waits for proof; up only debounces.
const RECENTER_BELOW_MIN_MS = Number(process.env.MERIDIAN_PILOT_RECENTER_MIN ?? 30) * 60 * 1000;
const RECENTER_ABOVE_MIN_MS = Number(process.env.MERIDIAN_PILOT_RECENTER_ABOVE_MIN ?? 12) * 60 * 1000;
// THE RE-BAND WIDTH (2026-09-01, operator: "open at more width"). ±10% was
// the pilot's width. Replayed on the BONER and MICRODUCK Swap logs it sat
// out of range most of the day and floored in five of six windows, while
// ±20-30% bands stayed in range 85-100% of the time and netted more on half
// the fee density. Total width: 50 => about -20%/+25% in price.
const REBAND_WIDTH_PCT = Number(process.env.MERIDIAN_REBAND_WIDTH_PCT ?? 50);
const REBAND_LABEL = `-${(100 * (1 - 1 / (1 + REBAND_WIDTH_PCT / 200))).toFixed(0)}%/+${(REBAND_WIDTH_PCT / 2).toFixed(0)}%`;
// THE BELOW-BAND CLOCK STAYS ON (2026-09-01, operator's question). It was
// switched off for an hour on a replay that skipped the settle test and the
// break exit; with both modeled, every below-band event on the BONER and
// MICRODUCK tapes was worth +$10 to +$32 on a $485 seat (sell half early,
// earn on the bounce, realize at the band edge instead of the floor). The
// day's actual loss was an ABOVE re-center that re-bought at +25.6% before
// a 17% drop. Off is available for a venue that keeps V-recovering through
// its old band; it leaves the floor and the dump exit as the only exits.
const RECENTER_BELOW = (process.env.MERIDIAN_PILOT_RECENTER_BELOW ?? "on") !== "off";
/** Price still moving away faster than this (pct over the stability window) blocks a re-center. */
const STABLE_DRIFT_PCT = 1.0;
const STABILITY_WINDOW_MS = 30 * 60 * 1000;
const STABILITY_WINDOW_ABOVE_MS = 12 * 60 * 1000;

interface TickSample {
  t: number;
  tick: number;
}

/**
 * PURE: may this out-of-range position re-center now?
 * Requirements, both mandatory:
 *   - out of range for at least minOutMs (no knee-jerk reaction to a wick)
 *   - over the stability window, price has NOT kept moving away from the
 *     band by more than stableDriftPct (the tape has stopped falling/rising
 *     through us; sideways or coming back both qualify)
 * `awayIsTickDown` orients the test: for a token that is currency0, price
 * falls as the tick falls, so "moving away below the band" is tick-down.
 */
export function recenterVerdict(
  outSinceMs: number | undefined,
  now: number,
  samples: readonly TickSample[],
  awayIsTickDown: boolean,
  minOutMs = RECENTER_BELOW_MIN_MS,
  stableDriftPct = STABLE_DRIFT_PCT,
  windowMs = STABILITY_WINDOW_MS,
): { act: boolean; reason: string } {
  if (outSinceMs == null) return { act: false, reason: "not marked out of range yet" };
  const outFor = now - outSinceMs;
  if (outFor < minOutMs) return { act: false, reason: `out ${Math.round(outFor / 60000)}m of ${Math.round(minOutMs / 60000)}m minimum` };
  const windowStart = now - windowMs;
  const inWindow = samples.filter((s) => s.t >= windowStart);
  if (inWindow.length < 2) return { act: false, reason: "not enough tape history to judge stability" };
  const first = inWindow[0].tick;
  const last = inWindow[inWindow.length - 1].tick;
  // tick -> price is exponential; over small windows pct ~ 0.01 * dTicks.
  const movePct = (last - first) * 0.01;
  const awayPct = awayIsTickDown ? -movePct : movePct;
  if (awayPct > stableDriftPct) {
    return { act: false, reason: `tape still moving away ${awayPct.toFixed(1)}% over the window; waiting for it to settle` };
  }
  return { act: true, reason: `out ${Math.round(outFor / 60000)}m and the tape has settled (${awayPct >= 0 ? "-" : "+"}${Math.abs(awayPct).toFixed(1)}% window move)` };
}

/** PURE: may an out-of-range seat be managed (re-centered, break-exited) on
 *  this side of its band? Above: always. Below: unless the operator switched
 *  below-band management off; the floor and the dump exit apply regardless. */
export function outOfRangeManaged(belowBand: boolean, recenterBelow = RECENTER_BELOW): boolean {
  return !belowBand || recenterBelow;
}

/** PURE: is an in-range seat due for a collect? Due when the cadence has
 *  elapsed since its last collect (or it has not collected this process
 *  life) AND the accrued fees clear the gas guard. Nothing accrued, nothing
 *  to collect, whatever the guard. */
export function collectDue(lastCollectMs: number | undefined, now: number, accruedUsd: number, everyMs = COLLECT_EVERY_MS, minUsd = COLLECT_MIN_USD, tickMs = CHECK_MS): boolean {
  if (!(accruedUsd > 0) || accruedUsd < minUsd) return false;
  // Half a tick of slack: the tick that lands right at the cadence can read a
  // few milliseconds short of it and push the collect to the NEXT tick, which
  // turned a 5-minute clock into 5-or-7.5 (seen 15:06 on day one). With the
  // slack, every second tick collects.
  return lastCollectMs == null || now - lastCollectMs >= everyMs - tickMs / 2;
}

/** PURE: has the floor been breached? Fees are deliberately EXCLUDED
 *  (bleed audit, 2026-08-18): counting fees toward the floor spent earned
 *  income as extra drawdown room, so the better a seat had done, the deeper
 *  its principal was allowed to fall before protection fired. The floor
 *  bounds principal; income is income. */
export function floorBreached(valueUsd: number, floorUsd = FLOOR_USD): boolean {
  return valueUsd < floorUsd;
}

/** PURE: the floor for a position, SCALED to what actually went in. The env
 *  floor was calibrated to the first ~$146 pilot; left fixed, a $300
 *  position would tolerate a 60% loss before it tripped. The floor is the
 *  larger of the env floor and 80% of the deposit, so protection scales with
 *  the position automatically. depositUsd 0/unknown falls back to the env. */
export function effectiveFloorUsd(depositUsd: number, envFloorUsd = FLOOR_USD): number {
  return depositUsd > 0 ? Math.max(envFloorUsd, 0.8 * depositUsd) : envFloorUsd;
}

const outSince = new Map<string, number>();
const lastCollect = new Map<string, number>();
const tickHistory = new Map<string, TickSample[]>();

/** PURE: is the hands-off board falling together? (bleed program phase 2.)
 *  On 08-18 every seat drifted down at once and each was judged alone. Two
 *  or more pools falling past the bar over the window is one chain-wide
 *  move, and re-centering into it is the bleed pattern this guard refuses. */
export function sleeveBoardRed(priceDriftPcts: readonly number[], minPools = 2, dropPct = 2): boolean {
  return priceDriftPcts.filter((d) => d <= -dropPct).length >= minPools;
}

/** Window price drift per hands-off pool, oriented so negative = falling. */
function handsOffBoardDrifts(now: number): number[] {
  const out: number[] = [];
  for (const [symbol, hist] of tickHistory) {
    const win = hist.filter((s) => now - s.t <= STABILITY_WINDOW_MS);
    if (win.length < 2) continue;
    const token = tokenAddressFor(symbol);
    if (!token) continue;
    const tokenIsC0 = token.toLowerCase() < USDG.toLowerCase();
    out.push((win[win.length - 1].tick - win[0].tick) * 0.01 * (tokenIsC0 ? 1 : -1));
  }
  return out;
}

// THE FLOOR LINEAGE (bleed audit, 2026-08-18). Each re-center used to mint
// a fresh position whose recorded deposit was the depressed budget, and the
// 80%-of-deposit floor reset from that lower basis: a stair-step decline
// with one re-center did not floor until ~34% below the original mint. The
// lineage carries the ORIGINAL deposit across re-centers, on disk so a
// redeploy cannot amnesty it, and the floor bounds the SEAT, not the band.
const LINEAGE_PATH = dataPath("pilot-lineage.json");
function loadLineage(): Record<string, number> {
  try {
    return existsSync(LINEAGE_PATH) ? (JSON.parse(readFileSync(LINEAGE_PATH, "utf8")) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function setLineage(tokenId: string, depositUsd: number): void {
  try {
    const l = loadLineage();
    l[tokenId] = depositUsd;
    writeFileSync(LINEAGE_PATH, JSON.stringify(l, null, 2));
  } catch (err) {
    console.error(`[pilotGuard] lineage save failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }
}
function clearLineage(tokenId: string): void {
  try {
    const l = loadLineage();
    if (!(tokenId in l)) return;
    delete l[tokenId];
    writeFileSync(LINEAGE_PATH, JSON.stringify(l, null, 2));
  } catch {
    /* a stale entry is harmless: it only ever RAISES a floor */
  }
}

// THE PAYBACK GATE (2026-08-20). Churn became the desk's main cost once
// the catastrophic losses were fixed: seats cycled 2-3 re-centers a day at
// roughly 1-2% friction each, quietly eating the fees they were chasing.
// The allocator prices its switches ("$24 cost, pays back in 0.7d"); the
// re-center path never did. A re-center now has to show that the venue's
// MEASURED hourly fee rate repays the churn inside the payback horizon, or
// the seat stays where it is. A venue that banked nothing in 24h earns no
// churn at all, which is the honest reading of a $0 fee line.
const PAYBACK_HOURS = Number(process.env.MERIDIAN_RECENTER_PAYBACK_HOURS ?? 12);

/** PURE: does a re-center's churn cost pay back within the horizon? */
export function recenterPaysBack(costUsd: number, feePerHourUsd: number, horizonHours = PAYBACK_HOURS): boolean {
  return feePerHourUsd * horizonHours >= costUsd;
}

// THE BREAK EXIT (bleed audit, 2026-08-18). Between the band bottom (-7%)
// and the floor (-22%) a below-band seat is 100% token, delta 1, earning
// nothing: pure downside with no income. If the tape has refused to settle
// for this long after the band broke down, the seat realizes ~-7% now
// instead of -22% later; roughly two fee-days instead of five. 0 disables.
const BREAK_EXIT_MS = Number(process.env.MERIDIAN_PILOT_BREAK_EXIT_MIN ?? 45) * 60 * 1000;

// THE DUMP BID (2026-08-28, operator: earn on the way down too). While a
// venue sits in its post-dump-exit lockout, the desk places ONE small
// all-USDG band below the fall. Panic sellers filling through it pay us the
// pool fee; what it buys, it buys at a discount chosen in advance. The
// USDG-sleeve sibling of the meme catcher, with the same shape of bounds:
// one bid per lockout, a hard size cap, a daily count, and a kill switch.
const DUMP_BID_ON = !switchedOff(process.env.MERIDIAN_DUMP_BID);
// $150, not $100 (audit 2026-08-30): a filled bid becomes a seat whose floor
// is max($120 env, 80% of deposit); a $100 bid sat UNDER its own floor and
// would have been floor-exited the tick it filled, cycling buy-then-dump.
// dumpBidDecision refuses any size that cannot survive its own fill.
const DUMP_BID_USD = Number(process.env.MERIDIAN_DUMP_BID_USD ?? 150);
const DUMP_BID_DEPTH_PCT = Number(process.env.MERIDIAN_DUMP_BID_DEPTH_PCT ?? 8);
const DUMP_BID_WIDTH_PCT = Number(process.env.MERIDIAN_DUMP_BID_WIDTH_PCT ?? 6);
const DUMP_BIDS_PER_DAY = Number(process.env.MERIDIAN_DUMP_BIDS_PER_DAY ?? 3);
const DUMP_BID_STATE = dataPath("dump-bids.json");

interface DumpBidState {
  [symbol: string]: { tokenId: string; placedAt: number; filled?: boolean };
}
function loadDumpBids(): DumpBidState {
  try {
    return existsSync(DUMP_BID_STATE) ? (JSON.parse(readFileSync(DUMP_BID_STATE, "utf8")) as DumpBidState) : {};
  } catch {
    return {};
  }
}
function saveDumpBids(s: DumpBidState): void {
  try {
    writeFileSync(DUMP_BID_STATE, JSON.stringify(s, null, 2));
  } catch (err) {
    console.error(`[pilotGuard] dump-bid state save failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
}
/** Bids placed today (ET), counted from the ledger rather than a memory cell:
 *  a crash-loop redeploy must not refresh the budget (audit 2026-08-30), and
 *  the desk's day boundary is ET everywhere else, so it is here too. */
function dumpBidsPlacedTodayET(): number {
  const p = dataPath("pilot-guard.jsonl");
  if (!existsSync(p)) return 0;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let n = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.includes('"dump-bid"')) continue;
    try {
      const r = JSON.parse(line) as { ts: number; kind?: string };
      if (r.kind === "dump-bid" && new Date(r.ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today) n++;
    } catch { /* skip */ }
  }
  return n;
}

/** PURE: place a dump bid in this venue now? Exported for tests. */
export function dumpBidDecision(args: {
  enabled: boolean;
  lockoutUntil: number | undefined;
  now: number;
  venueSeats: number;
  hasActiveBid: boolean;
  usdgAvailUsd: number;
  bidUsd: number;
  envFloorUsd: number;
  bidsToday: number;
  bidsPerDay: number;
  stoodDown: boolean;
}): { act: boolean; reason: string } {
  if (!args.enabled) return { act: false, reason: "dump bid disabled (MERIDIAN_DUMP_BID=off)" };
  // A bid that cannot survive its own fill is a machine for buying and
  // instantly floor-selling: the filled seat's floor is max(env, 80% of
  // deposit), and the fill lands with the value roughly at deposit. Demand
  // 10% of clearance so a normal fill never starts life below its floor.
  const fillFloor = Math.max(args.envFloorUsd, 0.8 * args.bidUsd);
  if (args.bidUsd * 0.9 <= fillFloor) {
    return { act: false, reason: `bid size $${args.bidUsd} would sit under its own $${fillFloor.toFixed(0)} floor at fill; raise MERIDIAN_DUMP_BID_USD` };
  }
  if (!args.lockoutUntil || args.now >= args.lockoutUntil) return { act: false, reason: "no active dump lockout; the bid only stands under one" };
  if (args.venueSeats > 0) return { act: false, reason: "venue still holds seats; the bid is for a flattened venue only" };
  if (args.hasActiveBid) return { act: false, reason: "one bid per lockout, and it is already resting" };
  if (args.stoodDown) return { act: false, reason: "portfolio stand-down: no new exposure of any shape" };
  if (args.bidsToday >= args.bidsPerDay) return { act: false, reason: `daily dump-bid budget (${args.bidsPerDay}) spent` };
  if (args.usdgAvailUsd < args.bidUsd) return { act: false, reason: `wallet USDG $${args.usdgAvailUsd.toFixed(0)} under the $${args.bidUsd} bid size` };
  return { act: true, reason: "flattened venue in lockout, budget available" };
}

/** Where the resting bid's tokenId lives, if this venue has one. */
function activeDumpBid(symbol: string): DumpBidState[string] | undefined {
  return loadDumpBids()[symbol.toUpperCase()];
}

async function maybePlaceDumpBids(positions: readonly LpPositionValue[]): Promise<void> {
  if (!DUMP_BID_ON) return;
  const now = Date.now();
  // Reconcile the state file against the live board first: a record whose
  // position no longer exists (closed by any path outside this file, or a
  // mint whose tokenId was never resolved) would otherwise block the venue's
  // bids forever via hasActiveBid (audit 2026-08-30).
  {
    const s = loadDumpBids();
    let changed = false;
    for (const [sym, rec] of Object.entries(s)) {
      const live = positions.some((p) => String(p.tokenId) === rec.tokenId);
      if (!live && (!dumpLockoutUntil(sym, now) || rec.tokenId === "unknown")) {
        console.error(`[pilotGuard] dump-bid record for ${sym} (#${rec.tokenId}) has no live position; clearing the stale record`);
        delete s[sym];
        changed = true;
      }
    }
    if (changed) saveDumpBids(s);
  }
  for (const symbol of HANDS_OFF_SYMBOLS) {
    const lockUntil = dumpLockoutUntil(symbol, now);
    if (!lockUntil) continue; // the common case, checked before anything costs a call
    let usdgAvailUsd = 0;
    try {
      const raw = await getPublicClient().readContract({
        address: USDG,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [getAgentSigner()!.address],
      });
      usdgAvailUsd = Number(raw) / 1e6;
    } catch {
      continue; // no balance read, no bid; next tick retries
    }
    const call = dumpBidDecision({
      enabled: DUMP_BID_ON,
      lockoutUntil: lockUntil,
      now,
      venueSeats: positions.filter((p) => p.symbol === symbol).length,
      hasActiveBid: !!activeDumpBid(symbol),
      usdgAvailUsd,
      bidUsd: DUMP_BID_USD,
      envFloorUsd: FLOOR_USD,
      bidsToday: dumpBidsPlacedTodayET(),
      bidsPerDay: DUMP_BIDS_PER_DAY,
      stoodDown: portfolioStoodDown(),
    });
    if (!call.act) continue;
    if (!walletOpsAvailable(1)) continue;
    try {
      // No inner house-wallet lock: runTick already holds it (the lock is
      // non-reentrant and rejected every nested acquisition, which kept this
      // feature dead on arrival; audit 2026-08-30).
      const rec = await mintDumpBid({ symbol, depthPct: DUMP_BID_DEPTH_PCT, widthPct: DUMP_BID_WIDTH_PCT, bidUsd: DUMP_BID_USD });
      const s = loadDumpBids();
      s[symbol.toUpperCase()] = { tokenId: rec.tokenId, placedAt: now };
      saveDumpBids(s);
      appendLedger("pilot-guard.jsonl", { ts: now, kind: "dump-bid", tokenId: rec.tokenId, symbol, valueUsd: rec.usdgIn });
      console.error(
        `[pilotGuard] DUMP BID: $${rec.usdgIn.toFixed(2)} USDG resting ${DUMP_BID_DEPTH_PCT}% below ${symbol} (#${rec.tokenId}); sellers filling through it pay us the fee`,
      );
    } catch (err) {
      console.error(`[pilotGuard] dump bid on ${symbol} failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    }
  }
}

async function runTick(): Promise<void> {
  // The sell queue first, before the position check can return early: a
  // stranded token is unhedged exposure whether or not any position is open.
  // 6,329 PONS rode the 08-18 dump because the failed sale was only a log line.
  await retryPendingSells();
  const positions = (await lpPositionsWithValue()).filter((p) => HANDS_OFF_SYMBOLS.has(p.symbol));
  // The dump bid places when a venue is FLAT and locked out, so it must run
  // before (and regardless of) the empty-board early return below.
  await maybePlaceDumpBids(positions);
  if (positions.length === 0) {
    outSince.clear();
    return;
  }
  // The admission gate credits a venue's OPEN exposure against its cash-out
  // flow (mints read as pure cash out until they close). With several bands in
  // one pool, crediting only the single position being re-centered under-counts
  // the venue's committed capital and reads a roughly-flat venue as a deep
  // loss, wrongly blocking re-centers (2026-08-23: PONS showed -$724 with ~$888
  // open). Credit the venue's TOTAL open value instead.
  const venueOpenUsd = new Map<string, number>();
  for (const p of positions) venueOpenUsd.set(p.symbol, (venueOpenUsd.get(p.symbol) ?? 0) + p.valueUsd);
  for (const p of positions) {
    try {
      await managePosition(p, venueOpenUsd.get(p.symbol) ?? p.valueUsd);
    } catch (err) {
      console.error(`[pilotGuard] #${p.tokenId} (${p.symbol}) check failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    }
  }
}

async function managePosition(p: LpPositionValue, venueOpenUsd: number): Promise<void> {
  const key = String(p.tokenId);
  const now = Date.now();
  const tick = await poolTick(p.symbol);
  const hist = tickHistory.get(p.symbol) ?? tickHistory.set(p.symbol, []).get(p.symbol)!;
  hist.push({ t: now, tick });
  while (hist.length > 60) hist.shift();

  const fees = await uncollectedFeesUsd(p).catch(() => 0);

  // THE RESTING DUMP BID is not a seat to manage, it is an order working:
  // while unfilled it holds only USDG (nothing to floor, nothing to
  // re-center), and the normal exit-above reflex would yank it 12 minutes
  // after placement. When its lockout window closes unfilled, it comes home
  // to cash for the cost of gas. When price fills into it, it graduates to a
  // normal seat: lineage from its own deposit, every guard from then on.
  const bid = activeDumpBid(p.symbol);
  const isBidSeat = !!bid && bid.tokenId === key;
  if (isBidSeat && !bid!.filled) {
    const tokenIsC0Bid = (tokenAddressFor(p.symbol) ?? "").toLowerCase() < USDG.toLowerCase();
    const unfilled = tokenIsC0Bid ? tick >= p.tickUpper : tick <= p.tickLower;
    if (unfilled) {
      if (!dumpLockoutUntil(p.symbol, now)) {
        console.error(`[pilotGuard] dump bid #${p.tokenId} (${p.symbol}) expired unfilled; withdrawing the USDG`);
        await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "dump-bid-expire" });
        if (p.tokenAmount * p.tokenPriceUsd > 1) await sellSymbolsOrEnqueue([p.symbol], "dump-bid-expire");
        appendLedger("pilot-guard.jsonl", { ts: now, kind: "dump-bid-expire", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd });
        const s = loadDumpBids();
        delete s[p.symbol.toUpperCase()];
        saveDumpBids(s);
        outSince.delete(key);
      }
      return; // resting: leave the order alone
    }
    // Filled (or filling): promote to a managed seat. The record stays,
    // marked filled, until the lockout rolls off: that mark is what exempts
    // exactly this seat (and no other) from the dump-exit below while the
    // pressure that placed it may still be printing.
    console.error(`[pilotGuard] dump bid #${p.tokenId} (${p.symbol}) FILLED at the discount; promoting to a managed seat`);
    setLineage(key, p.usdgIn > 0 ? p.usdgIn : p.valueUsd);
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "dump-bid-fill", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd });
    const s = loadDumpBids();
    s[p.symbol.toUpperCase()] = { ...bid!, filled: true };
    saveDumpBids(s);
    // fall through: from here it is a seat like any other (minus dump-exit
    // during its own lockout)
  } else if (isBidSeat && bid!.filled && !dumpLockoutUntil(p.symbol, now)) {
    // Lockout over: the graduated seat loses its exemption and the record.
    const s = loadDumpBids();
    delete s[p.symbol.toUpperCase()];
    saveDumpBids(s);
  }

  // 0. THE DUMP EXIT (2026-08-28, operator decision after the midday CASHCAT
  // dump). Checked before everything, in-range included: the whole point is
  // to act DURING the leg, while the band is still converting USDG into the
  // falling token, not after the exit-below machinery has ridden it down.
  // The three-condition pressure signal (dominant + accelerating + rolling
  // over) is the trigger; the verdict declines on a disarmed switch or a
  // stale reading. Exits deliberately ignore the stand-down, same as the
  // floor: selling is always allowed.
  // Exempt ONLY the venue's own dump bid, never its other seats: the first
  // audit shipped a venue-wide lockout gate here, which meant the first
  // seat's exit vetoed the exit of every remaining seat in a multi-seat
  // venue for the whole lockout, exactly the seats the signal was armed to
  // cut (audit 2026-08-30). A just-filled bid keeps its exemption while its
  // lockout runs (cutting it on the pressure that placed it undoes the
  // strategy at its moment of working); the floor and break-exit still
  // bound it throughout.
  const dumpCall = dumpExitVerdict(latestDumpReading(p.symbol), now);
  if (dumpCall.act && !isBidSeat) {
    console.error(`[pilotGuard] DUMP EXIT: #${p.tokenId} (${p.symbol}) worth $${p.valueUsd.toFixed(2)}, ${dumpCall.reason}; flattening to cash now instead of riding the leg`);
    await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "dump-exit" });
    const sold = await sellSymbolsOrEnqueue([p.symbol], "dump-exit");
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "dump-exit", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd, feesUsd: fees, soldUsd: sold[0]?.usdgReceived ?? 0 });
    recordDumpExit(p.symbol, now);
    clearLineage(key);
    outSince.delete(key);
    return;
  }

  // 3. THE FLOOR, checked before any management: a bleeding position does not get managed,
  // it gets closed. Worst case is bounded by construction. Deposit basis is
  // the LINEAGE deposit when this band came from a re-center chain, else
  // ~2x the recorded USDG side (balanced mint); no basis falls back to env.
  const mintDepositUsd = p.hasCostBasis && p.usdgIn > 0 ? p.usdgIn * 2 : 0;
  const depositUsd = loadLineage()[key] ?? mintDepositUsd;
  const floorUsd = effectiveFloorUsd(depositUsd);
  if (floorBreached(p.valueUsd, floorUsd)) {
    console.error(`[pilotGuard] FLOOR: #${p.tokenId} (${p.symbol}) worth $${p.valueUsd.toFixed(2)} < $${floorUsd.toFixed(0)}: withdrawing to cash`);
    await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "floor-exit" });
    // Sell whatever token inventory the withdraw returned; USDG stays cash.
    // A failed sale is NOT done: it goes on the pending-sells queue and
    // retries every tick until the inventory is actually cash.
    try {
      await realSellStockForUsdg({ fromSymbol: p.symbol });
    } catch (err) {
      console.error(`[pilotGuard] floor exit: token sale failed, queueing for retry: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      enqueuePendingSell(p.symbol, "floor-exit sale failed");
    }
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "floor-exit", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd, feesUsd: fees });
    clearLineage(key);
    outSince.delete(key);
    return;
  }

  if (p.inRange) {
    outSince.delete(key);
    // 1. COLLECT on the clock while earning. The clock is stamped BEFORE the
    // send so a collect that fails waits a full cadence instead of retrying
    // every tick.
    if (collectDue(lastCollect.get(key), now, fees)) {
      console.error(`[pilotGuard] collecting $${fees.toFixed(2)} from #${p.tokenId} (${p.symbol})`);
      lastCollect.set(key, now);
      await collectFees({ tokenId: p.tokenId, symbol: p.symbol });
      appendLedger("pilot-guard.jsonl", { ts: now, kind: "collect", tokenId: p.tokenId, symbol: p.symbol, feesUsd: fees });
    }
    return;
  }

  // 2. OUT OF RANGE: wait for stabilization, then re-center at the re-band
  // width. (With below-band management switched off, a seat below its band
  // holds for the floor or the dump exit instead.)
  const token = tokenAddressFor(p.symbol);
  if (!token) return;
  const tokenIsC0 = token.toLowerCase() < USDG.toLowerCase();
  // Which side did we exit? Below the band means the position is all token
  // and "away" is price falling further. Price falls as tick falls when the
  // token is currency0, and as tick rises when it is currency1.
  const belowBand = tokenIsC0 ? tick < p.tickLower : tick >= p.tickUpper;
  const awayIsTickDown = tokenIsC0 ? belowBand : !belowBand;
  if (!outSince.has(key)) {
    outSince.set(key, now);
    console.error(
      outOfRangeManaged(belowBand)
        ? `[pilotGuard] #${p.tokenId} (${p.symbol}) left its band ${belowBand ? "below" : "above"}; watching for stabilization before any re-center`
        : `[pilotGuard] #${p.tokenId} (${p.symbol}) fell below its band; holding for the floor or the dump exit (below-band re-centers off)`,
    );
    return;
  }
  if (!outOfRangeManaged(belowBand)) return; // quiet hold below the band; the floor above already had its say
  // Below: the slow clock (drift realization risk). Above: the fast clock
  // (all-USDG, nothing to realize, missed fees are the only cost).
  const minOut = belowBand ? RECENTER_BELOW_MIN_MS : RECENTER_ABOVE_MIN_MS;
  const window = belowBand ? STABILITY_WINDOW_MS : STABILITY_WINDOW_ABOVE_MS;
  const verdict = recenterVerdict(outSince.get(key), now, hist, awayIsTickDown, minOut, STABLE_DRIFT_PCT, window);
  if (!verdict.act) {
    // The break exit: below the band, past the break window, and the tape
    // STILL has not earned a re-center. Exits ignore the portfolio
    // stand-down by design; selling is always allowed.
    const outFor = now - (outSince.get(key) ?? now);
    if (belowBand && BREAK_EXIT_MS > 0 && outFor >= BREAK_EXIT_MS) {
      console.error(`[pilotGuard] BREAK EXIT: #${p.tokenId} (${p.symbol}) out below its band ${Math.round(outFor / 60000)}m with no stabilization (${verdict.reason}); realizing at ~the band edge instead of riding to the floor`);
      await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "break-exit" });
      const sold = await sellSymbolsOrEnqueue([p.symbol], "break-exit");
      appendLedger("pilot-guard.jsonl", { ts: now, kind: "break-exit", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd, feesUsd: fees, soldUsd: sold[0]?.usdgReceived ?? 0 });
      clearLineage(key);
      outSince.delete(key);
    }
    return; // quiet: the state line is logged on transitions, not every tick
  }
  // A re-center is a withdraw AND a re-open. During a portfolio stand-down
  // the open half is blocked, so starting the withdraw half would only turn
  // a position into loose inventory. Checked BEFORE the withdraw, on purpose.
  if (portfolioStoodDown()) {
    return;
  }
  // Phase 2 gates, also before the withdraw: a board falling together is one
  // chain-wide move (this pool's local landing is not evidence), and a venue
  // whose measured record is under the admission floor re-earns entry by
  // time, not by looking settled for thirty minutes.
  if (sleeveBoardRed(handsOffBoardDrifts(now))) {
    console.error(`[pilotGuard] re-center of ${p.symbol} refused: the hands-off board is falling together; waiting out the chain-wide move`);
    return;
  }
  const realized = venueEarnsAdmission("usdg", p.symbol, venueOpenUsd + fees);
  if (!realized.ok) {
    console.error(`[pilotGuard] re-center of ${p.symbol} refused by its own record: ${realized.reason}`);
    return;
  }
  // THE CHURN-CYCLE BRAKE: the 7-day floor above is too slow to catch a run of
  // small losing recenters within a single evening. This looks at just the
  // last few cycles, not the last week.
  const churn = venueChurnAdmits("usdg", p.symbol);
  if (!churn.ok) {
    console.error(`[pilotGuard] re-center of ${p.symbol} refused by the churn brake: ${churn.reason}`);
    return;
  }
  const budget = p.valueUsd + fees;
  // The payback gate: churn cost ~ one full budget through the pool fee
  // plus a spread-and-gas allowance. The earn rate counts fees banked in
  // 24h plus what this position has accrued uncollected (a young seat's
  // only evidence), read pessimistically over a day.
  const feePerHour = Math.max(venueFeeUsd24h("usdg", p.symbol), fees) / 24;
  const costEstUsd = budget * ((poolFeePct(p.symbol) || 0.3) / 100) * 1.2 + 0.25;
  if (!recenterPaysBack(costEstUsd, feePerHour)) {
    console.error(`[pilotGuard] re-center of ${p.symbol} refused by the payback gate: ~$${costEstUsd.toFixed(2)} churn vs $${(feePerHour * PAYBACK_HOURS).toFixed(2)} expected fees in ${PAYBACK_HOURS}h`);
    return;
  }
  // Never start what we cannot finish: a re-center is up to four wallet ops
  // (withdraw, sell, buy, mint). If the whole sequence does not fit under
  // the runaway-ops cap, none of it starts.
  if (!walletOpsAvailable(4)) {
    console.error(`[pilotGuard] re-center of ${p.symbol} deferred: not enough op budget for the full withdraw+reopen sequence`);
    return;
  }
  console.error(`[pilotGuard] re-centering #${p.tokenId} (${p.symbol}): ${verdict.reason}; re-banding ~$${budget.toFixed(2)} at width ${REBAND_WIDTH_PCT} (${REBAND_LABEL})`);
  await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "recenter-close" });
  outSince.delete(key);
  try {
    const pos = await openInPool(p.symbol, REBAND_WIDTH_PCT, budget);
    // The new band inherits the ORIGINAL deposit: the floor keeps bounding
    // the seat's cumulative loss, not each band's local one.
    if (depositUsd > 0) setLineage(String(pos.tokenId), depositUsd);
    clearLineage(key);
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "recenter", closed: p.tokenId, opened: pos.tokenId, symbol: p.symbol, budgetUsd: budget });
    console.error(`[pilotGuard] ✓ ${p.symbol} re-centered as #${pos.tokenId}`);
  } catch (err) {
    // The withdraw already happened: the token side is loose in the wallet.
    // Never leave it there (the PONS lesson): sell it back to cash now, or
    // queue it if the sale fails too.
    console.error(`[pilotGuard] re-center of ${p.symbol} could not re-open (${err instanceof Error ? err.message.slice(0, 120) : err}); liquidating the loose inventory`);
    const sold = await sellSymbolsOrEnqueue([p.symbol], "re-center re-open failed");
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "recenter-abort", closed: p.tokenId, symbol: p.symbol, soldUsd: sold[0]?.usdgReceived ?? 0 });
    clearLineage(key);
  }
}

/** One guard, 3-minute cadence, serialized with everything else on the house
 *  wallet. Gated on the signer exactly like the other loops. */
export function startPilotGuard(): NodeJS.Timeout | undefined {
  if (!getAgentSigner()) return undefined;
  let running = false;
  const tickFn = async () => {
    if (running) return;
    if (operatorWaiting()) return; // yield to the human; next tick is 3 minutes away
    running = true;
    try {
      await withHouseWalletLock("pilotGuard.tick", runTick);
    } catch (err) {
      console.error(`[pilotGuard] tick failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tickFn(), CHECK_MS);
  timer.unref?.();
  void tickFn();
  console.error(
    `[pilotGuard] armed: 24/7 clock over {${[...HANDS_OFF_SYMBOLS].join(", ")}}: collect every ${COLLECT_EVERY_MS / 60000}m (gas guard $${COLLECT_MIN_USD}), re-center ${RECENTER_BELOW ? `${RECENTER_BELOW_MIN_MS / 60000}m below` : "below OFF (floor or dump exit only)"} / ${RECENTER_ABOVE_MIN_MS / 60000}m above + stable tape, re-band width ${REBAND_WIDTH_PCT} (${REBAND_LABEL}), floor $${FLOOR_USD}`,
  );
  return timer;
}
