// The advise-then-approve earn surface: the agent side finds and quantifies the
// opportunity, the USER's own wallet signs the transaction. Custody never moves
// — this file builds quotes and raw {to, data, value} transactions; it holds no
// key and can spend nothing. First live opportunity: parking idle USDG in
// Maple's syrupUSDG via the depth-verified v4 pool carryQuote() reads, at the
// MEASURED pool-drift APY (yieldLogger), not Maple's published figure.
import { encodeFunctionData, parseAbiItem, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import {
  buildSwapExactInCalldata,
  hopRate,
  PERMIT2,
  UNIVERSAL_ROUTER,
  USDG,
  type RouteHop,
} from "../venues/stockPools.js";
import { carryQuote, SYRUP, SYRUP_POOL_FEE, SYRUP_POOL_TICK_SPACING } from "../signals/carry.js";
import { indexYieldData } from "../state.js";
import { yieldSummary } from "../research/yieldLogger.js";
import { indexPositionInfo } from "./yieldPosition.js";

// Near-par stable pair (0.05% fee): 0.5% default slippage floor is generous
// without being the stock pools' 8% (which would let a sandwich take half a
// year of carry). Env-tunable like the tool prices.
const SLIPPAGE_BPS = BigInt(process.env.EARN_CARRY_SLIPPAGE_BPS ?? 50);
const MIN_AMOUNT_USD = 1;
const MAX_AMOUNT_USD = Number(process.env.EARN_CARRY_MAX_USD ?? 25_000);
// Both sides of the pair are 6-decimal tokens.
const DECIMALS = 1e6;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// A human signing 2 approvals + a swap (each waiting on a wallet prompt and a
// receipt) needs more runway than the house loop's 300s. Expiry still reverts
// harmlessly — this only sets how long the prepared swap stays valid.
const SWAP_DEADLINE_SEC = Number(process.env.EARN_SWAP_DEADLINE_SEC ?? 900);

const balanceOfAbi = [parseAbiItem("function balanceOf(address) view returns (uint256)")];
const erc20AllowanceAbi = [parseAbiItem("function allowance(address owner, address spender) view returns (uint256)")];
const erc20ApproveAbi = [parseAbiItem("function approve(address spender, uint256 amount) returns (bool)")];
const permit2AllowanceAbi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
];
const permit2ApproveAbi = [parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)")];

interface YieldLatest {
  measuredSyrupAprPct?: number | null;
  indexImpliedAprPct?: number | null;
}

function latestYieldRow(): YieldLatest {
  const s = yieldSummary() as { latest?: YieldLatest | null };
  return s.latest ?? {};
}

/**
 * The live earn read: what an idle dollar can do right now, with the measured
 * numbers next to each path. With an address, adds that wallet's own idle USDG,
 * any existing syrupUSDG position, and projected earnings at the measured rate.
 */
