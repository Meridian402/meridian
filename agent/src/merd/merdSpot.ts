// The live MERD spot, read from the pool everyone trades in, for the earn
// surface's holder gate.
//
// A deliberate line is being held here. The dashboard REFUSES to price the
// treasury's own MERD, because marking our own thin-market token as an asset
// is showcase math. An eligibility gate is a different animal: it prices a
// USER's holding, at the same pool spot any of them can read, to answer one
// yes/no question. The number is the market's, not ours, and nothing we
// report about ourselves depends on it.
import { parseAbiItem, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";

/** The live token and its WETH pool on the PONS v3 stack. NOT the v4-hook
 *  deployment described in merd.ts, which is built but unarmed. */
export const MERD_LIVE: Address = "0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8";
const MERD_WETH_POOL: Address = "0xBFaC28D6B6A258f442639CF20864f655116D57a6";

const Q96 = 2 ** 96;

/** MERD per WETH from the pool's sqrtPrice. WETH is token0 (0x057C… sorts
 *  below 0x12f8…), both 18 decimals, so the raw ratio IS the price. Pure, for
 *  tests. */
export function merdPerWeth(sqrtPriceX96: bigint): number {
  const p = Number(sqrtPriceX96) / Q96;
  return p * p;
}

let cache: { at: number; usdPerMerd: number } | null = null;
const CACHE_MS = 60_000;

/** USD per MERD at the live pool spot, cached a minute. */
export async function merdUsdSpot(): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.usdPerMerd;
  const client = getPublicClient();
  const [slot0, ethUsd] = await Promise.all([
    client.readContract({
      address: MERD_WETH_POOL,
      abi: [parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)")],
      functionName: "slot0",
    }),
    fetchEthUsd(),
  ]);
  const perWeth = merdPerWeth(slot0[0] as bigint);
  if (!(perWeth > 0) || !(ethUsd > 0)) throw new Error("MERD spot unreadable");
  const usdPerMerd = ethUsd / perWeth;
  cache = { at: Date.now(), usdPerMerd };
  return usdPerMerd;
}

/** A wallet's MERD holding, in USD at the live spot. Throws on a failed read:
 *  an unreadable holding is a retry, never a zero that locks someone out. */
export async function merdHeldUsd(wallet: Address): Promise<number> {
  const client = getPublicClient();
  const [bal, spot] = await Promise.all([
    client.readContract({
      address: MERD_LIVE,
      abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
      functionName: "balanceOf",
      args: [wallet],
    }),
    merdUsdSpot(),
  ]);
  return (Number(bal) / 1e18) * spot;
}

/** The gate itself, pure for tests. */
export function holdGateRefusal(heldUsd: number, requiredUsd: number): string | null {
  if (requiredUsd <= 0) return null; // knob at zero disables the gate
  if (heldUsd >= requiredUsd) return null;
  return `earning needs at least $${requiredUsd.toFixed(0)} of MERD held in your wallet (you hold about $${heldUsd.toFixed(2)} at the live pool price)`;
}
