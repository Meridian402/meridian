// The opportunity scanner: lp_score measures each pool's fee flow and
// toxicity across ALL existing LPs, but the question that makes money is
// narrower — given OUR capital, which pool pays US the most right now, and is
// it better than where we're sitting? This ranks every LP-viable pool by our
// expected net $/day (our share of in-range liquidity × the pool's net flow),
// runs throughout the day, and flags when a move is worth its switching cost.
// Report-only by design: it surfaces the best opportunity; moving capital
// stays a deliberate act (the momentum-churn lesson — never chase on a whim).
import { keccak256, encodeAbiParameters, parseAbiParameters, parseAbiItem, type Address, type Hex } from "viem";
import { appendLedger } from "./ledger.js";
import { getPublicClient, getAgentAddress } from "./venues/signer.js";
import { lpScores } from "./signals/lpScore.js";
import { qualifyDeployablePools } from "./signals/poolQualify.js";
import { openPositionsOnChain, lpPositionsWithValue, configuredPool, LP_BASELINE_SYMBOLS } from "./venues/lpPositions.js";
import { poolCandidates, poolFeePct, poolPricesUsd, WETH } from "./venues/stockPools.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { registerLoop, beat } from "./liveness.js";
import { dataPath } from "./dataDir.js";

const BASELINE_SYMBOLS = new Set(LP_BASELINE_SYMBOLS);

// Fallback size for the scan when the wallet's real capital can't be read or is
// too small to be meaningful. It is ONLY a display default for the read-only
// ranking — every decision that spends money sizes from the real book (see
// deployableCapitalUsd), because switch cost is linear in capital and ranking is
// not: our share of a pool, and therefore expected $/day, is nonlinear in size,
// so a $160 assumption ranks pools wrongly for a $2k book AND under-prices the
// move by more than 10x.
const NOMINAL_CAPITAL_USD = 160;
const MIN_MEANINGFUL_CAPITAL_USD = 25;
// Above this share of a pool we would BE the pool, and its measured historical
// flow no longer describes what we'd earn. See the dead-pool trap below.
const MAX_TRUSTWORTHY_SHARE_PCT = Number(process.env.LP_MAX_SHARE_PCT ?? 50);

const SV: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11"; // deployed on Robinhood Chain, but not in the viem chain object
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;
const PAYBACK_DAYS_BAR = 3; // only worth moving if the switch pays for itself within this

// The candidate universe: every ticker × standard fee tier (names match
// lp_score's for the join). Non-existent / dead pools are filtered out at scan
// time (sqrtP === 0, or no fee flow), so this stays broad and self-updating.
const POOLS = poolCandidates();

export interface LpOpportunity {
  pool: string;
  symbol: string;
  /**
   * The scored pool's OWN identity. The scan ranks per (ticker × fee tier) but
   * mintRange deploys per symbol, so a consumer that acts on an opportunity must
   * check these against configuredPool(symbol) — otherwise it scores one pool
   * and buys another.
   */
  fee: number;
  tickSpacing: number;
  /** True when a mint for this symbol would land in THIS pool, not a different tier of it. */
  mintable: boolean;
  ourSharePct: number;
  expectedNetPerDayUsd: number;
  expectedFeesPerDayUsd: number;
  feeTierPct: number;
  viable: boolean;
  /** Why an otherwise fee-positive pool was ruled out. */
  reason?: string;
}
export interface OpportunityScan {
  ts: number;
  capitalUsd: number;
  /**
   * Where capitalUsd came from. Decisions that spend money must only act on a
   * "book"-sized scan — "nominal" means we could not read the real balance and
   * fell back to a display figure, which would misprice every switch.
   */
  sizedFrom: "explicit" | "book" | "nominal";
  opportunities: LpOpportunity[];
  /** Highest-scoring pool overall — may not be deployable. Informative only. */
  best: LpOpportunity | null;
  /** Highest-scoring pool we could actually mint into today. This is the one to act on. */
  bestActionable: LpOpportunity | null;
  currentSymbol: string | null;
  recommendation: string;
  note: string;
}

