// The 24/7 pilot-sleeve guard: the ONLY manager of the hands-off pools
// (PONS et al). Designed with the operator on 2026-08-14, hours after the
// first pilot slid out of its band with no reflexes at all, and deliberately
// small: it does exactly three things and nothing else.
//
//   1. COLLECT fees on a threshold while a position is in range.
//   2. RE-CENTER a position that fell out of range, but only once the tape
//      has STABILIZED: out for a minimum age AND no longer moving away.
//      Re-centering into a falling market is the meme desk's bleed pattern,
//      and it is the one move this guard exists to refuse.
//   3. THE FLOOR: position worth below a hard dollar floor -> withdraw to
//      cash and stop. Bounded worst case, no debate at 3am.
//
// It never opens fresh positions (operator-only via lp-open), never resizes,
// never chases venues. The stock guard's clock is US market hours and is
// wrong for these 24/7 pools; that is why this file exists.
import { lpPositionsWithValue, uncollectedFeesUsd, collectFees, withdrawPosition, poolTick, type LpPositionValue } from "./venues/lpPositions.js";
import { realSellStockForUsdg, tokenAddressFor, poolFeePct } from "./venues/stockPools.js";
import { walletOpsAvailable } from "./risk.js";
import { openInPool, HANDS_OFF_SYMBOLS } from "./lpGuard.js";
import { getAgentSigner } from "./venues/signer.js";
import { withHouseWalletLock, operatorWaiting } from "./houseWallet.js";
import { appendLedger } from "./ledger.js";
import { enqueuePendingSell, retryPendingSells, sellSymbolsOrEnqueue } from "./pendingSells.js";
import { portfolioStoodDown } from "./portfolioBreaker.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { venueEarnsAdmission, venueFeeUsd24h } from "./attribution.js";

const CHECK_MS = 3 * 60 * 1000;
const COLLECT_THRESHOLD_USD = Number(process.env.MERIDIAN_COLLECT_THRESHOLD_USD ?? 3);
const FLOOR_USD = Number(process.env.MERIDIAN_PILOT_FLOOR_USD ?? 120);
// THE WAIT IS ASYMMETRIC (operator insight, 2026-08-14). The two exits are
// not the same trade. Exit BELOW: the position holds the fallen token, and
// re-centering REALIZES the drift, so patience protects real money there.
// Exit ABOVE: the position holds pure USDG (it sold the token on the way up
// at good prices), there is nothing to realize, and every waiting minute on
// a pumping pool is fees not earned. Down waits for proof; up only debounces.
const RECENTER_BELOW_MIN_MS = Number(process.env.MERIDIAN_PILOT_RECENTER_MIN ?? 30) * 60 * 1000;
const RECENTER_ABOVE_MIN_MS = Number(process.env.MERIDIAN_PILOT_RECENTER_ABOVE_MIN ?? 12) * 60 * 1000;
const REBAND_WIDTH_PCT = 20; // ±10%, the width the pilot proved
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
const tickHistory = new Map<string, TickSample[]>();
const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

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
    const tokenIsC0 = token.toLowerCase() < USDG_ADDR.toLowerCase();
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

async function runTick(): Promise<void> {
  // The sell queue first, before the position check can return early: a
  // stranded token is unhedged exposure whether or not any position is open.
  // 6,329 PONS rode the 08-18 dump because the failed sale was only a log line.
  await retryPendingSells();
  const positions = (await lpPositionsWithValue()).filter((p) => HANDS_OFF_SYMBOLS.has(p.symbol));
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

  // 3. THE FLOOR, checked first: a bleeding position does not get managed,
  // it gets closed. Worst case is bounded by construction. Deposit basis is
  // the LINEAGE deposit when this band came from a re-center chain, else
  // ~2x the recorded USDG side (balanced mint); no basis falls back to env.
  const mintDepositUsd = p.hasCostBasis && p.usdgIn > 0 ? p.usdgIn * 2 : 0;
  const depositUsd = loadLineage()[key] ?? mintDepositUsd;
  const floorUsd = effectiveFloorUsd(depositUsd);
  if (floorBreached(p.valueUsd, floorUsd)) {
    console.error(`[pilotGuard] FLOOR: #${p.tokenId} (${p.symbol}) worth $${p.valueUsd.toFixed(2)} < $${floorUsd.toFixed(0)} — withdrawing to cash`);
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
    // 1. COLLECT while earning, same threshold discipline as the stock guard.
    if (fees >= COLLECT_THRESHOLD_USD) {
      console.error(`[pilotGuard] collecting $${fees.toFixed(2)} from #${p.tokenId} (${p.symbol})`);
      await collectFees({ tokenId: p.tokenId, symbol: p.symbol });
      appendLedger("pilot-guard.jsonl", { ts: now, kind: "collect", tokenId: p.tokenId, symbol: p.symbol, feesUsd: fees });
    }
    return;
  }

  // 2. OUT OF RANGE: wait for stabilization, then re-center at the proven width.
  if (!outSince.has(key)) {
    outSince.set(key, now);
    console.error(`[pilotGuard] #${p.tokenId} (${p.symbol}) left its band; watching for stabilization before any re-center`);
    return;
  }
  const token = tokenAddressFor(p.symbol);
  if (!token) return;
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const tokenIsC0 = token.toLowerCase() < USDG.toLowerCase();
  // Which side did we exit? Below the band means the position is all token
  // and "away" is price falling further. Price falls as tick falls when the
  // token is currency0, and as tick rises when it is currency1.
  const belowBand = tokenIsC0 ? tick < p.tickLower : tick >= p.tickUpper;
  const awayIsTickDown = tokenIsC0 ? belowBand : !belowBand;
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
  console.error(`[pilotGuard] re-centering #${p.tokenId} (${p.symbol}): ${verdict.reason}; re-banding ~$${budget.toFixed(2)} at ±${REBAND_WIDTH_PCT / 2}%`);
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
    `[pilotGuard] armed: 24/7 clock over {${[...HANDS_OFF_SYMBOLS].join(", ")}} — collect ≥$${COLLECT_THRESHOLD_USD}, re-center ${RECENTER_BELOW_MIN_MS / 60000}m below / ${RECENTER_ABOVE_MIN_MS / 60000}m above + stable tape, floor $${FLOOR_USD}`,
  );
  return timer;
}
