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
import { realSellStockForUsdg, tokenAddressFor } from "./venues/stockPools.js";
import { openInPool, HANDS_OFF_SYMBOLS } from "./lpGuard.js";
import { getAgentSigner } from "./venues/signer.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { appendLedger } from "./ledger.js";

const CHECK_MS = 3 * 60 * 1000;
const COLLECT_THRESHOLD_USD = Number(process.env.MERIDIAN_COLLECT_THRESHOLD_USD ?? 3);
const FLOOR_USD = Number(process.env.MERIDIAN_PILOT_FLOOR_USD ?? 120);
const RECENTER_MIN_OUT_MS = Number(process.env.MERIDIAN_PILOT_RECENTER_MIN ?? 45) * 60 * 1000;
const REBAND_WIDTH_PCT = 20; // ±10%, the width the pilot proved
/** Price still moving away faster than this (pct over the stability window) blocks a re-center. */
const STABLE_DRIFT_PCT = 1.0;
const STABILITY_WINDOW_MS = 30 * 60 * 1000;

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
  minOutMs = RECENTER_MIN_OUT_MS,
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

/** PURE: has the floor been breached? Value INCLUDES uncollected fees: the
 *  floor bounds what we can lose, and fees owed are still ours. */
export function floorBreached(valueUsd: number, feesUsd: number, floorUsd = FLOOR_USD): boolean {
  return valueUsd + feesUsd < floorUsd;
}

const outSince = new Map<string, number>();
const tickHistory = new Map<string, TickSample[]>();

async function runTick(): Promise<void> {
  const positions = (await lpPositionsWithValue()).filter((p) => HANDS_OFF_SYMBOLS.has(p.symbol));
  if (positions.length === 0) {
    outSince.clear();
    return;
  }
  for (const p of positions) {
    try {
      await managePosition(p);
    } catch (err) {
      console.error(`[pilotGuard] #${p.tokenId} (${p.symbol}) check failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    }
  }
}

async function managePosition(p: LpPositionValue): Promise<void> {
  const key = String(p.tokenId);
  const now = Date.now();
  const tick = await poolTick(p.symbol);
  const hist = tickHistory.get(p.symbol) ?? tickHistory.set(p.symbol, []).get(p.symbol)!;
  hist.push({ t: now, tick });
  while (hist.length > 60) hist.shift();

  const fees = await uncollectedFeesUsd(p).catch(() => 0);

  // 3. THE FLOOR, checked first: a bleeding position does not get managed,
  // it gets closed. Worst case is bounded by construction.
  if (floorBreached(p.valueUsd, fees)) {
    console.error(`[pilotGuard] FLOOR: #${p.tokenId} (${p.symbol}) worth $${(p.valueUsd + fees).toFixed(2)} < $${FLOOR_USD} — withdrawing to cash`);
    await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
    // Sell whatever token inventory the withdraw returned; USDG stays cash.
    try {
      await realSellStockForUsdg({ fromSymbol: p.symbol });
    } catch (err) {
      console.error(`[pilotGuard] floor exit: token sale failed (inventory stays in wallet): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
    appendLedger("pilot-guard.jsonl", { ts: now, kind: "floor-exit", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd, feesUsd: fees });
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
  const verdict = recenterVerdict(outSince.get(key), now, hist, awayIsTickDown);
  if (!verdict.act) {
    return; // quiet: the state line is logged on transitions, not every tick
  }
  const budget = p.valueUsd + fees;
  console.error(`[pilotGuard] re-centering #${p.tokenId} (${p.symbol}): ${verdict.reason}; re-banding ~$${budget.toFixed(2)} at ±${REBAND_WIDTH_PCT / 2}%`);
  await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
  outSince.delete(key);
  const pos = await openInPool(p.symbol, REBAND_WIDTH_PCT, budget);
  appendLedger("pilot-guard.jsonl", { ts: now, kind: "recenter", closed: p.tokenId, opened: pos.tokenId, symbol: p.symbol, budgetUsd: budget });
  console.error(`[pilotGuard] ✓ ${p.symbol} re-centered as #${pos.tokenId}`);
}

/** One guard, 3-minute cadence, serialized with everything else on the house
 *  wallet. Gated on the signer exactly like the other loops. */
export function startPilotGuard(): NodeJS.Timeout | undefined {
  if (!getAgentSigner()) return undefined;
  let running = false;
  const tickFn = async () => {
    if (running) return;
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
  console.error(`[pilotGuard] armed: 24/7 clock over {${[...HANDS_OFF_SYMBOLS].join(", ")}} — collect ≥$${COLLECT_THRESHOLD_USD}, re-center after ${RECENTER_MIN_OUT_MS / 60000}m out + stable tape, floor $${FLOOR_USD}`);
  return timer;
}
