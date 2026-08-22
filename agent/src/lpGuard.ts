// LP discipline, automated. Runs even with AGENT_LIVE_TRADING=false (this is
// position protection, not signal trading). A clock-derived phase machine
// reconciles each open position to the right shape:
//
//   weekday-market  → TIGHT (±1%): maximum fee share; re-center when price
//                     walks out of range for RECENTER_AFTER_MIN.
//   weekend         → WIDE (±4%): the "tap the 24/7 market" mode. Our markout
//                     scan (2026-07-13) showed LPs came out AHEAD even across
//                     the toxic weekend + Monday open — fees beat the drift.
//                     So instead of exiting Friday, we WIDEN: a wide range is
//                     far harder to pick off yet still harvests the weekend
//                     arb churn. Tail guard: if price drifts past
//                     MAX_WEEKEND_DRIFT_PCT from the range center, pull
//                     entirely (something real happened; sit it out).
//   weekday-off     → hold as-is; off-hours moves are informed, don't chase.
//
// State is derived from the clock and each position's own tick span, so a
// guard restart loses nothing.
//
// This starts only when MERIDIAN_LP_ENGINE=on (see index.ts), but it is not
// gated by AGENT_LIVE_TRADING, because protecting an open position must keep
// working when signal trading is off. The practical consequence: any process
// running with the engine on and holding AGENT_SIGNER_PRIVATE_KEY is a live
// guard over the house wallet, so exactly one may run at a time. See the note
// on getAgentSigner in venues/signer.ts.
import { openPositionsOnChain, withdrawPosition, mintRange, poolTick, lastMintedPosition, lastPoolOnChain, uncollectedFeesUsd, collectFees, type LpPositionRecord } from "./venues/lpPositions.js";
import { realBuyStockFromNative, realSellStockForUsdg, poolPricesUsd, isTradable, isAutoExecutable, poolFeePct, unwrapWeth, swapNativeToUsdg, tokenAddressFor } from "./venues/stockPools.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { getAgentSigner, getPublicClient } from "./venues/signer.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { latestScan, scanOpportunities } from "./lpAllocator.js";
import { parseAbiItem, type Address } from "viem";
import { withHouseWalletLock, operatorWaiting } from "./houseWallet.js";
import { walletOpsAvailable } from "./risk.js";
import { memeRotorTick } from "./memeGuard.js";
import { portfolioStoodDown } from "./portfolioBreaker.js";
import { readFileSync as _rf, writeFileSync as _wf, existsSync as _ex } from "node:fs";
import { dataPath } from "./dataDir.js";

// Durable anti-churn state. The rebalance/recovery cooldowns and the recovery
// failure count MUST survive a redeploy — otherwise every restart silently
// resets the guards that prevent oscillation, and a fresh boot could immediately
// re-rebalance or re-recover a position that should still be on cooldown. The
// clock-derived phase state is already restart-safe; this covers the counters
// that aren't. Persisted to the /data volume.
const GUARD_STATE_PATH = dataPath("lp-guard-state.json");
function loadGuardState(): { lastRebalanceAt: number; lastRecoveryAt: number; recoveryFailures: number } {
  try {
    if (_ex(GUARD_STATE_PATH)) {
      const s = JSON.parse(_rf(GUARD_STATE_PATH, "utf8"));
      return {
        lastRebalanceAt: Number(s.lastRebalanceAt) || 0,
        lastRecoveryAt: Number(s.lastRecoveryAt) || 0,
        recoveryFailures: Number(s.recoveryFailures) || 0,
      };
    }
  } catch {}
  return { lastRebalanceAt: 0, lastRecoveryAt: 0, recoveryFailures: 0 };
}
function saveGuardState(): void {
  try {
    _wf(GUARD_STATE_PATH, JSON.stringify({ lastRebalanceAt, lastRecoveryAt, recoveryFailures }));
  } catch {}
}
const _guardState = loadGuardState();

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const CHECK_MS = 5 * 60 * 1000;
const RECENTER_AFTER_MIN = 30;
// Auto-collect: realize owed fees into the wallet once they're worth the
// (negligible) gas, so a long in-range stretch doesn't leave money sitting
// uncollected. Position changes already sweep fees; this covers the gaps.
const COLLECT_THRESHOLD_USD = Number(process.env.MERIDIAN_COLLECT_THRESHOLD_USD ?? 3);
const TIGHT_WIDTH_PCT = 2; // ±1%
const WEEKEND_WIDTH_PCT = 8; // ±4%
const WIDE_THRESHOLD_HALFPCT = 2.5; // separates a tight (~1.2%) from a wide (~4%) range
const MAX_WEEKEND_DRIFT_PCT = 2.5; // drift from range center that trips a full weekend pull
// Market hours in US EASTERN TIME, computed properly: 9:30 to 16:00 ET.
// Weekend mode begins at the Friday close and runs until Monday's open
// settles. This replaced fixed UTC offsets on 2026-08-14: those were correct
// only for the DST half of the year and would have silently shifted every
// boundary by an hour at the November clock change.
const FRIDAY = 5;
const MARKET_OPEN_MIN = 9 * 60 + 30;
const MARKET_CLOSE_MIN = 16 * 60;
const WEEKEND_START_MIN = 15 * 60 + 50; // Friday: widen just before the close
const MONDAY_SETTLE_MIN = 10 * 60; // Monday: re-tighten 30min after the open

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const ET_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The instant's US-Eastern weekday and minutes-since-midnight, DST-correct. */
function easternParts(now: Date): { day: number; mins: number } {
  const parts = ET_FMT.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Some ICU builds print midnight as "24" with hour12:false; normalize.
  const hour = Number(get("hour")) % 24;
  return { day: ET_DAYS.indexOf(get("weekday")), mins: hour * 60 + Number(get("minute")) };
}

