// The market-making skill, front door: given a token, can the desk quote it,
// and at what price. Read-only, no funds move. This is the honest first thing
// a creator's agent asks before arming the skill; the execution layer (a
// funded runner placing bands) is gated on the custody model, see SKILLS.md.
import { parseAbiItem, type Address, type Hex } from "viem";
import { poolsForToken } from "../signals/tokenAnalyst.js";
import { getPublicClient } from "../venues/signer.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";
import { type EthPool, poolId, ethPoolSlot0, buildNativeOnlyMint } from "../venues/ethPools.js";

const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const Q96 = 2 ** 96;

export interface MMPoolView {
  poolId: string;
  feePct: number;
  tickSpacing: number;
  priceEth: number;
  priceUsd: number;
  activeLiquidity: string;
  /** The pool is structurally quotable RIGHT NOW: initialized and holding
   *  liquidity. This is NOT the toxicity vet (that needs the analyst's 24h
   *  swap sweep); it is the fast structural gate the skill checks on demand. */
  quotable: boolean;
}

export interface MMAssessment {
  token: string;
  ethUsd: number;
  pools: MMPoolView[];
  verdict: "quotable" | "no-eth-pool" | "no-liquidity";
  note: string;
}

/** Pure: the verdict from a set of pool views, factored out so it is testable
 *  without the chain. */
export function mmVerdict(pools: MMPoolView[]): MMAssessment["verdict"] {
  if (pools.length === 0) return "no-eth-pool";
  if (pools.some((p) => p.quotable)) return "quotable";
  return "no-liquidity";
}

/** A token can appear in many indexed pools (fee tiers, dupes); reading them
 *  all sequentially is how this endpoint once hung for 60s. Cap and
 *  parallelize: a creator only cares about the handful of real ones. */
const MAX_POOLS_ASSESSED = 12;
const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];

export async function assessTokenForMM(token: Address): Promise<MMAssessment> {
  const client = getPublicClient();
  const ethUsd = await fetchEthUsd().catch(() => 0);
  const found = poolsForToken(token).slice(0, MAX_POOLS_ASSESSED);

  const settled = await Promise.all(
    found.map(async (f): Promise<MMPoolView | null> => {
      try {
        const [[sqrtP], activeL] = await Promise.all([
          client.readContract({ address: STATE_VIEW, abi: slot0Abi, functionName: "getSlot0", args: [f.poolId as Hex] }),
          client.readContract({ address: STATE_VIEW, abi: liqAbi, functionName: "getLiquidity", args: [f.poolId as Hex] }),
        ]);
        const priceEth = Number(sqrtP) > 0 ? 1 / (Number(sqrtP) / Q96) ** 2 : 0;
        return {
          poolId: f.poolId,
          feePct: f.fee / 10000,
          tickSpacing: f.tickSpacing,
          priceEth,
          priceUsd: priceEth * ethUsd,
          activeLiquidity: String(activeL),
          quotable: Number(sqrtP) > 0 && activeL > 0n,
        };
      } catch {
        return null; // an unreadable pool is dropped, never fabricated
      }
    }),
  );
  // Best-liquidity pools first, so a creator sees the venue that matters.
  const pools = settled.filter((p): p is MMPoolView => p !== null).sort((a, b) => (BigInt(b.activeLiquidity) > BigInt(a.activeLiquidity) ? 1 : -1));

  return finishAssessment(token, ethUsd, pools);
}

function finishAssessment(token: Address, ethUsd: number, pools: MMPoolView[]): MMAssessment {
  const verdict = mmVerdict(pools);
  const note =
    verdict === "quotable"
      ? "The desk can make markets in this token today. Arming the skill funds a runner wallet you alone control and places the first band; every move is journaled and every exit is bounded."
      : verdict === "no-eth-pool"
        ? "No ETH-quoted v4 pool is indexed for this token yet. The desk quotes ETH-paired hookless v4 pools; a USDG or v3 pool is outside the engine today."
        : "A pool exists but holds no liquidity to quote against. Seed it, then the desk can join.";
  return { token, ethUsd, pools, verdict, note };
}

// --- Prepare a signable market-making band (self-custody, no held keys) ------
// The honest first execution tier: the creator signs ONE transaction from
// their own wallet and owns a market-making band in their token. A
// single-sided ETH band needs only msg.value, no token approval and no
// Permit2, so there is nothing for Meridian to custody. The 24/7 automated
// desk (a funded runner re-quoting on its own) is a separate tier with its own
// custody model; this is the piece that needs no trust at all.

export interface MMBandPlan {
  token: string;
  creator: string;
  poolId: string;
  feePct: number;
  ethAmount: number;
  ethUsd: number;
  tickLower: number;
  tickUpper: number;
  /** The unsigned transaction the creator signs from their own wallet. */
  tx: { to: string; data: string; value: string };
  note: string;
}

/** Build an EthPool descriptor for an arbitrary indexed pool. buildNativeOnly
 *  Mint only reads token/fee/tickSpacing/offset, so a constructed pool is as
 *  valid as a pinned one; expectedId is derived, never trusted from input. */
function poolFromIndex(token: Address, fee: number, tickSpacing: number): EthPool {
  const p = {
    symbol: `${token.slice(0, 6)}..${token.slice(-4)}`,
    token,
    fee,
    tickSpacing,
    expectedId: "0x0" as Hex,
    offsetAbove: tickSpacing >= 100 ? 1 : 2,
    widthSpacings: tickSpacing >= 100 ? 4 : 8,
  };
  p.expectedId = poolId(p);
  return p;
}

export async function prepareMMBand(token: Address, creator: Address, ethAmount: number): Promise<MMBandPlan> {
  if (!(ethAmount > 0)) throw new Error("ethAmount must be positive");
  const assessment = await assessTokenForMM(token);
  const best = assessment.pools.find((p) => p.quotable);
  if (!best) throw new Error(assessment.note);

  const pool = poolFromIndex(token, Math.round(best.feePct * 10000), best.tickSpacing);
  const { tick, sqrtP } = await ethPoolSlot0(pool);
  if (sqrtP === 0) throw new Error("pool uninitialized");
  const ethWei = BigInt(Math.round(ethAmount * 1e18));
  const mint = buildNativeOnlyMint(pool, tick, ethWei, creator, pool.offsetAbove);

  return {
    token,
    creator,
    poolId: best.poolId,
    feePct: best.feePct,
    ethAmount,
    ethUsd: assessment.ethUsd,
    tickLower: mint.tickLower,
    tickUpper: mint.tickUpper,
    tx: { to: mint.to, data: mint.data, value: `0x${mint.value.toString(16)}` },
    note:
      "Sign this from your own wallet to place a market-making band in your token. You are the owner; " +
      "Meridian never holds your key. It quotes just above spot and fills as the token dips, earning the pool fee.",
  };
}