function idFor(token: Address, fee: number, ts: number): Hex {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, ts, NATIVE]));
}

/** Liquidity L we'd mint for `capitalUsd` split into a ±widthPct/2 range at the current price. */
function ourLiquidity(capitalUsd: number, sqrtP: number, widthPct: number, usdgIs0: boolean): number {
  const f = Math.sqrt(1 + widthPct / 200);
  const sA = sqrtP / f, sB = sqrtP * f;
  const half = (capitalUsd / 2) * 1e6; // USDG raw on one side
  return usdgIs0
    ? (half * ((sqrtP / Q96) * (sB / Q96))) / (sB / Q96 - sqrtP / Q96)
    : half / (sqrtP / Q96 - sA / Q96);
}

let cache: OpportunityScan | null = null;
export function latestScan(): OpportunityScan | null {
  return cache;
}

/**
 * What the house could actually put to work right now: idle USDG + the value
 * already sitting in LP positions + stock tokens held between retiles. This is
 * the size every real decision must be measured at.
 *
 * Returns null when it cannot be read (no wallet, RPC failure) so callers fall
 * back to the nominal display size rather than silently ranking a $0 book —
 * a zeroed capital makes every pool's expected $/day 0 and the ranking
 * meaningless.
 */
/**
 * Gas the book must never spend. Native ETH is deployable capital here because
 * realBuyStockFromNative gives it a real spend path into any pool, but it is
 * ALSO the gas token, so counting all of it would let sizing plan away the
 * engine's ability to sign. 0.001 ETH covers a comfortable run of mints,
 * re-centers and collects on this chain (fundingHealth warns at half that).
 */
export const GAS_RESERVE_ETH = 0.001;

/**
 * Pure sizing arithmetic, split out for tests: WETH counts in full (the guard
 * unwraps it on its next tick, so it is native with a one-tick delay), native
 * counts above the gas reserve, and a bad or missing ETH price counts both at
 * zero rather than poisoning the total.
 */
export function ethSideUsd(nativeEth: number, wethEth: number, ethUsd: number | null): number {
  if (ethUsd == null || !Number.isFinite(ethUsd) || ethUsd <= 0) return 0;
  return (Math.max(0, nativeEth - GAS_RESERVE_ETH) + Math.max(0, wethEth)) * ethUsd;
}

export async function deployableCapitalUsd(): Promise<number | null> {
  const wallet = getAgentAddress();
  if (!wallet) return null;
  try {
    const client = getPublicClient();
    const [usdgRaw, balances, prices, positions, nativeWei, wethRaw, ethUsd] = await Promise.all([
      client.readContract({
        address: USDG,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [wallet],
      }),
      readStockBalances(wallet),
      poolPricesUsd(),
      lpPositionsWithValue().catch(() => []),
      client.getBalance({ address: wallet }),
      client
        .readContract({
          address: WETH,
          abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
          functionName: "balanceOf",
          args: [wallet],
        })
        .catch(() => 0n),
      fetchEthUsd().catch(() => null),
    ]);
    const usdg = Number(usdgRaw) / 1e6;
    const stock = Object.entries(balances).reduce((s, [sym, qty]) => s + qty * (prices[sym] ?? 0), 0);
    const lp = positions.reduce((s, p) => s + p.valueUsd, 0);
    const eth = ethSideUsd(Number(nativeWei) / 1e18, Number(wethRaw as bigint) / 1e18, ethUsd);
    return usdg + stock + lp + eth;
  } catch {
    return null;
  }
}

/**
 * Rank every LP-viable pool by expected net $/day for a given capital.
 *
 * `capitalUsd` omitted => size from the REAL book (deployableCapitalUsd), which
 * is what the autonomous paths must use. An explicit value is honoured as-is,
 * for the "what would $X earn" HTTP query.
 */