const outOfRangeSince = new Map<string, number>();

// Pools the guard must NOT manage or auto-enter: chain-native 24/7 venues
// (surfaced by the USDG flow scan) run as a MANUAL pilot sleeve. This guard's
// whole phase machine is keyed to US stock hours — re-tighten at the open,
// widen for the weekend — and every one of those moves is wrong for a token
// that trades around the clock. Their positions are opened, watched and closed
// by the operator until a 24/7 management clock exists. Env-overridable so a
// pool can graduate without a deploy.
export const HANDS_OFF_SYMBOLS = new Set(
  (process.env.MERIDIAN_GUARD_HANDS_OFF ?? "PONS,TTWO,STONKBROKER").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
);

// ---- Auto-rebalance ("most profitable at all times") -------------------------
// The house agent moves capital to the best pool ON ITS OWN when the gain clears
// a cost-aware bar. OFF by default — this is autonomous real-money movement, so
// it's an explicit opt-in (MERIDIAN_AUTO_REBALANCE=1), with a gain floor,
// payback cap, and a hold-cooldown to prevent churn/oscillation.
const AUTO_REBALANCE = process.env.MERIDIAN_AUTO_REBALANCE === "1";
const REBALANCE_MIN_GAIN_USD_DAY = Number(process.env.MERIDIAN_REBALANCE_MIN_GAIN_USD ?? 2);
const REBALANCE_MAX_PAYBACK_DAYS = Number(process.env.MERIDIAN_REBALANCE_MAX_PAYBACK_DAYS ?? 2);
const REBALANCE_COOLDOWN_MS = Number(process.env.MERIDIAN_REBALANCE_COOLDOWN_HOURS ?? 8) * 60 * 60 * 1000;
let lastRebalanceAt = _guardState.lastRebalanceAt;

export type Phase = "weekend" | "weekday-market" | "weekday-off";

export function phaseOf(now: Date): Phase {
  const { day, mins } = easternParts(now); // 0=Sun … 6=Sat, US Eastern
  if (day === 6 || day === 0) return "weekend"; // Sat/Sun
  if (day === FRIDAY && mins >= WEEKEND_START_MIN) return "weekend"; // Fri close onward
  if (day === 1 && mins < MONDAY_SETTLE_MIN) return "weekend"; // Mon pre-open + settle
  if (day >= 1 && day <= 5 && mins >= MARKET_OPEN_MIN && mins < MARKET_CLOSE_MIN) return "weekday-market";
  return "weekday-off";
}

/** A position's ±half-width in %, from its own tick span. */
function halfWidthPct(p: { tickLower: number; tickUpper: number }): number {
  return (1.0001 ** ((p.tickUpper - p.tickLower) / 2) - 1) * 100;
}

/** How far current price has drifted from a range's geometric center, in %. */
function driftFromCenterPct(p: { tickLower: number; tickUpper: number }, currentTick: number): number {
  const centerTick = (p.tickLower + p.tickUpper) / 2;
  // No /2 here. halfWidthPct halves because its input is a full width; this
  // input is ALREADY a distance from the center, and halving it reported
  // about half the true drift, so the weekend tail guard rode to roughly
  // twice its configured threshold before pulling.
  return Math.abs(1.0001 ** (currentTick - centerTick) - 1) * 100;
}

