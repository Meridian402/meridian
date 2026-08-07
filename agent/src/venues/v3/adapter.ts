// The v3 venue adapter: a parallel ADDITION to the ecosystem, not a change to
// the running v4 desk. Robinhood Chain carries (at least) two Uniswap-v3-style
// stacks, and the richest venue we cannot currently touch lives on one of
// them: MERD/WETH itself, whose volume provably pays (the creator royalty is
// ~20% of fees the pool generates; LPing it earns the other side).
//
// This module is pure reads and unsigned-calldata builders: no signer, no
// timers, no state. The engine that QUOTES v3 venues arrives separately,
// behind its own kill switch, once fork tests pass and the operator arms it.
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { getPublicClient } from "../signer.js";

/** One v3-style deployment: pools come from `factory`, positions live in
 *  `nfpm`. Both stacks below were verified on-chain 2026-08-07 (each NFPM's
 *  factory() read back and matched). */
export interface V3Stack {
  name: "pons" | "sushi";
  factory: Address;
  nfpm: Address;
}

export const PONS_V3: V3Stack = {
  name: "pons",
  factory: "0x1f7d7550B1B028f7571E69a784071F0205Fd2eFA",
  nfpm: "0xC00BABBB20630974345EeA9f57d8F2FDEb81226B",
};

export const SUSHI_V3: V3Stack = {
  name: "sushi",
  factory: "0xe51960F1b45F1c9FB6d166E6a884F866FC70433B",
  nfpm: "0x51d0e5188afe12d502e29D982d20C190e7816107",
};

/** The first target venue: MERD/WETH on the PONS stack. token0 is WETH,
 *  token1 is MERD, verified by direct pool reads. */
export const MERD_WETH_POOL: Address = "0xBFaC28D6B6A258f442639CF20864f655116D57a6";
export const WETH_ADDR: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function factory() view returns (address)",
]);

const NFPM_ABI = parseAbi([
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
]);

export interface V3PoolState {
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export async function readV3Pool(pool: Address): Promise<V3PoolState> {
  const client = getPublicClient();
  const [slot0, liquidity, token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "tickSpacing" }),
  ]);
  return {
    pool,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
    liquidity,
  };
}

export interface V3Position {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/** Every position an owner holds on a stack's NFPM. Enumerable, so no log
 *  scans and no soft-empty failure mode: balanceOf IS the invariant. */
export async function readV3Positions(stack: V3Stack, owner: Address): Promise<V3Position[]> {
  const client = getPublicClient();
  const n = await client.readContract({ address: stack.nfpm, abi: NFPM_ABI, functionName: "balanceOf", args: [owner] });
  const out: V3Position[] = [];
  for (let i = 0n; i < n; i++) {
    const tokenId = await client.readContract({
      address: stack.nfpm,
      abi: NFPM_ABI,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, i],
    });
    const p = await client.readContract({ address: stack.nfpm, abi: NFPM_ABI, functionName: "positions", args: [tokenId] });
    out.push({
      tokenId,
      token0: p[2],
      token1: p[3],
      fee: Number(p[4]),
      tickLower: Number(p[5]),
      tickUpper: Number(p[6]),
      liquidity: p[7],
      tokensOwed0: p[10],
      tokensOwed1: p[11],
    });
  }
  return out;
}

/** Align a tick DOWN to its spacing grid; v3 rejects unaligned bounds. Pure. */
export function alignTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/** Where a fresh one-sided band sits on a v3 pool. Same shape as the v4
 *  desk's targetRange, expressed here for token0/token1 pools: token0-side
 *  bands sit ABOVE the current tick (fill as price of token1 falls into
 *  them when token0 is the quote asset), token1-side bands sit below. For
 *  MERD/WETH, token0 = WETH: a "quote" band of WETH above tick buys MERD
 *  dips; a MERD band below tick sells rallies. Pure, for tests. */
export function v3TargetRange(
  tick: number,
  spacing: number,
  side: "token0" | "token1",
  offsetSpacings = 1,
  widthSpacings = 4,
): { tickLower: number; tickUpper: number } {
  if (side === "token0") {
    const tickLower = alignTick(tick, spacing) + Math.max(1, offsetSpacings) * spacing;
    return { tickLower, tickUpper: tickLower + widthSpacings * spacing };
  }
  const tickUpper = alignTick(tick, spacing) - Math.max(1, offsetSpacings) * spacing;
  return { tickLower: tickUpper - widthSpacings * spacing, tickUpper };
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/** Unsigned mint into a v3 pool. Amounts are supplied by the caller (the
 *  engine or a self-custody creator); WETH wrapping and ERC20 approvals are
 *  separate prepared steps, listed by buildV3Approvals. Slippage mins default
 *  to 0 because one-sided range mints cannot be sandwiched into a worse
 *  RATIO; the engine simulates before sending regardless. */
export function buildV3Mint(
  stack: V3Stack,
  pool: Pick<V3PoolState, "token0" | "token1" | "fee">,
  range: { tickLower: number; tickUpper: number },
  amount0: bigint,
  amount1: bigint,
  recipient: Address,
  deadlineSec: number,
): UnsignedTx {
  const data = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "mint",
    args: [
      {
        token0: pool.token0,
        token1: pool.token1,
        fee: pool.fee,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient,
        deadline: BigInt(deadlineSec),
      },
    ],
  });
  return { to: stack.nfpm, data, value: 0n };
}

const MAX128 = (1n << 128n) - 1n;

/** Unsigned full-or-partial withdraw: decrease then collect (two txs, the
 *  NFPM pattern). Collect with max amounts also sweeps accrued fees. */
export function buildV3Withdraw(
  stack: V3Stack,
  tokenId: bigint,
  liquidity: bigint,
  recipient: Address,
  deadlineSec: number,
): { decrease: UnsignedTx; collect: UnsignedTx } {
  const decrease = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "decreaseLiquidity",
    args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(deadlineSec) }],
  });
  const collect = encodeFunctionData({
    abi: NFPM_ABI,
    functionName: "collect",
    args: [{ tokenId, recipient, amount0Max: MAX128, amount1Max: MAX128 }],
  });
  return {
    decrease: { to: stack.nfpm, data: decrease, value: 0n },
    collect: { to: stack.nfpm, data: collect, value: 0n },
  };
}

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const WETH_ABI = parseAbi(["function deposit() payable"]);

/** The prepared steps a v3 mint needs before it can execute: wrap native ETH
 *  into WETH when the position spends it, and approve the NFPM for whichever
 *  sides are being supplied. Returned as unsigned txs in execution order. */
export function buildV3Approvals(
  stack: V3Stack,
  pool: Pick<V3PoolState, "token0" | "token1">,
  amount0: bigint,
  amount1: bigint,
  wrapNativeForWeth = true,
): UnsignedTx[] {
  const steps: UnsignedTx[] = [];
  if (wrapNativeForWeth && pool.token0.toLowerCase() === WETH_ADDR.toLowerCase() && amount0 > 0n) {
    steps.push({ to: WETH_ADDR, data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: amount0 });
  }
  if (amount0 > 0n)
    steps.push({ to: pool.token0, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [stack.nfpm, amount0] }), value: 0n });
  if (amount1 > 0n)
    steps.push({ to: pool.token1, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [stack.nfpm, amount1] }), value: 0n });
  return steps;
}