export async function scanOpportunities(capitalUsd?: number, widthPct = 2): Promise<OpportunityScan> {
  let sizedFrom: "explicit" | "book" | "nominal" = "explicit";
  if (capitalUsd == null) {
    const real = await deployableCapitalUsd();
    if (real != null && real >= MIN_MEANINGFUL_CAPITAL_USD) {
      capitalUsd = real;
      sizedFrom = "book";
    } else {
      capitalUsd = NOMINAL_CAPITAL_USD;
      sizedFrom = "nominal";
    }
  }
  // WARM THE QUALIFIED SET BEFORE JUDGING DEPLOYABILITY, NOT AFTER.
  //
  // configuredPool() resolves the hardcoded baseline first and then the
  // qualifier's cache, so a cold cache makes every dynamically-qualified pool
  // look like it has no deployable config at all. The allocator's own tick used
  // to scan first and warm second, which meant the scan always read the PREVIOUS
  // tick's cache and, on the first tick after any restart, an empty one.
  //
  // Measured on the 2026-08-09 deploy, one second apart:
  //   14:47:33  PLTR/USDG 1% scores higher at ~$28.36/day but has no
  //             deployable pool config — not actionable
  //   14:47:34  deployable: 13 pools qualify — beyond baseline: ... PLTR($6k)
  //
  // PLTR was deployable the whole time. The allocator recommended a $4.91/day
  // baseline pool over a $28.36/day qualified one because it asked before
  // looking, and the allocator's tick is slow, so that answer stands for a long
  // while. Warming here rather than reordering the caller means no future call
  // site can reintroduce it. Best-effort: qualification is read-only and gates
  // deployment, so if it fails we fall through to the last known set exactly as
  // before rather than failing the whole scan.
  try {
    await qualifyDeployablePools();
  } catch {
    /* keep the previous cache; a stale set is still safer than an empty one */
  }

  const client = getPublicClient();
  const score = await lpScores(); // hourly-cached; the expensive part
  const scoreByPool = new Map(score.pools.map((p) => [p.pool, p]));

  // Read all candidates' pool state in ONE multicall with allowFailure: dead /
  // non-existent pools (getSlot0/getLiquidity revert) return a failure status
  // instead of poisoning the whole batch, so real pools still resolve. (Auto-
  // batched readContract does NOT allowFailure, which zeroed everything.)
  const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const contracts = POOLS.flatMap((p) => {
    const id = idFor(p.token, p.fee, p.ts);
    return [
      { address: SV, abi: liqAbi, functionName: "getLiquidity", args: [id] } as const,
      { address: SV, abi: slot0Abi, functionName: "getSlot0", args: [id] } as const,
    ];
  });
  const results = await client.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3 });
  const states = POOLS.map((p, i) => {
    const liq = results[2 * i];
    const slot = results[2 * i + 1];
    const poolL = liq.status === "success" ? Number(liq.result) : 0;
    const sqrtP = slot.status === "success" ? Number((slot.result as readonly [bigint, number, number, number])[0]) : 0;
    return { p, poolL, sqrtP };
  });

  const opps: LpOpportunity[] = [];
  for (const { p, poolL, sqrtP } of states) {
    if (sqrtP === 0) continue; // pool not initialized on this tier — skip
    const usdgIs0 = USDG.toLowerCase() < p.token.toLowerCase();
    const ourL = ourLiquidity(capitalUsd, sqrtP, widthPct, usdgIs0);
    const share = ourL / (poolL + ourL);
    const sc = scoreByPool.get(p.name);
    const netPerDay = sc ? sc.lpNetUsd / score.windowDays : 0;
    const feesPerDay = sc ? sc.feesPerDayUsd : 0;

    // Does a mint for this ticker actually land in THIS pool? The scan covers
    // every fee tier; the deployer only knows one pool per symbol.
    const cfg = configuredPool(p.symbol);
    const mintable = !!cfg && cfg.fee === p.fee && cfg.tickSpacing === p.ts;

    // THE DEAD-POOL TRAP. share is ourL/(poolL+ourL), so a pool holding no
    // liquidity gives share = 1.0, and multiplying a pool's MEASURED HISTORICAL
    // flow by a 100% share invents money: you cannot capture yesterday's volume
    // by being the only LP today — if there is no liquidity now, there is no
    // flow now. Live this ranked INTC/USDG 0.05% at $1,487/day on a $160 book
    // (930%/day) and sorted six empty pools above every real one.
    //
    // Above this share the historical join stops meaning anything: our own
    // liquidity would dominate the pool, so the flow that produced the score was
    // earned under conditions that no longer apply.
    const tooThin = share * 100 > MAX_TRUSTWORTHY_SHARE_PCT;
    const reason = tooThin
      ? `pool too thin for our size — we would be ${(share * 100).toFixed(0)}% of it, so its measured flow does not transfer`
      : !mintable && cfg
        ? `scored the ${p.fee / 10000}% tier but a mint for ${p.symbol} lands in the ${cfg.fee / 10000}% pool`
        : !cfg
          ? `no deployable pool configured for ${p.symbol}`
          : undefined;

    opps.push({
      pool: p.name,
      symbol: p.symbol,
      fee: p.fee,
      tickSpacing: p.ts,
      mintable,
      ourSharePct: share * 100,
      // Zero out the headline numbers on an untrustworthy pool rather than
      // reporting a figure nobody should act on.
      expectedNetPerDayUsd: tooThin ? 0 : share * netPerDay,
      expectedFeesPerDayUsd: tooThin ? 0 : share * feesPerDay,
      feeTierPct: p.fee / 10000,
      viable: netPerDay > 0 && !tooThin,
      reason,
    });
  }
  opps.sort((a, b) => b.expectedNetPerDayUsd - a.expectedNetPerDayUsd);

  const best = opps[0] ?? null;
  // What we could actually DEPLOY into today. `best` is informative (it can flag
  // a pool worth configuring), but recommending a move into a pool that has no
  // deployable config is advice nobody can take — and on the public console it
  // reads as an action we're about to make.
  const bestActionable = opps.find((o) => o.viable && o.mintable) ?? null;
  const positions = await openPositionsOnChain();
  const currentSymbol = positions[0]?.symbol ?? null;
  const currentFee = positions[0]?.fee;
  const current =
    opps.find((o) => o.symbol === currentSymbol && (currentFee == null || o.fee === currentFee)) ??
    opps.find((o) => o.symbol === currentSymbol) ??
    null;

  // Only mention the unreachable leader when it actually beats what we can take.
  const footnote =
    best && bestActionable && best.pool !== bestActionable.pool && best.expectedNetPerDayUsd > bestActionable.expectedNetPerDayUsd
      ? ` (${best.pool} scores higher at ~$${best.expectedNetPerDayUsd.toFixed(2)}/day but has no deployable pool config — not actionable.)`
      : "";

  let recommendation: string;
  if (!bestActionable) {
    recommendation = best?.viable
      ? `nothing deployable is fee-positive for our size right now — ${best.pool} leads but we cannot mint it. Sit in cash / wait.`
      : "no pool is currently fee-positive for our size — sit in cash / wait.";
  } else if (!currentSymbol) {
    recommendation = `flat. Best deployable: ${bestActionable.pool} at ~$${bestActionable.expectedNetPerDayUsd.toFixed(2)}/day for $${capitalUsd.toFixed(0)}.${footnote}`;
  } else if (bestActionable.symbol === currentSymbol) {
    recommendation = `holding the best deployable pool (${bestActionable.pool}). No move.${footnote}`;
  } else {
    const gain = bestActionable.expectedNetPerDayUsd - (current?.expectedNetPerDayUsd ?? 0);
    // Real round-trip: sell current (its fee) + buy target (its fee) + buffer —
    // the flat 0.6% badly understated it for 1% pools.
    const switchCost = capitalUsd * (poolFeePct(currentSymbol) / 100 + poolFeePct(bestActionable.symbol) / 100 + 0.003);
    const paybackDays = gain > 0 ? switchCost / gain : Infinity;
    recommendation =
      paybackDays <= PAYBACK_DAYS_BAR
        ? `CONSIDER MOVING ${currentSymbol} → ${bestActionable.symbol}: +$${gain.toFixed(2)}/day, ~$${switchCost.toFixed(2)} switch cost pays back in ${paybackDays.toFixed(1)}d.${footnote}`
        : `hold ${currentSymbol}. ${bestActionable.symbol} leads by only $${gain.toFixed(2)}/day — not worth the ~$${switchCost.toFixed(2)} switch.${footnote}`;
  }

  const scan: OpportunityScan = {
    ts: Date.now(),
    capitalUsd,
    sizedFrom,
    opportunities: opps,
    best,
    bestActionable,
    currentSymbol,
    recommendation,
    note:
      `Expected net $/day = our share of in-range liquidity × the pool's measured (fees − markout)/day, for $${capitalUsd.toFixed(0)} ` +
      `(${sizedFrom === "book" ? "the wallet's real deployable capital" : sizedFrom === "explicit" ? "a caller-supplied size" : "a nominal size — the real balance could not be read"}). ` +
      `Report-only; moving capital is a deliberate act.`,
  };
  // Never let a caller-supplied size into the cache the autonomous paths read:
  // a "what would $50k earn" HTTP query must not become the basis for a real
  // rebalance decision. Nominal scans are still cached (they save a repeat of an
  // expensive scan, and pool VIABILITY is capital-independent); consumers that
  // care about magnitude gate on sizedFrom.
  if (sizedFrom !== "explicit") cache = scan;
  try {
    appendLedger("lp-opportunities.jsonl", { ts: scan.ts, capitalUsd, sizedFrom, best: best?.pool ?? null, bestNet: best?.expectedNetPerDayUsd ?? 0, current: currentSymbol, rec: recommendation });
  } catch {}
  return scan;
}

