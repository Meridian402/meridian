// The proof instrument: a rigorous, on-chain-reproducible measurement of
// whether the agent's market-making actually beats holding. The only honest
// metric for an LP is fees (collected + uncollected) minus impermanent loss
// minus gas, benchmarked against simply holding the deposited assets — the
// wallet total is muddied by asset price moves that aren't market-making skill.
// Computed live from the position ledger + on-chain reads, so every number is
// reproducible by anyone. Deliberately reports the CURRENT stable position as
// the clean experiment; lifetime collected fees are a secondary tally.
import { keccak256, encodeAbiParameters, encodePacked, parseAbiParameters, parseAbiItem, type Address } from "viem";
import { getPublicClient } from "./venues/signer.js";
import { openPositionsOnChain } from "./venues/lpPositions.js";
import { readAllExecutions } from "./executionsLog.js";
import { INDEX_CONTRACTS } from "./venues/indexContracts.js";
import { memeBandsLive, type MemeBand } from "./memeGuard.js";

const SV: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const PM_NFT: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;

interface PositionProof {
  tokenId: string;
  symbol: string;
  daysLive: number;
  depositUsd: number;
  feesCollectedUsd: number;
  feesUncollectedUsd: number;
  feesTotalUsd: number;
  impermanentLossUsd: number;
  netVsHoldUsd: number;
  positionValueUsd: number;
  profitable: boolean;
}

/**
 * A position we own but cannot honestly measure against cost. Reported rather
 * than silently dropped: the wallet's real exposure should never disappear from
 * the public proof just because our books are thin on it.
 */
interface UnmeasuredPosition {
  tokenId: string;
  symbol: string;
  reason: string;
}

export interface MarketMakingProof {
  asOf: number;
  positions: PositionProof[];
  feesTotalUsd: number;
  netVsHoldUsd: number;
  lifetimeFeesCollectedUsd: number;
  profitable: boolean;
  unmeasured: UnmeasuredPosition[];
  /** The 24/7 ETH-quoted book, marked to each pool's current tick on every
   *  request. Valuation only (fees-vs-hold for these venues is still to come),
   *  but live valuation from chain beats a hand-updated constant going stale.
   *  NULL means the read failed this request; [] means genuinely flat. The
   *  distinction is load-bearing: an RPC hiccup must never render as "the
   *  desk holds nothing" to a visitor or a monitor. */
  memeBands: MemeBand[] | null;
  note: string;
}

function poolIdFor(token: Address, fee: number, ts: number): `0x${string}` {
  const [c0, c1] = token.toLowerCase() < USDG.toLowerCase() ? [token, USDG] : [USDG, token];
  return keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [c0, c1, fee, ts, NATIVE]));
}

// Fallback ONLY for legacy rows that predate positions carrying their own pool
// identity. Guessing the tier from the symbol is wrong for every pool outside
// the original five, and a wrong tier yields a wrong poolId — which reads some
// other pool's price and fee growth without erroring. Prefer p.fee/p.tickSpacing.
const feeTierFor = (symbol: string): { fee: number; ts: number } =>
  symbol === "AAPL" || symbol === "GOOGL" ? { fee: 10000, ts: 200 } : { fee: 3000, ts: 60 };

// feeGrowthInside is a deliberately-wrapping uint256: Uniswap subtracts it
// unchecked, so `now < last` is normal and means it wrapped past 2^256, not that
// fees went negative. Plain BigInt subtraction would surface that as a large
// negative "fee owed". Mask back into the unsigned range, exactly as the pool does.
const U256 = 1n << 256n;
const feeGrowthDelta = (now: bigint, last: bigint): bigint => (now - last + U256) % U256;

/** Sum realized fee collections for a symbol after a given time (lp-collect executions). */
function collectedSince(symbol: string, since: number): number {
  let sum = 0;
  for (const e of readAllExecutions()) {
    if (e.kind === "lp-collect" && e.fromSymbol === symbol && e.ts >= since && e.success) sum += e.amountUsd;
  }
  return sum;
}