export async function earnOpportunities(address?: string): Promise<Record<string, unknown>> {
  if (address && !ADDRESS_RE.test(address)) throw new Error("invalid address");

  const [quote, indexSnap] = await Promise.all([carryQuote(), indexYieldData.snapshot()]);
  const { measuredSyrupAprPct = null, indexImpliedAprPct = null } = latestYieldRow();

  // Round trip through the 0.05% pool ≈ 0.1% plus impact — the cost the carry
  // must out-earn before an entry is worth advising at all.
  const roundTripCostPct = 0.1;
  const breakEvenDays =
    measuredSyrupAprPct && measuredSyrupAprPct > 0 ? Math.ceil((roundTripCostPct / (measuredSyrupAprPct / 365)) * 10) / 10 : null;

  const payload: Record<string, unknown> = {
    asOf: Date.now(),
    carry: {
      venue: quote.venue,
      route: quote.route,
      priceUsdgPerSyrup: quote.priceUsdgPerSyrup,
      premiumOverParPct: quote.premiumOverParPct,
      poolDepthUsdAt2pct: quote.poolDepthUsdAt2pct,
      feeTierPct: quote.feeTierPct,
      measuredAprPct: measuredSyrupAprPct,
      aprSource: measuredSyrupAprPct != null ? "measured syrupUSDG/USDG pool-price drift" : "building history (needs >24h of samples)",
      roundTripCostPct,
      breakEvenDays,
      risks: ["Maple borrower credit", "USDG peg", "smart-contract risk"],
      executable: true,
    },
    indexYield: {
      live: indexSnap.live,
      impliedAprPct: indexImpliedAprPct,
      indexPriceUsd: indexSnap.indexPriceUsd,
      thresholdTokens: indexSnap.eligibilityThresholdTokens,
      thresholdUsd: Math.round(indexSnap.eligibilityThresholdUsd),
      entryFeePct: indexSnap.entryFeePct,
      pendingPotUsd: Math.round(indexSnap.pendingPotUsd),
      holderCount: indexSnap.holderCount,
      trend: indexSnap.trend,
      executable: true,
      // Enough to clear the 10k-token threshold after the 6% slippage floor,
      // with a little margin — what the UI's "eligibility" preset offers.
      suggestedEntryUsd: indexSnap.eligibilityThresholdUsd > 0 ? Math.ceil(indexSnap.eligibilityThresholdUsd * 1.08) : null,
      risks: [
        "$INDEX price risk: it trades like a token, not a stable",
        "distribution rate is volume-driven and volatile",
        "3% hook fee on entry AND exit",
        "smart-contract / hook risk",
      ],
    },
  };

  if (address) {
    const client = getPublicClient();
    const owner = address as Address;
    const [usdgRaw, syrupRaw, ethRaw, index] = await Promise.all([
      client.readContract({ address: USDG, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: SYRUP, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] }),
      client.getBalance({ address: owner }),
      indexPositionInfo(address, indexSnap.indexPriceUsd),
    ]);
    const usdg = Number(usdgRaw) / DECIMALS;
    const syrup = Number(syrupRaw) / DECIMALS;
    const syrupValueUsdg = syrup * quote.priceUsdgPerSyrup;
    const apr = measuredSyrupAprPct ?? null;
    payload.wallet = {
      address: address.toLowerCase(),
      usdg,
      syrup,
      syrupValueUsdg,
      index,
      eth: Number(ethRaw) / 1e18,
      projected:
        apr != null && usdg > 0
          ? {
              atAprPct: apr,
              perDayUsd: Math.round(((usdg * apr) / 100 / 365) * 10000) / 10000,
              perYearUsd: Math.round(((usdg * apr) / 100) * 100) / 100,
            }
          : null,
    };
  }
  return payload;
}

interface PreparedStep {
  kind: "approve-erc20" | "approve-permit2" | "swap";
  description: string;
  to: Address;
  data: Hex;
  value: string;
}

/**
 * Build the ordered transactions a user signs to enter (USDG -> syrupUSDG) or
 * exit (syrupUSDG -> USDG) the carry position: missing approvals first (ERC20 ->
 * Permit2, then Permit2 -> UniversalRouter — the router pulls input through
 * Permit2, same as the house path), then the atomic v4 swap with the user as
 * recipient. Read-only against the chain; nothing here signs or sends.
 */