/**
 * Run the scanner throughout the day: every 30 min during market hours (when
 * flow and the opportunity set shift most), hourly otherwise. Read-only, so it
 * runs anywhere the agent runs; it never moves capital on its own.
 */
export function startLpAllocator(): NodeJS.Timeout {
  const tick = async () => {
    try {
      // No argument: size from the real book, so the cached scan the guard reads
      // reflects what we actually have at risk.
      const scan = await scanOpportunities();
      console.error(
        `[lpAllocator] $${scan.capitalUsd.toFixed(0)} (${scan.sizedFrom}) — best: ${scan.best?.pool ?? "none"} ($${scan.best?.expectedNetPerDayUsd.toFixed(2)}/day) — ${scan.recommendation}`,
      );
    } catch (err) {
      console.error(`[lpAllocator] scan failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
    // Warm the deployable-pool cache the deployment path reads synchronously, so
    // the LP set is dynamic (new/deepened pools qualify in) without living in a
    // hardcoded list. Read-only; qualification gates deployment, moves no capital.
    try {
      const q = await qualifyDeployablePools();
      const extra = q.filter((p) => !BASELINE_SYMBOLS.has(p.symbol)).map((p) => `${p.symbol}($${Math.round(p.depthUsd / 1000)}k)`);
      console.error(`[lpAllocator] deployable: ${q.length} pools qualify${extra.length ? ` — beyond baseline: ${extra.join(", ")}` : ""}`);
    } catch (err) {
      console.error(`[lpAllocator] qualify failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  };
  const isMarketHours = () => {
    const now = new Date();
    const day = now.getUTCDay();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    return day >= 1 && day <= 5 && mins >= 810 && mins < 1200;
  };
  let last = 0;
  // Registered at the slow cadence: a healthy allocator completes a pass at
  // least hourly, so stale means three hours of silence, fatal means four.
  registerLoop("lpAllocator", 60 * 60 * 1000, { money: true });
  const timer = setInterval(() => {
    const gap = isMarketHours() ? 30 * 60 * 1000 : 60 * 60 * 1000;
    if (Date.now() - last >= gap) {
      last = Date.now();
      void tick().finally(() => beat("lpAllocator"));
    }
  }, 5 * 60 * 1000);
  timer.unref?.();
  last = Date.now();
  void tick();
  return timer;
}