/** Even up the two sides of the pair from wallet balances so a fresh two-sided range can mint. */
async function rebalanceSides(symbol: string): Promise<void> {
  const signer = getAgentSigner()!;
  const [balances, prices, usdgRaw] = await Promise.all([
    readStockBalances(signer.address),
    poolPricesUsd(),
    getPublicClient().readContract({
      address: USDG,
      abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
      functionName: "balanceOf",
      args: [signer.address],
    }),
  ]);
  const usdg = Number(usdgRaw) / 1e6;
  const tokenVal = (balances[symbol] ?? 0) * (prices[symbol] ?? 0);
  const diff = usdg - tokenVal; // positive: too much cash, buy token
  if (Math.abs(diff) < 10) return;
  if (diff > 0) await realBuyStockFromNative({ toSymbol: symbol, amountUsd: diff / 2 });
  else await realSellStockForUsdg({ fromSymbol: symbol, amountTokens: (Math.abs(diff) / 2) / (prices[symbol] ?? 1) });
}

/** Withdraw a position, even up the pair, and re-mint at the target width. Capital is safe in the wallet between the withdraw and a (retried) mint. */
async function retileTo(p: { tokenId: string; symbol: string; liquidity: string }, widthPct: number, reason: string): Promise<void> {
  console.error(`[lpGuard] ${reason} #${p.tokenId} (${p.symbol}): withdraw -> rebalance -> re-mint ±${widthPct / 2}%`);
  await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
  outOfRangeSince.delete(String(p.tokenId));
  await rebalanceSides(p.symbol);
  // The mint prices amounts at execution time; in fast markets a single
  // attempt can bust its caps (learned live). Retry with fresh reads.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const next = await mintRange({ symbol: p.symbol, widthPct });
      console.error(`[lpGuard] ✓ ${p.symbol} re-tiled as #${next.tokenId} ticks[${next.tickLower},${next.tickUpper}] (±${widthPct / 2}%)`);
      return;
    } catch (err) {
      console.error(`[lpGuard] re-mint attempt ${attempt}/3 failed: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  console.error(`[lpGuard] ✗ ${p.symbol} re-tile incomplete: capital is rebalanced in the wallet; retries next cycle`);
}

// ---- Auto-recovery: if a retile fails all its retries, or a weekend drift
// pull fires, the wallet is left FLAT (holding cash + stock, no LP position)
// and — without this — would sit idle out of the market indefinitely, since
// the guard otherwise only manages EXISTING positions. Recovery re-establishes
// the position, but only under hard guards so it can never run away with money:
//   · same pool as the last position (no cross-pool bets)
//   · market hours only (never auto-enter informed off-hours flow)
//   · that pool must still be viable (allocator says fee-positive)
//   · capital capped at ~the last deployment (never auto-scales; excess defers
//     to manual — your say-so)
//   · cooldown + a failure limit so a broken mint can't burn gas in a loop
const MIN_RECOVERY_USD = 50;
const HARD_RECOVERY_CAP_USD = Number(process.env.MERIDIAN_MAX_RECOVERY_USD ?? 2000);
const RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_RECOVERY_FAILURES = 3;
let lastRecoveryAt = _guardState.lastRecoveryAt;
let recoveryFailures = _guardState.recoveryFailures;
const USDG_ADDR: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

async function attemptRecovery(): Promise<void> {
  if (Date.now() - lastRecoveryAt > 2 * 60 * 60 * 1000 && recoveryFailures !== 0) { recoveryFailures = 0; saveGuardState(); } // fresh chance after a long quiet gap
  if (Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
  if (recoveryFailures >= MAX_RECOVERY_FAILURES) return; // gave up — needs manual attention

  // Which pool to re-enter comes from CHAIN first: the wallet still owns the
  // emptied position NFT, and it knows its own pool. The file registry is only a
  // fallback for the case where chain discovery can't answer — it knows only
  // what this backend minted, so trusting it first could re-deploy real capital
  // into a pool we already left.
  const target = (await lastPoolOnChain()) ?? lastMintedPosition()?.symbol ?? null;
  if (!target) return; // never held a position; nothing to recover to
  if (HANDS_OFF_SYMBOLS.has(target)) return; // the manual sleeve recovers by the operator's hand, never this path's
  if (!isAutoExecutable(target)) {
    console.error(`[lpGuard] recovery held: ${target} is not auto-executable (no landed mint on record) — manual review.`);
    return;
  }

  const scan = latestScan() ?? (await scanOpportunities().catch(() => null));
  const opp = scan?.opportunities.find((o) => o.symbol === target);
  if (!opp || !opp.viable) {
    console.error(`[lpGuard] recovery held: ${target} pool isn't fee-positive right now — staying flat (manual review).`);
    return;
  }

  const signer = getAgentSigner()!;
  const [balances, prices, usdgRaw] = await Promise.all([
    readStockBalances(signer.address),
    poolPricesUsd(),
    getPublicClient().readContract({ address: USDG_ADDR, abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")], functionName: "balanceOf", args: [signer.address] }),
  ]);
  const deployable = Number(usdgRaw) / 1e6 + (balances[target] ?? 0) * (prices[target] ?? 0);
  if (deployable < MIN_RECOVERY_USD) return; // nothing meaningful to redeploy
  // The operator's MERIDIAN_MAX_RECOVERY_USD IS the deliberate anti-runaway
  // bound. The old extra `lastDeposit × 1.25` guard broke recovery after a
  // rebalance/dust-absorb left the LAST mint tiny ($34 → cap $43), refusing to
  // redeploy the real $181. The env cap alone is the right bound.
  const cap = HARD_RECOVERY_CAP_USD;
  if (deployable > cap) {
    console.error(`[lpGuard] recovery held: deployable $${deployable.toFixed(0)} exceeds cap $${cap.toFixed(0)} (MERIDIAN_MAX_RECOVERY_USD) — deferring to manual.`);
    return;
  }

  lastRecoveryAt = Date.now();
  saveGuardState();
  try {
    console.error(`[lpGuard] AUTO-RECOVERY: flat with $${deployable.toFixed(2)} deployable, re-entering ${target} (last pool).`);
    await rebalanceSides(target);
    const pos = await mintRange({ symbol: target, widthPct: TIGHT_WIDTH_PCT });
    recoveryFailures = 0;
    saveGuardState();
    console.error(`[lpGuard] ✓ recovered as #${pos.tokenId} (${target})`);
  } catch (err) {
    recoveryFailures++;
    saveGuardState();
    console.error(`[lpGuard] ✗ recovery failed (${recoveryFailures}/${MAX_RECOVERY_FAILURES}): ${err instanceof Error ? err.message.slice(0, 120) : err} — capital safe in wallet.`);
  }
}

/**
 * Operator-driven: open a fresh market-making position in a SPECIFIC tradable
 * pool (e.g. move to a newly-discovered one like SPCX). Same primitives as
 * auto-recovery — balance the two sides, then mint a tight range — but the
 * caller chooses the pool instead of it defaulting to the last one held. Run on
 * a flat wallet (close the current position first); it deploys available USDG.
 */
export async function openInPool(symbol: string, widthPct: number = TIGHT_WIDTH_PCT, maxUsd?: number): Promise<{ tokenId: string; symbol: string }> {
  // Every seat entry funnels through here (operator lp-open, pilot re-center,
  // open-deploy), so this is the one gate the portfolio breaker needs on the
  // USDG side. A stand-down means the whole book just lost its limit with
  // every sleeve guard working; re-entering is an operator decision, made
  // deliberately via POST /api/admin/clear-halt, not a path a loop retries into.
  if (portfolioStoodDown()) {
    throw new Error("portfolio breaker stand-down is active: no new positions until the operator clears it (POST /api/admin/clear-halt)");
  }
  // Never start what we cannot finish: an open is up to three wallet ops
  // (funding swap, token buy, mint). Whole sequence fits or none of it runs.
  if (!walletOpsAvailable(3)) {
    throw new Error("not enough op budget under the runaway-ops cap for a full open (funding + buy + mint); retry after the rolling window clears");
  }
  // Size-capped entry (pilots): acquire ~half the budget in the token, then mint
  // a two-sided range hard-capped at maxUsd. Deliberately skips the full-balance
  // rebalanceSides and the dust-absorb so it can NEVER deploy more than the
  // budget — "a deliberate $50, not all available USDG".
  if (maxUsd && maxUsd > 0) {
    // Fund the two sides from whatever float the wallet holds: fold WETH into
    // native, count any token ALREADY held toward the token side (a retried
    // open must not re-buy inventory it bought last attempt), top up USDG from
    // ETH only for the real shortfall, then mint with retries — a hot pool can
    // move between the price read and execution and revert a single attempt
    // (measured live on PONS 2026-08-13; the replayed calldata succeeded).
    try { await unwrapWeth(); } catch (e) { console.error(`[lpGuard] pre-open unwrap skipped: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    const signer = getAgentSigner()!;
    const client = getPublicClient();
    const balAbi = [parseAbiItem("function balanceOf(address) view returns (uint256)")];
    const token = tokenAddressFor(symbol);
    const [usdgRaw, tokenRaw, prices] = await Promise.all([
      client.readContract({ address: USDG, abi: balAbi, functionName: "balanceOf", args: [signer.address] }),
      token ? client.readContract({ address: token, abi: balAbi, functionName: "balanceOf", args: [signer.address] }) : Promise.resolve(0n),
      poolPricesUsd(),
    ]);
    let usdgHave = Number(usdgRaw) / 1e6;
    let tokenHaveUsd = (Number(tokenRaw) / 1e18) * (prices[symbol] ?? 0);
    // THE RE-CENTER REALIZATION FIX (bleed audit, 2026-08-18). A below-band
    // re-center used to arrive here holding ~the whole budget in token, buy
    // nothing, pull FRESH USDG in for the mint side, and leave half a budget
    // of token loose and unfloored: token exposure unchanged, seat capital
    // ~1.5x, nothing realized. Excess token above the mint's half-budget is
    // now SOLD first, so the re-open funds its own USDG side and the drift
    // the guard waited out is actually realized, not re-risked.
    const excessTokenUsd = tokenHaveUsd - maxUsd / 2;
    if (excessTokenUsd > 5 && (prices[symbol] ?? 0) > 0) {
      try {
        const sold = await realSellStockForUsdg({ fromSymbol: symbol, amountTokens: excessTokenUsd / prices[symbol] });
        usdgHave += sold.usdgReceived;
        tokenHaveUsd -= excessTokenUsd;
        console.error(`[lpGuard] sold $${excessTokenUsd.toFixed(2)} excess ${symbol} before the open: realized, not re-risked`);
      } catch (e) {
        console.error(`[lpGuard] excess-token sell failed, opening with what we hold: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
    const buyUsd = Math.max(0, maxUsd / 2 - tokenHaveUsd);
    const usdgNeed = maxUsd / 2 + buyUsd; // mint side + what the token buy will spend
    if (usdgHave < usdgNeed * 0.99) {
      const ethUsd = await fetchEthUsd();
      const ethHaveUsd = (Number(await client.getBalance({ address: signer.address })) / 1e18) * ethUsd;
      const GAS_RESERVE_USD = 5;
      const short = usdgNeed - usdgHave;
      if (ethHaveUsd - GAS_RESERVE_USD < short) {
        throw new Error(
          `insufficient float to fund $${maxUsd}: have $${usdgHave.toFixed(2)} USDG + $${tokenHaveUsd.toFixed(2)} ${symbol} + ~$${ethHaveUsd.toFixed(2)} ETH. Move more WETH to ${signer.address}.`,
        );
      }
      console.error(`[lpGuard] funding USDG side: swapping ~$${(short + 1).toFixed(2)} ETH -> USDG`);
      await swapNativeToUsdg(short + 1); // +$1 buffer for slippage
    }
    if (buyUsd > 5) await realBuyStockFromNative({ toSymbol: symbol, amountUsd: buyUsd });
    else if (tokenHaveUsd > 0) console.error(`[lpGuard] token side already funded: holding $${tokenHaveUsd.toFixed(2)} of ${symbol}`);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pos = await mintRange({ symbol, widthPct, maxUsd });
        console.error(`[lpGuard] operator opened CAPPED #${pos.tokenId} in ${symbol} (±${widthPct / 2}%, ≤$${maxUsd})`);
        return { tokenId: pos.tokenId, symbol: pos.symbol };
      } catch (err) {
        lastErr = err;
        console.error(`[lpGuard] capped mint attempt ${attempt}/3 failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  await rebalanceSides(symbol);
  const pos = await mintRange({ symbol, widthPct });
  console.error(`[lpGuard] operator opened #${pos.tokenId} in ${symbol} (±${widthPct / 2}%)`);
  // Coarse-tick pools (1% tier, tickSpacing 200) snap the range lopsidedly and
  // strand a chunk of the token side as an idle holding — which silently eats
  // the "profit" of being in a higher-rate pool. Absorb it in one extra mint so
  // capital actually deploys. (Accepts a second same-pool position; the guard
  // manages both. Better than leaving ~18% idle.)
  try {
    const signer = getAgentSigner();
    if (signer) {
      const [bal, prices] = await Promise.all([readStockBalances(signer.address), poolPricesUsd()]);
      const dustUsd = (bal[symbol] ?? 0) * (prices[symbol] ?? 0);
      if (dustUsd > 10) {
        await rebalanceSides(symbol);
        await mintRange({ symbol, widthPct });
        console.error(`[lpGuard] absorbed ~$${dustUsd.toFixed(0)} of stranded ${symbol} into a second range`);
      }
    }
  } catch (err) {
    console.error(`[lpGuard] dust-absorb skipped: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
  return { tokenId: pos.tokenId, symbol: pos.symbol };
}

/**
 * Autonomous profit-seeking: if the allocator's best pool beats where we sit by
 * enough to clear the cost-aware bar, MOVE there (close all → open best).
 * Guarded six ways: opt-in env flag, market-hours only, all positions in ONE
 * pool and in-range (stable, not mid-recenter), a real gain floor, a payback
 * cap, and a hold-cooldown. Returns true if it acted (caller skips other upkeep
 * this tick). Capital is never at risk beyond a graceful flat-in-USDG on a
 * failed leg — recovery re-establishes.
 */
async function maybeRebalance(positions: LpPositionRecord[]): Promise<boolean> {
  if (!AUTO_REBALANCE) return false;
  if (Date.now() - lastRebalanceAt < REBALANCE_COOLDOWN_MS) return false;
  // The manual pilot sleeve is invisible to rebalancing in BOTH directions:
  // never a destination (filtered below) and never a source — this path
  // closes every position it considers, and it must not be able to unwind an
  // operator-held pilot to chase a stock pool.
  positions = positions.filter((p) => !HANDS_OFF_SYMBOLS.has(p.symbol));
  if (positions.length === 0) return false;
  const symbols = new Set(positions.map((p) => p.symbol));
  if (symbols.size !== 1) return false; // mixed/mid-move — let it settle first
  const currentSymbol = positions[0].symbol;

  // Only move from a STABLE (in-range) position — don't fight the re-center path.
  let tick: number;
  try {
    tick = await poolTick(currentSymbol);
  } catch {
    return false;
  }
  const allInRange = positions.every((p) => tick >= p.tickLower && tick < p.tickUpper);
  if (!allInRange) return false;

  const scan = latestScan() ?? (await scanOpportunities().catch(() => null));
  if (!scan) return false;
  // Both the gain and the switch cost below scale with capital, so a scan that
  // isn't sized from the real book cannot price this move. Sitting still is the
  // safe failure: a nominal-sized scan used to under-price the switch by the
  // ratio of the real book to $160.
  if (scan.sizedFrom !== "book") {
    console.error(`[lpGuard] rebalance skipped: scan sized from "${scan.sizedFrom}", not the real book — cannot price the move.`);
    return false;
  }
  // Best AUTO-EXECUTABLE pool — baseline-trusted or with a landed mint on record
  // (isAutoExecutable). NOT scan.best, which can be a discovered-but-unproven
  // pool (e.g. transfer-restricted SPCX: deep + high-volume but reverts on mint).
  //
  // `mintable` is the second half of that gate and it is not redundant:
  // isAutoExecutable answers per SYMBOL, but the scan ranks per (symbol × fee
  // tier). AAPL is baseline-trusted, so an "AAPL/USDG 0.05%" row passed the
  // symbol check — and openInPool("AAPL") then mints AAPL's configured 1% pool.
  // We would have scored one pool and bought a different one.
  const best = scan.opportunities
    .filter((o) => o.viable && o.mintable && isAutoExecutable(o.symbol) && !HANDS_OFF_SYMBOLS.has(o.symbol))
    .sort((a, b) => b.expectedNetPerDayUsd - a.expectedNetPerDayUsd)[0];
  if (!best || best.symbol === currentSymbol) return false;

  // Compare against the pool we are ACTUALLY in, matched on the position's own
  // fee tier — not merely the first row sharing its ticker.
  const curFee = positions[0].fee;
  const cur =
    scan.opportunities.find((o) => o.symbol === currentSymbol && (curFee == null || o.fee === curFee)) ??
    scan.opportunities.find((o) => o.symbol === currentSymbol);
  const gain = best.expectedNetPerDayUsd - (cur?.expectedNetPerDayUsd ?? 0);
  // REAL round-trip cost, not a flat 0.6%: sell the current stock (its pool fee)
  // + buy the target (its pool fee) + a gas/slippage/re-strand buffer. For 1%
  // pools that's ~2.3%, not 0.6% — the old flat rate made moves look 3x cheaper
  // than they are and churned away thin fee income on burst-noise "gains".
  const roundTripRate = poolFeePct(currentSymbol) / 100 + poolFeePct(best.symbol) / 100 + 0.003;
  // scan.capitalUsd is the real book (guaranteed by the sizedFrom check above),
  // so no `|| 160` fallback — that fallback was the bug, silently pricing a
  // move on $160 no matter how much was actually at stake.
  const switchCost = scan.capitalUsd * roundTripRate;
  const paybackDays = gain > 0 ? switchCost / gain : Infinity;
  if (gain < REBALANCE_MIN_GAIN_USD_DAY || paybackDays > REBALANCE_MAX_PAYBACK_DAYS) return false;

  lastRebalanceAt = Date.now();
  saveGuardState();
  console.error(
    `[lpGuard] AUTO-REBALANCE ${currentSymbol} → ${best.symbol}: +$${gain.toFixed(2)}/day, ~$${switchCost.toFixed(2)} switch, payback ${paybackDays.toFixed(1)}d`,
  );
  try {
    for (const p of positions) await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
    await realSellStockForUsdg({ fromSymbol: currentSymbol }).catch(() => {});
    const pos = await openInPool(best.symbol);
    console.error(`[lpGuard] ✓ rebalanced into ${best.symbol} (#${pos.tokenId})`);
  } catch (err) {
    // A failed move must NEVER strand capital flat: re-open the pool we left.
    console.error(`[lpGuard] ✗ rebalance open failed: ${err instanceof Error ? err.message.slice(0, 120) : err} — reverting to ${currentSymbol}`);
    try {
      const back = await openInPool(currentSymbol);
      console.error(`[lpGuard] ✓ reverted to ${currentSymbol} (#${back.tokenId}) after failed move`);
    } catch (e2) {
      console.error(`[lpGuard] ✗ fallback to ${currentSymbol} ALSO failed: ${e2 instanceof Error ? e2.message.slice(0, 120) : e2} — capital in USDG; recovery/manual.`);
    }
  }
  return true;
}

/** Sweep owed fees into the wallet when they clear the threshold. Called only when a position is staying put (retiles/withdraws already collect). */
async function maybeCollect(p: LpPositionRecord): Promise<void> {
  try {
    const fees = await uncollectedFeesUsd(p);
    if (fees >= COLLECT_THRESHOLD_USD) {
      console.error(`[lpGuard] auto-collect: sweeping $${fees.toFixed(2)} of fees from #${p.tokenId} (${p.symbol})`);
      await collectFees({ tokenId: p.tokenId, symbol: p.symbol });
    }
  } catch (err) {
    console.error(`[lpGuard] auto-collect check failed for #${p.tokenId}: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  }
}

async function pullEntirely(p: { tokenId: string; symbol: string; liquidity: string }, reason: string): Promise<void> {
  console.error(`[lpGuard] ${reason}: pulling #${p.tokenId} (${p.symbol}) entirely`);
  await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
  outOfRangeSince.delete(String(p.tokenId));
  console.error(`[lpGuard] ✓ #${p.tokenId} pulled; capital home in the wallet`);
}

export function startLpGuard(): NodeJS.Timeout {
  // A retile (withdraw → rebalance swap → up to 3 mint retries with waits) can
  // outlast the 5-min tick under congestion. Without this lock two ticks could
  // act on the same position concurrently — a real double-spend risk on money.
  let checking = false;
  let checkingSince = 0;
  const check = async () => {
    // Operator priority: never START a multi-minute hold while a human's
    // request is queued. The tick fires again in 5 minutes; the operator's
    // HTTP edge does not wait that politely.
    if (operatorWaiting()) {
      console.error("[lpGuard] yielding this tick: an operator request is waiting on the house lock");
      return;
    }
    if (checking) {
      const ageMin = Math.round((Date.now() - checkingSince) / 60000);
      console.error(`[lpGuard] previous tick still in flight (${ageMin}m) — skipping this one`);
      // A tick that has been "in flight" for half an hour is not in flight,
      // it is HUNG (2026-08-07: a stalled await froze the desk for 4 hours
      // behind this exact flag). Clear the dedup so fresh ticks can queue;
      // the house lock still serializes against the zombie if it ever wakes.
      if (ageMin >= 30) {
        console.error("[lpGuard] WATCHDOG: clearing the in-flight flag; investigate the hung await");
        checking = false;
      }
      return;
    }
    checking = true;
    checkingSince = Date.now();
    try {
      // Hold the global house-wallet lock for the whole tick so an operator
      // endpoint (lp-open/lp-close/index-trade) can't interleave a tx with a
      // retile/rebalance mid-flight. `checking` still de-dups overlapping ticks.
      await withHouseWalletLock("lpGuard.tick", runCheck);
    } finally {
      checking = false;
    }
  };
  const runCheck = async () => {
    const now = new Date();
    const phase = phaseOf(now);

    // Housekeeping first: fold any WETH that landed in the signer into the
    // native balance. Every pool route starts from NATIVE, so wrapped ETH is
    // capital the sizing counts (see ethSideUsd) but no swap can reach until
    // this runs. Best-effort: a failed unwrap must never cost a guard tick.
    try {
      const unwrapped = await unwrapWeth();
      if (unwrapped) console.log(`[lpGuard] unwrapped ${Number(unwrapped.amountWei) / 1e18} WETH to native (${unwrapped.hash})`);
    } catch (err) {
      console.error(`[lpGuard] weth unwrap failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }

    // The 24/7 meme book, BEFORE the equity early-returns below: those bands
    // trade around the clock and must not depend on the stock phase. Runs
    // inside this tick's house-wallet lock; never throws.
    await memeRotorTick();

    const positions = await openPositionsOnChain();
    // Flat during market hours → auto-recovery re-establishes the position
    // (a failed retile or a weekend drift-pull would otherwise leave capital
    // idle out of the market forever). Off-hours we stay flat by design.
    if (positions.length === 0) {
      if (phase === "weekday-market") await attemptRecovery();
      return;
    }

    // Autonomous profit-seeking: during market hours, if a better pool clears
    // the cost-aware bar, move capital there. If it acts, skip the rest of this
    // tick (the new position gets managed next tick).
    if (phase === "weekday-market" && (await maybeRebalance(positions))) return;

    for (const p of positions) {
      // The meme sleeve's ETH-quoted bands surface in the same discovery scan
      // but live in a different registry entirely; their "symbol" is a raw
      // token address, poolTick() can never resolve it, and memeGuard owns
      // their whole lifecycle. Checking them here failed every band on every
      // tick, which is noise exactly where a REAL stock-side failure would
      // need to be visible.
      if (p.symbol.startsWith("0x")) continue;
      // The manual pilot sleeve: named, priced, counted — but never steered by
      // this clock. A 24/7 venue managed on stock hours would be re-tightened
      // into churn at every US open.
      if (HANDS_OFF_SYMBOLS.has(p.symbol)) continue;
      try {
        const tick = await poolTick(p.symbol);
        const wide = halfWidthPct(p) > WIDE_THRESHOLD_HALFPCT;

        if (phase === "weekend") {
          // Tail guard first: a big move past the range center means real
          // information — sit the rest of the weekend out.
          if (driftFromCenterPct(p, tick) > MAX_WEEKEND_DRIFT_PCT) {
            await pullEntirely(p, `weekend drift > ${MAX_WEEKEND_DRIFT_PCT}%`);
            continue;
          }
          // Otherwise ride the weekend WIDE, harvesting arb churn.
          if (!wide) await retileTo(p, WEEKEND_WIDTH_PCT, "widen for weekend");
          else await maybeCollect(p); // staying wide → sweep owed fees
          continue;
        }

        if (phase === "weekday-market") {
          // Coming out of the weekend: snap the wide range back to tight.
          if (wide) {
            await retileTo(p, TIGHT_WIDTH_PCT, "re-tighten after weekend open");
            continue;
          }
          // Normal tight-range upkeep: re-center if it's walked out of range.
          const inRange = tick >= p.tickLower && tick < p.tickUpper;
          const key = String(p.tokenId);
          if (inRange) {
            outOfRangeSince.delete(key);
            await maybeCollect(p); // staying in range → sweep owed fees
            continue;
          }
          if (!outOfRangeSince.has(key)) outOfRangeSince.set(key, Date.now());
          const outMinutes = (Date.now() - outOfRangeSince.get(key)!) / 60_000;
          if (outMinutes >= RECENTER_AFTER_MIN) await retileTo(p, TIGHT_WIDTH_PCT, "re-center");
          continue;
        }

        // weekday-off: hold as-is (don't chase informed off-hours moves), but still sweep owed fees.
        await maybeCollect(p);
      } catch (err) {
        console.error(`[lpGuard] check failed for #${p.tokenId}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
  };
  const timer = setInterval(() => void check(), CHECK_MS);
  timer.unref?.();
  // The meme desk decides on its own faster clock: detection is 1.5s but a
  // decision only happened every CHECK_MS, so signals aged minutes before
  // anything looked at them (2026-08-07: "we feel a bit slow"). 90s here; the
  // desk's own persistence clocks and budgets still pace the ACTIONS, this
  // only paces how often it LOOKS. The house lock serializes it with the
  // legacy tick, and the legacy stock checks stay at CHECK_MS untouched.
  const memeTimer = setInterval(
    () => {
      if (operatorWaiting()) return; // yield to the human
      void withHouseWalletLock("memeRotor.fastTick", () => memeRotorTick({ fast: true })).catch(() => {});
    },
    90 * 1000,
  );
  memeTimer.unref?.();
  void check();
  return timer;
}
