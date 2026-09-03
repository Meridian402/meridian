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
import { realSellStockForUsdg, tokenAddressFor, poolFeePct, tokenIsCurrency0, USDG } from "./venues/stockPools.js";
import { walletOpsAvailable } from "./risk.js";
import { openInPool, HANDS_OFF_SYMBOLS } from "./lpGuard.js";
import { getAgentSigner } from "./venues/signer.js";
import { registerLoop, beat } from "./liveness.js";
import { withHouseWalletLock, operatorWaiting } from "./houseWallet.js";
import { appendLedger } from "./ledger.js";
import { enqueuePendingSell, retryPendingSells, sellSymbolsOrEnqueue } from "./pendingSells.js";
import { portfolioStoodDown } from "./portfolioBreaker.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { venueEarnsAdmission, venueFeeUsd24h, venueChurnAdmits } from "./attribution.js";
import { latestDumpReading, dumpExitVerdict, recordDumpExit, dumpLockoutUntil, switchedOff, fadeVerdictFor, recordFadeExit, FADE_ARMED, dumpMintRefusal, fadeMintRefusal, venueFlowUsdPerHour, venueDepth } from "./dumpWatch.js";

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
// THE FLOOR PERCENT (operator decision 2026-09-03: "stop leaving money on the
// table"). The deposit-scaled floor was a fixed 80%; the real-tape replay
// (08-29..09-02) scored all ten floor exits as bottom sells (+$169/+$461/+$586
// vs holding at 1h/4h/8h) and the median below-band excursion was ~7%,
// deepest 19-26%, so 80% sold most bounces. Live value is the Railway var
// MERIDIAN_PILOT_FLOOR_PCT (70 since 2026-09-03); the code default stays 80.
// Values outside 1..99 fall back to 80. The dump exit stays the collapse bound.
const FLOOR_PCT = (() => { const v = Number(process.env.MERIDIAN_PILOT_FLOOR_PCT ?? 80); return Number.isFinite(v) && v > 0 && v < 100 ? v : 80; })();
// AUTO-ENTRY (2026-09-03, operator: "built it"). Until now every fee-earning
// seat was opened by a human saying go, and the desk sat flat 14 of 24 hours
// while venues it manages carried $200k-800k/hour. This lets the pilot open a
// seat itself under exactly the hand rules: a hands-off venue, admitted by its
// own 7d record, carrying real last-hour flow, no seat there yet, no dump or
// fade lockout, not on the operator denylist, cash above a reserve, gas above
// the top-up line, a cap on open seats and on entries per day, and a cooldown
// after any guard exit in that venue so a floored venue is not re-bought on
// the next tick. The shape is fixed to the proven one: a bid-only seat, top
// edge at spot, re-band width. Every existing rail applies from the first
// second. OFF by default; the operator flips MERIDIAN_PILOT_AUTO_ENTRY=on.
const AUTO_ENTRY = (process.env.MERIDIAN_PILOT_AUTO_ENTRY ?? "off") === "on";
const AUTO_ENTRY_USD = Number(process.env.MERIDIAN_PILOT_AUTO_ENTRY_USD ?? 700);
const AUTO_ENTRY_MAX_SEATS = Number(process.env.MERIDIAN_PILOT_AUTO_MAX_SEATS ?? 2);
const AUTO_ENTRY_RESERVE_USD = Number(process.env.MERIDIAN_PILOT_AUTO_RESERVE_USD ?? 300);
const AUTO_ENTRY_MIN_FLOW_USD_H = Number(process.env.MERIDIAN_PILOT_AUTO_MIN_FLOW_USD_H ?? 150_000);
const AUTO_ENTRY_MIN_GAS_ETH = Number(process.env.MERIDIAN_PILOT_AUTO_MIN_GAS_ETH ?? 0.01);
const AUTO_ENTRY_COOLDOWN_MS = Number(process.env.MERIDIAN_PILOT_AUTO_COOLDOWN_MIN ?? 120) * 60_000;
const AUTO_ENTRY_PER_DAY = Number(process.env.MERIDIAN_PILOT_AUTO_PER_DAY ?? 6);
const AUTO_ENTRY_DENY = new Set((process.env.MERIDIAN_MEME_VENUE_DENYLIST ?? "POOLS").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const GUARD_EXIT_KINDS = new Set(["floor-exit", "break-exit", "dump-exit", "fade-exit", "recenter-abort"]);
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

/** PURE: a seat's deposit when no lineage exists. Balanced mints put half
 *  the budget in USDG, so deposit ~ usdgIn * 2; a single-sided bid puts the
 *  WHOLE budget in USDG, and doubling it invented a phantom deposit whose
 *  80% floor sat above the seat's real value: the first live bid entry
 *  (BONER #1454582, 2026-09-01 22:05) was floor-exited two minutes after
 *  placement, at full health, by exactly this. */
export function inferredDepositUsd(hasCostBasis: boolean | undefined, usdgIn: number, tokenIn: number): number {
  if (hasCostBasis !== true || usdgIn <= 0) return 0;
  return tokenIn > 1e-9 ? usdgIn * 2 : usdgIn;
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
 *  larger of the env floor and FLOOR_PCT% of the deposit (env
 *  MERIDIAN_PILOT_FLOOR_PCT, default 80), so protection scales with the
 *  position automatically. depositUsd 0/unknown falls back to the env. */
export function effectiveFloorUsd(depositUsd: number, envFloorUsd = FLOOR_USD, floorPct = FLOOR_PCT): number {
  return depositUsd > 0 ? Math.max(envFloorUsd, (depositUsd * floorPct) / 100) : envFloorUsd;
}

const outSince = new Map<string, number>();
const lastCollect = new Map<string, number>();

export interface AutoEntryCandidate {
  symbol: string;
  /** last-hour flow, USD/hour; NaN = tape too thin to read */
  flowUsdPerHour: number;
  admitted: boolean;
  admissionNetUsd: number;
  hasSeat: boolean;
  lockedOut: boolean;
  denied: boolean;
  /** ms timestamp of the venue's last guard exit, if any */
  lastExitMs?: number;
  /** what OUR seat would earn per hour at this flow: flow x tier x share (undefined when depth is unknown) */
  feeUsdPerHour?: number;
  /** the seat's share of the pool's active liquidity, percent (undefined when depth is unknown) */
  sharePct?: number;
}

/**
 * PURE: the share of a pool's active liquidity a bid-only seat of seatUsd
 * would hold, placed with its top edge at spot and the re-band's one-sided
 * width below it. v3 math on the raw sqrt price; USDG is 6 decimals and every
 * hands-off token 18, so the seat's L is amount / sqrt-span in raw units.
 * Fee income is flow x tier x THIS, which is why a $1M/h pool with $700k of
 * pro liquidity in range pays a $700 seat less than a $300k/h pool with $50k.
 * Exported for tests.
 */
export function bidShareOfPool(seatUsd: number, activeL: bigint, tick: number, tokenIs0: boolean, widthPct = REBAND_WIDTH_PCT): number {
  if (!(seatUsd > 0) || activeL < 0n) return 0;
  const sp = Math.exp((tick * Math.log(1.0001)) / 2);
  const w = Math.sqrt(1 + widthPct / 200);
  const amount = seatUsd * 1e6;
  // token is currency0: the bid holds currency1 (USDG) below spot, L = amt1 / (sqrtPb - sqrtPa)
  // USDG is currency0: the bid holds currency0 above spot, L = amt0 * sqrtPa * sqrtPb / (sqrtPb - sqrtPa)
  const seatL = tokenIs0 ? amount / (sp - sp / w) : (amount * sp * w) / (w - 1);
  if (!Number.isFinite(seatL) || seatL <= 0) return 0;
  const pool = Number(activeL);
  return (100 * seatL) / (pool + seatL);
}

/**
 * PURE: may the pilot open a seat on its own right now, and where? The desk
 * gates come first (switch, stand-down, seat cap, gas, cash, ops budget, daily
 * cap); then each venue must pass every hand rule; the venue with the most
 * last-hour flow wins. Exported for tests.
 */
export function autoEntryVerdict(args: {
  enabled: boolean;
  now: number;
  openSeats: number;
  maxSeats: number;
  cashUsd: number;
  reserveUsd: number;
  seatUsd: number;
  gasEth: number;
  minGasEth: number;
  stoodDown: boolean;
  opsAvailable: boolean;
  entriesToday: number;
  perDay: number;
  minFlowUsdPerHour: number;
  cooldownMs: number;
  candidates: readonly AutoEntryCandidate[];
}): { act: false; reason: string } | { act: true; symbol: string; reason: string } {
  if (!args.enabled) return { act: false, reason: "auto-entry off (MERIDIAN_PILOT_AUTO_ENTRY)" };
  if (args.stoodDown) return { act: false, reason: "portfolio stand-down: no new exposure" };
  if (args.openSeats >= args.maxSeats) return { act: false, reason: `${args.openSeats} seat(s) open, cap ${args.maxSeats}` };
  if (args.gasEth < args.minGasEth) return { act: false, reason: `gas ${args.gasEth.toFixed(4)} ETH under the ${args.minGasEth} ETH line` };
  if (args.cashUsd < args.seatUsd + args.reserveUsd) return { act: false, reason: `cash $${args.cashUsd.toFixed(0)} under seat $${args.seatUsd} + reserve $${args.reserveUsd}` };
  if (!args.opsAvailable) return { act: false, reason: "daily wallet-ops budget exhausted" };
  if (args.entriesToday >= args.perDay) return { act: false, reason: `${args.entriesToday} auto entries in 24h, cap ${args.perDay}` };
  const why: string[] = [];
  let best: AutoEntryCandidate | undefined;
  for (const c of args.candidates) {
    if (c.hasSeat) { why.push(`${c.symbol}: seat open`); continue; }
    if (c.denied) { why.push(`${c.symbol}: denylist`); continue; }
    if (c.lockedOut) { why.push(`${c.symbol}: locked out`); continue; }
    if (!c.admitted) { why.push(`${c.symbol}: 7d net $${c.admissionNetUsd.toFixed(0)} under admission`); continue; }
    if (c.lastExitMs != null && args.now - c.lastExitMs < args.cooldownMs) { why.push(`${c.symbol}: exited ${Math.round((args.now - c.lastExitMs) / 60000)}m ago, cooldown ${Math.round(args.cooldownMs / 60000)}m`); continue; }
    if (Number.isNaN(c.flowUsdPerHour)) { why.push(`${c.symbol}: tape too thin to read flow`); continue; }
    if (c.flowUsdPerHour < args.minFlowUsdPerHour) { why.push(`${c.symbol}: flow $${Math.round(c.flowUsdPerHour / 1000)}k/h under $${Math.round(args.minFlowUsdPerHour / 1000)}k/h`); continue; }
    // Rank by what OUR seat would earn (flow x tier x share). A venue whose
    // depth is unknown ranks by flow alone, behind any venue with a real
    // fee-rate reading: never let a missing sample outrank a measured one.
    if (!best || gt(rankKey(c), rankKey(best))) best = c;
  }
  if (!best) return { act: false, reason: why.length ? why.join("; ") : "no candidate venues" };
  const rate = best.feeUsdPerHour != null && Number.isFinite(best.feeUsdPerHour) ? `, ~$${best.feeUsdPerHour.toFixed(0)}/h for our seat at ${(best.sharePct ?? 0).toFixed(2)}% of the pool` : ", depth unknown";
  return { act: true, symbol: best.symbol, reason: `${best.symbol} carries ~$${Math.round(best.flowUsdPerHour / 1000)}k/h${rate}, admitted at $${best.admissionNetUsd.toFixed(0)} 7d` };
}

/** Measured fee rate first; a depth-less venue ranks by flow below every measured one. */
function rankKey(c: AutoEntryCandidate): [number, number] {
  return c.feeUsdPerHour != null && Number.isFinite(c.feeUsdPerHour) ? [1, c.feeUsdPerHour] : [0, c.flowUsdPerHour];
}
function gt(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

/** Pilot journal rows since a timestamp (the file is small; read per tick). */
function pilotRowsSince(sinceMs: number): Array<{ ts: number; kind: string; symbol?: string }> {
  try {
    const p = dataPath("pilot-guard.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .slice(-600)
      .map((l) => {
        try {
          return JSON.parse(l) as { ts: number; kind: string; symbol?: string };
        } catch {
          return null;
        }
      })
      .filter((r): r is { ts: number; kind: string; symbol?: string } => !!r && r.ts >= sinceMs);
  } catch {
    return [];
  }
}

let lastAutoEntryReason = "";
/** The pilot's own entry: one seat per tick at most, inside the tick's house lock. */
async function maybeAutoEntry(positions: readonly LpPositionValue[]): Promise<void> {
  if (!AUTO_ENTRY) return;
  const now = Date.now();
  let cashUsd = 0;
  let gasEth = 0;
  try {
    const client = getPublicClient();
    const me = getAgentSigner()!.address;
    const raw = await client.readContract({ address: USDG, abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")], functionName: "balanceOf", args: [me] });
    cashUsd = Number(raw) / 1e6;
    gasEth = Number(await client.getBalance({ address: me })) / 1e18;
  } catch (err) {
    console.error(`[pilotGuard] auto-entry skipped: balance read failed (${err instanceof Error ? err.message.slice(0, 100) : err})`);
    return;
  }
  const rows = pilotRowsSince(now - 24 * 3_600_000);
  const entriesToday = rows.filter((r) => r.kind === "auto-entry").length;
  const candidates: AutoEntryCandidate[] = [...HANDS_OFF_SYMBOLS].map((symbol) => {
    const adm = venueEarnsAdmission("usdg", symbol, 0);
    const exits = rows.filter((r) => r.symbol === symbol && GUARD_EXIT_KINDS.has(r.kind));
    const flow = venueFlowUsdPerHour(symbol, now);
    const depth = venueDepth(symbol);
    const sharePct = depth ? bidShareOfPool(AUTO_ENTRY_USD, depth.activeL, depth.tick, tokenIsCurrency0(symbol)) : undefined;
    const feeUsdPerHour = sharePct != null && !Number.isNaN(flow) ? flow * (poolFeePct(symbol) / 100) * (sharePct / 100) : undefined;
    return {
      symbol,
      flowUsdPerHour: flow,
      feeUsdPerHour,
      sharePct,
      admitted: adm.ok,
      admissionNetUsd: adm.netUsd,
      hasSeat: positions.some((p) => p.symbol === symbol),
      lockedOut: dumpMintRefusal(symbol, now) != null || fadeMintRefusal(symbol, now) != null,
      denied: AUTO_ENTRY_DENY.has(symbol),
      lastExitMs: exits.length ? Math.max(...exits.map((r) => r.ts)) : undefined,
    };
  });
  const v = autoEntryVerdict({
    enabled: AUTO_ENTRY,
    now,
    openSeats: positions.length,
    maxSeats: AUTO_ENTRY_MAX_SEATS,
    cashUsd,
    reserveUsd: AUTO_ENTRY_RESERVE_USD,
    seatUsd: AUTO_ENTRY_USD,
    gasEth,
    minGasEth: AUTO_ENTRY_MIN_GAS_ETH,
    stoodDown: portfolioStoodDown(),
    opsAvailable: walletOpsAvailable(1),
    entriesToday,
    perDay: AUTO_ENTRY_PER_DAY,
    minFlowUsdPerHour: AUTO_ENTRY_MIN_FLOW_USD_H,
    cooldownMs: AUTO_ENTRY_COOLDOWN_MS,
    candidates,
  });
  if (!v.act) {
    if (v.reason !== lastAutoEntryReason) console.error(`[pilotGuard] auto-entry holding: ${v.reason}`);
    lastAutoEntryReason = v.reason;
    return;
  }
  lastAutoEntryReason = "";
  console.error(`[pilotGuard] AUTO-ENTRY ${v.symbol}: ${v.reason}; opening a $${AUTO_ENTRY_USD} BID at width ${REBAND_WIDTH_PCT} (${REBAND_LABEL}), top edge at spot`);
  try {
    const pos = await openInPool(v.symbol, REBAND_WIDTH_PCT, AUTO_ENTRY_USD, { bidOnly: true });
    appendLedger("pilot-guard.jsonl", { ts: Date.now(), kind: "auto-entry", tokenId: pos.tokenId, symbol: v.symbol, valueUsd: AUTO_ENTRY_USD, reason: v.reason });
    console.error(`[pilotGuard] ✓ auto-entry opened #${pos.tokenId} in ${v.symbol}`);
  } catch (err) {
    console.error(`[pilotGuard] auto-entry into ${v.symbol} failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
  }
}
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
/** PURE: the earn rate the payback gate judges against. Fees banked in the
 *  venue over 24h and the seat's own accrual are the evidence for a venue we
 *  have worked; a FRESH venue has neither, so its left-behind bid was refused
 *  forever (PONS 12:30-15:30 on 2026-09-03: "$2.75 churn vs $0.17 expected").
 *  The density estimate (flow x tier x the share this budget would hold) is
 *  the same number the auto-entry picker trusted to open the seat, so it is
 *  the floor of the estimate here. NaN or negative density counts as zero. */
export function paybackFeePerHour(fee24hUsd: number, accruedUsd: number, densityUsdPerHour: number): number {
  const d = Number.isFinite(densityUsdPerHour) && densityUsdPerHour > 0 ? densityUsdPerHour : 0;
  return Math.max(fee24hUsd / 24, accruedUsd / 24, d);
}

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
  /** deposit-scaled floor percent; defaults to the live FLOOR_PCT */
  floorPct?: number;
  bidsToday: number;
  bidsPerDay: number;
  stoodDown: boolean;
}): { act: boolean; reason: string } {
  if (!args.enabled) return { act: false, reason: "dump bid disabled (MERIDIAN_DUMP_BID=off)" };
  // A bid that cannot survive its own fill is a machine for buying and
  // instantly floor-selling: the filled seat's floor is max(env, 80% of
  // deposit), and the fill lands with the value roughly at deposit. Demand
  // 10% of clearance so a normal fill never starts life below its floor.
  const fillFloor = Math.max(args.envFloorUsd, (args.bidUsd * (args.floorPct ?? FLOOR_PCT)) / 100);
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
      floorPct: FLOOR_PCT,
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
  // The pilot's own entry runs while FLAT too, so it sits before the early return.
  await maybeAutoEntry(positions);
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
  // THE VOLUME-FADE EXIT (2026-09-01, operator's strategy: "exit at the tops
  // once volume dies down"). Checked once per venue per tick, before any
  // per-seat management: two consecutive fading hours close every seat the
  // venue holds and lock re-entry until the flow returns. Seats younger than
  // the age floor are exempt (a fresh entry has no post-entry tape to judge,
  // and a just-placed pullback bid must not be closed by the fade that
  // preceded it). The floor and the dump exit still bound everything.
  const FADE_MIN_SEAT_AGE_MS = Number(process.env.MERIDIAN_FADE_MIN_SEAT_AGE_H ?? 2) * 3_600_000;
  if (FADE_ARMED) {
    const nowMs = Date.now();
    for (const symbol of [...venueOpenUsd.keys()]) {
      const seats = positions.filter((p) => p.symbol === symbol && (p.mintedAt === 0 || nowMs - p.mintedAt >= FADE_MIN_SEAT_AGE_MS));
      if (seats.length === 0) continue;
      const v = fadeVerdictFor(symbol, nowMs);
      if (!v.fading) continue;
      console.error(`[pilotGuard] VOLUME FADE: ${symbol} ${v.reason}; closing ${seats.length} seat(s) to cash and locking re-entry until flow returns`);
      recordFadeExit(symbol, v.refUsd, nowMs);
      for (const p of seats) {
        try {
          await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "fade-exit" });
          appendLedger("pilot-guard.jsonl", { ts: nowMs, kind: "fade-exit", tokenId: p.tokenId, symbol: p.symbol, valueUsd: p.valueUsd });
          clearLineage(String(p.tokenId));
          outSince.delete(String(p.tokenId));
        } catch (err) {
          console.error(`[pilotGuard] fade exit of #${p.tokenId} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        }
      }
      const sold = await sellSymbolsOrEnqueue([symbol], "fade-exit");
      if (sold[0]?.usdgReceived) console.error(`[pilotGuard] fade exit sold $${sold[0].usdgReceived.toFixed(2)} of loose ${symbol} to cash`);
      venueOpenUsd.delete(symbol);
    }
  }
  for (const p of positions) {
    if (!venueOpenUsd.has(p.symbol)) continue; // venue was fade-closed this tick
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
  const mintDepositUsd = inferredDepositUsd(p.hasCostBasis, p.usdgIn, p.tokenIn);
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
  // A fresh venue has no banked fees: judge it on the same density estimate
  // the picker opened it on (flow x tier x the share this budget would hold).
  const depth = venueDepth(p.symbol);
  const flowNow = venueFlowUsdPerHour(p.symbol, now);
  const densityRate = depth && !Number.isNaN(flowNow) ? flowNow * ((poolFeePct(p.symbol) || 0.3) / 100) * (bidShareOfPool(budget, depth.activeL, depth.tick, tokenIsCurrency0(p.symbol)) / 100) : 0;
  const feePerHour = paybackFeePerHour(venueFeeUsd24h("usdg", p.symbol), fees, densityRate);
  const costEstUsd = budget * ((poolFeePct(p.symbol) || 0.3) / 100) * 1.2 + 0.25;
  if (!recenterPaysBack(costEstUsd, feePerHour)) {
    console.error(`[pilotGuard] re-center of ${p.symbol} refused by the payback gate: ~$${costEstUsd.toFixed(2)} churn vs $${(feePerHour * PAYBACK_HOURS).toFixed(2)} expected fees in ${PAYBACK_HOURS}h (banked $${venueFeeUsd24h("usdg", p.symbol).toFixed(2)}/24h, density ~$${densityRate.toFixed(2)}/h)`);
    return;
  }
  // Never start what we cannot finish: a re-center is up to four wallet ops
  // (withdraw, sell, buy, mint). If the whole sequence does not fit under
  // the runaway-ops cap, none of it starts.
  if (!walletOpsAvailable(4)) {
    console.error(`[pilotGuard] re-center of ${p.symbol} deferred: not enough op budget for the full withdraw+reopen sequence`);
    return;
  }
  // NEVER RE-BUY THE TOP (2026-09-01, the give-back post-mortem). An above
  // re-center used to mint a balanced band at spot, buying half a budget of
  // token at what is often a pump's pause: both of the day's large losses
  // (BONER re-bought at +25.6%, MICRODUCK two ticks off the high) started
  // exactly there. Above re-centers now re-arm as an all-USDG bid whose top
  // edge sits at spot: the retrace fills us at prices we chose, a continued
  // run costs only missed fees, and a top can never be bought. Below
  // re-centers stay balanced (the seat is all token; balance IS the fix).
  const bidSide = !belowBand;
  console.error(`[pilotGuard] re-centering #${p.tokenId} (${p.symbol}): ${verdict.reason}; re-banding ~$${budget.toFixed(2)} at width ${REBAND_WIDTH_PCT} (${REBAND_LABEL})${bidSide ? " as a BID, top edge at spot" : ""}`);
  await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity, mech: "recenter-close" });
  outSince.delete(key);
  try {
    const pos = await openInPool(p.symbol, REBAND_WIDTH_PCT, budget, { bidOnly: bidSide });
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
  registerLoop("pilotGuard", CHECK_MS, { money: true });
  const tickFn = async () => {
    if (running) return; // a hung tick must starve the heartbeat, so no beat here
    if (operatorWaiting()) {
      beat("pilotGuard"); // yielding to the human is a live decision, not a stall
      return; // next tick is 3 minutes away
    }
    running = true;
    try {
      await withHouseWalletLock("pilotGuard.tick", runTick);
    } catch (err) {
      console.error(`[pilotGuard] tick failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
    } finally {
      running = false;
      beat("pilotGuard");
    }
  };
  const timer = setInterval(() => void tickFn(), CHECK_MS);
  timer.unref?.();
  void tickFn();
  console.error(
    `[pilotGuard] armed: 24/7 clock over {${[...HANDS_OFF_SYMBOLS].join(", ")}}: collect every ${COLLECT_EVERY_MS / 60000}m (gas guard ${COLLECT_MIN_USD}), floor max($${FLOOR_USD}, ${FLOOR_PCT}% of deposit), auto-entry ${AUTO_ENTRY ? `ON ($${AUTO_ENTRY_USD} bids, max ${AUTO_ENTRY_MAX_SEATS} seats, flow >= $${Math.round(AUTO_ENTRY_MIN_FLOW_USD_H / 1000)}k/h, reserve $${AUTO_ENTRY_RESERVE_USD}, cooldown ${AUTO_ENTRY_COOLDOWN_MS / 60000}m, ${AUTO_ENTRY_PER_DAY}/day)` : "off"}, re-center ${RECENTER_BELOW ? `${RECENTER_BELOW_MIN_MS / 60000}m below` : "below OFF (floor or dump exit only)"} / ${RECENTER_ABOVE_MIN_MS / 60000}m above + stable tape, re-band width ${REBAND_WIDTH_PCT} (${REBAND_LABEL}, above re-arms BID-side), floor $${FLOOR_USD}`,
  );
  return timer;
}