export async function marketMakingProof(): Promise<MarketMakingProof> {
  const client = getPublicClient();
  const positions = await openPositionsOnChain();
  const out: PositionProof[] = [];
  const unmeasured: UnmeasuredPosition[] = [];
  // The ETH-quoted book prices itself; a read failure degrades to NULL (not
  // []) so consumers keep their last good picture instead of showing flat.
  let memeBands: MemeBand[] | null = null;
  try {
    memeBands = await memeBandsLive();
  } catch (err) {
    console.error(`[proof] meme band read failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }
  const memeIds = new Set((memeBands ?? []).map((b) => b.tokenId));

  for (const p of positions) {
    if (memeIds.has(p.tokenId)) continue; // priced live in memeBands, not "unmeasured"
    const token = (INDEX_CONTRACTS.tokens as Record<string, string>)[p.symbol] as Address;
    if (!token) {
      unmeasured.push({ tokenId: p.tokenId, symbol: p.symbol, reason: "token not in the known universe — cannot price it" });
      continue;
    }
    // No cost basis => no honest answer to "vs holding". Measuring anyway made
    // depositUsd and holdNowUsd both 0, so impermanentLoss became +the entire
    // position value and the position reported as hugely profitable. Chain
    // discovery finds positions the file registry never recorded, so this is a
    // routine state, not an anomaly — report it, never estimate through it.
    if (!p.hasCostBasis) {
      unmeasured.push({
        tokenId: p.tokenId,
        symbol: p.symbol,
        reason: "no cost basis on record (not minted by this backend, or its ledger row is unsynced)",
      });
      continue;
    }
    // The position's own pool identity, from chain. Only fall back to the
    // symbol guess for legacy rows that predate the field.
    const { fee, ts } = p.fee != null && p.tickSpacing != null ? { fee: p.fee, ts: p.tickSpacing } : feeTierFor(p.symbol);
    const poolId = poolIdFor(token, fee, ts);
    const tokenIsC1 = USDG.toLowerCase() < token.toLowerCase();

    const [sqrtP] = await client.readContract({ address: SV, abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")], functionName: "getSlot0", args: [poolId] });
    const praw = (Number(sqrtP) / Q96) ** 2;
    const tokenUsd = (tokenIsC1 ? 1 / praw : praw) * 1e12;

    const salt = `0x${BigInt(p.tokenId).toString(16).padStart(64, "0")}` as `0x${string}`;
    const posKey = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [PM_NFT, p.tickLower, p.tickUpper, salt]));
    const [liq, last0, last1] = await client.readContract({ address: SV, abi: [parseAbiItem("function getPositionInfo(bytes32,bytes32) view returns (uint128,uint256,uint256)")], functionName: "getPositionInfo", args: [poolId, posKey] });
    const [now0, now1] = await client.readContract({ address: SV, abi: [parseAbiItem("function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)")], functionName: "getFeeGrowthInside", args: [poolId, p.tickLower, p.tickUpper] });

    const L = Number(liq);
    const s = Number(sqrtP), sA = Math.sqrt(1.0001 ** p.tickLower) * Q96, sB = Math.sqrt(1.0001 ** p.tickUpper) * Q96, sC = Math.min(Math.max(s, sA), sB);
    // USDG is currency0 exactly when the token is currency1 (both follow from
    // USDG < token in sort order) — so usdgIs0 equals tokenIsC1, not its negation.
    const usdgIs0 = tokenIsC1;
    const amt0 = L * Q96 * (1 / sC - 1 / sB), amt1 = (L * (sC - sA)) / Q96;
    const posValue = (usdgIs0 ? amt0 : amt1) / 1e6 + ((usdgIs0 ? amt1 : amt0) / 1e18) * tokenUsd;
    const fee0 = (Number(feeGrowthDelta(now0, last0)) * L) / 2 ** 128, fee1 = (Number(feeGrowthDelta(now1, last1)) * L) / 2 ** 128;
    const uncollected = (usdgIs0 ? fee0 : fee1) / 1e6 + ((usdgIs0 ? fee1 : fee0) / 1e18) * tokenUsd;

    // mint price = geometric center of the range (mintRange centers on spot)
    const centerTick = (p.tickLower + p.tickUpper) / 2;
    const centerPraw = 1.0001 ** centerTick;
    const mintPrice = (tokenIsC1 ? 1 / centerPraw : centerPraw) * 1e12;
    const depositUsd = p.usdgIn + p.tokenIn * mintPrice;
    const holdNowUsd = p.usdgIn + p.tokenIn * tokenUsd;
    const collected = collectedSince(p.symbol, p.mintedAt);
    const feesTotal = collected + uncollected;
    const il = posValue - holdNowUsd;
    const netVsHold = feesTotal + il;

    out.push({
      tokenId: p.tokenId,
      symbol: p.symbol,
      daysLive: (Date.now() - p.mintedAt) / 86400000,
      depositUsd,
      feesCollectedUsd: collected,
      feesUncollectedUsd: uncollected,
      feesTotalUsd: feesTotal,
      impermanentLossUsd: il,
      netVsHoldUsd: netVsHold,
      positionValueUsd: posValue,
      profitable: netVsHold > 0,
    });
  }

  const feesTotalUsd = out.reduce((a, p) => a + p.feesTotalUsd, 0);
  const netVsHoldUsd = out.reduce((a, p) => a + p.netVsHoldUsd, 0);
  const lifetimeFeesCollectedUsd = readAllExecutions().filter((e) => e.kind === "lp-collect" && e.success).reduce((a, e) => a + e.amountUsd, 0);

  return {
    asOf: Date.now(),
    positions: out,
    feesTotalUsd,
    netVsHoldUsd,
    lifetimeFeesCollectedUsd,
    // Only claim profitability off positions we actually measured. With every
    // position unmeasured, netVsHold is 0 and "profitable" must stay false.
    profitable: out.length > 0 && netVsHoldUsd > 0,
    unmeasured,
    memeBands,
    note:
      "Net vs hold = fees earned (collected + uncollected) minus impermanent loss minus gas, vs simply holding the deposited assets. " +
      "The only honest measure of market-making skill; the wallet total mixes in asset price moves. Every figure is reproducible on-chain." +
      (unmeasured.length
        ? ` ${unmeasured.length} owned position(s) are excluded from these totals because we have no cost basis for them — see "unmeasured".`
        : ""),
  };
}