export async function prepareCarry(params: { address: string; amountUsd: number; direction: "enter" | "exit" }): Promise<Record<string, unknown>> {
  const { address, direction } = params;
  if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
  if (direction !== "enter" && direction !== "exit") throw new Error("direction must be enter or exit");
  const amountUsd = Number(params.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_AMOUNT_USD) throw new Error(`amountUsd must be at least $${MIN_AMOUNT_USD}`);
  if (amountUsd > MAX_AMOUNT_USD) throw new Error(`amountUsd above the $${MAX_AMOUNT_USD.toLocaleString()} per-transaction cap`);

  const owner = address as Address;
  const tokenIn: Address = direction === "enter" ? USDG : SYRUP;
  const tokenOut: Address = direction === "enter" ? SYRUP : USDG;
  const client = getPublicClient();

  let amountIn = BigInt(Math.round(amountUsd * DECIMALS));
  const [balance, erc20Allowance, [permit2Amount, permit2Expiration]] = await Promise.all([
    client.readContract({ address: tokenIn, abi: balanceOfAbi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: tokenIn, abi: erc20AllowanceAbi, functionName: "allowance", args: [owner, PERMIT2] }),
    client.readContract({ address: PERMIT2, abi: permit2AllowanceAbi, functionName: "allowance", args: [owner, tokenIn, UNIVERSAL_ROUTER] }),
  ]);
  if (balance === 0n) throw new Error(direction === "enter" ? "no USDG in this wallet to park" : "no syrupUSDG position to exit");
  if (amountIn > balance) amountIn = balance; // never build a tx that oversells the real holding

  const route: RouteHop[] = [{ outputCurrency: tokenOut, fee: SYRUP_POOL_FEE, tickSpacing: SYRUP_POOL_TICK_SPACING }];
  const rate = await hopRate(tokenIn, route[0]);
  const expectedOut = BigInt(Math.round(Number(amountIn) * rate));
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  const steps: PreparedStep[] = [];
  if (erc20Allowance < amountIn) {
    steps.push({
      kind: "approve-erc20",
      description: `Allow Permit2 to move your ${direction === "enter" ? "USDG" : "syrupUSDG"} (one-time)`,
      to: tokenIn,
      data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [PERMIT2, (1n << 256n) - 1n] }),
      value: "0",
    });
  }
  // A Permit2 grant is (amount, expiration): a big-but-EXPIRED allowance is as
  // useless as a zero one, so re-approve unless it also outlives this swap's
  // deadline with margin.
  const permit2Fresh = Number(permit2Expiration) > Math.floor(Date.now() / 1000) + 2 * SWAP_DEADLINE_SEC;
  if (BigInt(permit2Amount) < amountIn || !permit2Fresh) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    steps.push({
      kind: "approve-permit2",
      description: "Authorize the swap router through Permit2 (expires in 30 days)",
      to: PERMIT2,
      data: encodeFunctionData({ abi: permit2ApproveAbi, functionName: "approve", args: [tokenIn, UNIVERSAL_ROUTER, (1n << 160n) - 1n, expiration] }),
      value: "0",
    });
  }
  const swap = buildSwapExactInCalldata({
    currencyIn: tokenIn,
    route,
    amountIn,
    amountOutMinimum: minOut,
    recipient: owner,
    deadlineSec: Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SEC,
  });
  steps.push({
    kind: "swap",
    description:
      direction === "enter"
        ? `Swap ${(Number(amountIn) / DECIMALS).toFixed(2)} USDG into syrupUSDG`
        : `Swap ${(Number(amountIn) / DECIMALS).toFixed(2)} syrupUSDG back to USDG`,
    to: swap.to,
    data: swap.data,
    value: swap.value.toString(),
  });

  return {
    ok: true,
    chainId: 4663,
    direction,
    amountIn: amountIn.toString(),
    amountInUsd: Number(amountIn) / DECIMALS,
    expectedOut: expectedOut.toString(),
    expectedOutTokens: Number(expectedOut) / DECIMALS,
    minOut: minOut.toString(),
    slippageBps: Number(SLIPPAGE_BPS),
    steps,
    note:
      direction === "enter"
        ? "syrupUSDG accrues Maple lending yield into its price. Round trip costs ~0.1% plus impact, so hold for days, not hours. Risks: borrower credit, USDG peg, contracts."
        : "Exiting swaps your syrupUSDG back to USDG at the current pool price, realizing whatever the position accrued.",
  };
}
