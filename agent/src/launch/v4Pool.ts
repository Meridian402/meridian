// Uniswap v4 on Robinhood Chain — the venue MERD's pool lives in.
//
// v4 rather than v2/v3 for three reasons that all point the same way:
//   1. HOOKS ONLY EXIST HERE. The capped treasury fee is a hook, so no v2 or v3
//      pool can carry it. This alone decides it.
//   2. Our LP guard already runs v4 positions on this chain, so MERD's pool is
//      market-made by machinery that is already proven rather than new code.
//   3. Native ETH pairs directly — no WETH wrapping step, unlike v3.
//
// THE ADDRESS DISTINCTION THAT BITES:
//   PositionManager and PoolManager are different contracts and it is very easy
//   to pass one where the other belongs. The hook's constructor takes the
//   PoolManager, and its onlyPoolManager guard compares against it — deploy a
//   hook pointed at the PositionManager and every swap in the pool reverts,
//   because the real PoolManager's calls are rejected. Both are recorded below,
//   labelled, with the PoolManager read off the PositionManager on chain rather
//   than copied from documentation.
import type { Address } from "viem";
import { MERD_ADDRESS } from "./merd.js";

/** The v4 singleton. Every pool lives inside this one contract. */
export const V4_POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

/** Periphery. Mints and manages positions; this is what our LP guard talks to. */
export const V4_POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";

export const V4_STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
export const V4_UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** v4 represents native ETH as the zero address — no wrapping. */
export const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

/**
 * A v4 pool is identified by this struct, not by a deployed pair contract.
 * currency0 must sort below currency1, and since native ETH is address(0) it is
 * always currency0 — so MERD is currency1 and "price" reads as MERD per ETH.
 */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * 1% and spacing 200, matching what every launchpad on this chain settled on
 * for volatile pairs (Pons and lemon both run 1%). A new token's price moves
 * far too much for the 0.05% tier to compensate liquidity providers.
 */
export const MERD_POOL_FEE = 10_000; // 1.00%
export const MERD_POOL_TICK_SPACING = 200;

/**
 * The pool MERD will trade in. `hooks` is the treasury hook's mined address and
 * is part of the pool's IDENTITY — change it and this is a different pool, so
 * it cannot be added or swapped later. Pass the zero address to open the pool
 * with no hook at all, which is a permanent decision either way.
 */
export function merdPoolKey(hooks: Address): PoolKey {
  return {
    currency0: NATIVE_ETH,
    currency1: MERD_ADDRESS,
    fee: MERD_POOL_FEE,
    tickSpacing: MERD_POOL_TICK_SPACING,
    hooks,
  };
}
