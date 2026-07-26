// Creating MERD's v4 pool and seeding it with the launch liquidity.
//
// This is the step that turns a deployed token into a tradeable one, and it is
// the last thing that has to happen before any fee — ours or the LP's — has
// anything to charge on.
//
// It builds UNSIGNED transactions rather than sending them. The supply lives in
// the treasury, which is a cold wallet whose key we deliberately do not hold, so
// the treasury has to sign this itself. That constraint is the point: the same
// separation that stops a compromised agent key from touching the supply also
// means the agent cannot seed the pool on its own.
//
// The pool's HOOK is part of its identity. Creating the pool with the wrong hook
// address — or with none — produces a different pool that can never be given one
// later, so the hook has to be deployed and its address known before any of this
// runs.
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbiParameters,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { MERD_ADDRESS } from "./merd.js";
import {
  V4_POSITION_MANAGER,
  V4_STATE_VIEW,
  PERMIT2,
  NATIVE_ETH,
  MERD_POOL_FEE,
  MERD_POOL_TICK_SPACING,
  type PoolKey,
} from "./v4Pool.js";

/** v4-periphery action ids, already proven live on this chain by the LP guard. */
const MINT_POSITION = "0x02";
const SETTLE_PAIR = "0x0d";

const Q96 = 2n ** 96n;

/** Widest ticks usable at a given spacing. v4's own bound is ±887272. */
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  const bound = Math.floor(887272 / tickSpacing) * tickSpacing;
  return { tickLower: -bound, tickUpper: bound };
}

/** Integer square root. Newton's method, exact for our purposes. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * The opening price, as v4 wants it.
 *
 * price is currency1 per currency0 — MERD per ETH, since native ETH is
 * address(0) and always sorts first. sqrtPriceX96 = sqrt(amount1/amount0) * 2^96.
 *
 * Computed in integers on purpose. Doing this in floating point and converting
 * at the end loses precision at exactly the magnitudes a launch uses (1e27
 * against 1e18), and the opening price cannot be corrected afterwards — it is
 * whatever the pool was created with, and every subsequent trade prices off it.
 */
export function sqrtPriceX96For(amount0Wei: bigint, amount1Wei: bigint): bigint {
  if (amount0Wei <= 0n || amount1Wei <= 0n) throw new Error("both sides must be positive to set a price");
  // sqrt(a1/a0) * 2^96 == sqrt(a1 * 2^192 / a0)
  return isqrt((amount1Wei * Q96 * Q96) / amount0Wei);
}

/** What one MERD is worth, for a human check before signing. */
export function openingPrice(amount0Wei: bigint, amount1Wei: bigint): { merdPerEth: number; ethPerMerd: number } {
  const merdPerEth = Number(amount1Wei) / Number(amount0Wei);
  return { merdPerEth, ethPerMerd: 1 / merdPerEth };
}

const POSITION_MANAGER_ABI = parseAbi([
  "function initializePool(( address,address,uint24,int24,address ) key, uint160 sqrtPriceX96) payable returns (int24)",
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function multicall(bytes[] data) payable returns (bytes[])",
]);

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

export interface SeedPlan {
  /** ETH put into the pool, in wei. */
  ethWei: bigint;
  /** MERD put into the pool, in wei. */
  merdWei: bigint;
  /** Who receives the LP position NFT. */
  recipient: Address;
  /** Deployed treasury hook. Part of the pool's identity — not optional. */
  hook: Address;
  /** Defaults to the widest usable range, which is what a launch wants. */
  tickLower?: number;
  tickUpper?: number;
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string;
  description: string;
}

// ── is the pool still ours to create? ────────────────────────────────────────
//
// PoolManager.initialize is PERMISSIONLESS. A PoolKey is just five public
// values, and every one of them — token, hook, fee, spacing — is readable in
// this repo. So anyone can create our pool before we do, at any price they
// choose, and there is nothing on chain that reserves it for us.
//
// If that happens our launch transaction reverts, because initializePool inside
// the multicall fails on an already-initialized pool and takes the seed down
// with it. That is the safe direction to fail in — but it fails as an opaque
// revert on the day, which is the worst moment to be diagnosing anything.
//
// This turns it into an answer beforehand: read the pool's price first, and say
// plainly whether the pool is untouched, already sitting at our exact price, or
// squatted at someone else's.

/** v4 identifies a pool by keccak256 of the encoded key, not by a contract. */
export function poolIdFor(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

export interface PoolState {
  poolId: Hex;
  /** Zero sqrtPriceX96 is v4's "never initialized". */
  initialized: boolean;
  sqrtPriceX96: bigint;
  tick: number;
}

export async function readPoolState(key: PoolKey, rpcUrl: string): Promise<PoolState> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const poolId = poolIdFor(key);
  const [sqrtPriceX96, tick] = await client.readContract({
    address: V4_STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
  });
  return { poolId, initialized: sqrtPriceX96 !== 0n, sqrtPriceX96, tick };
}

export type PreflightStatus = "clear" | "already-at-our-price" | "squatted";

export interface Preflight {
  status: PreflightStatus;
  /** False means do not broadcast. Nothing here is worth guessing about. */
  safeToBroadcast: boolean;
  /** True when the pool exists already and only the mint should be sent. */
  skipInitialize: boolean;
  intendedSqrtPriceX96: bigint;
  actual: PoolState;
  message: string;
}

/**
 * Run this immediately before broadcasting, every time.
 *
 * It cannot PREVENT a squat — the pool can still be taken in the seconds between
 * this call and the transaction landing, and the on-chain revert is what covers
 * that. What it buys is knowing, before a cold wallet signs anything, whether
 * the launch we are about to send is the launch we designed.
 */
export async function preflightSeed(plan: SeedPlan, rpcUrl: string): Promise<Preflight> {
  const { key, sqrtPriceX96 } = buildSeedTransactions(plan);
  const actual = await readPoolState(key, rpcUrl);

  if (!actual.initialized) {
    return {
      status: "clear",
      safeToBroadcast: true,
      skipInitialize: false,
      intendedSqrtPriceX96: sqrtPriceX96,
      actual,
      message: `pool ${actual.poolId} is untouched — launch as planned`,
    };
  }

  // Someone got there first. If they happened to use our exact price the pool
  // is still the one we wanted, so seed into it and skip the creation call.
  if (actual.sqrtPriceX96 === sqrtPriceX96) {
    return {
      status: "already-at-our-price",
      safeToBroadcast: true,
      skipInitialize: true,
      intendedSqrtPriceX96: sqrtPriceX96,
      actual,
      message:
        `pool ${actual.poolId} already exists at exactly our opening price — ` +
        "send the mint alone; including initializePool would revert",
    };
  }

  // Anything else means the opening price is not ours, and seeding into it
  // would mint the entire supply against a number a stranger picked.
  const ratio = Number((actual.sqrtPriceX96 * 10_000n) / sqrtPriceX96) / 10_000;
  return {
    status: "squatted",
    safeToBroadcast: false,
    skipInitialize: false,
    intendedSqrtPriceX96: sqrtPriceX96,
    actual,
    message:
      `pool ${actual.poolId} was created by someone else at sqrtPriceX96 ${actual.sqrtPriceX96} ` +
      `(${ratio.toFixed(4)}x our intended ${sqrtPriceX96}, tick ${actual.tick}). DO NOT SEED — ` +
      "the entire supply would be priced at a number a stranger chose. Launch in a different " +
      "fee tier or tick spacing, which is a different pool that nobody has taken.",
  };
}

/**
 * Liquidity for a full-range position holding these amounts.
 *
 * Takes the smaller of what each side supports, then a 1% haircut. That haircut
 * is not superstition: the PositionManager pulls amounts at EXECUTION-time
 * price, not at the price this was computed against, and the LP guard's first
 * live re-center reverted on exactly this before the margin was added.
 */
export function liquidityFor(amount0Wei: bigint, amount1Wei: bigint, sqrtPriceX96: bigint, tickLower: number, tickUpper: number): bigint {
  const sqrtA = sqrtAtTick(tickLower);
  const sqrtB = sqrtAtTick(tickUpper);
  const sqrtP = sqrtPriceX96;
  if (sqrtP <= sqrtA || sqrtP >= sqrtB) throw new Error("opening price must sit inside the range");

  // L from the token0 side: amount0 = L * (sqrtB - sqrtP) / (sqrtP * sqrtB)
  const l0 = (amount0Wei * sqrtP * sqrtB) / (Q96 * (sqrtB - sqrtP));
  // L from the token1 side: amount1 = L * (sqrtP - sqrtA)
  const l1 = (amount1Wei * Q96) / (sqrtP - sqrtA);
  const l = (l0 < l1 ? l0 : l1) * 99n / 100n;
  if (l <= 0n) throw new Error("amounts too small to mint any liquidity");
  return l;
}

/** sqrt(1.0001^tick) * 2^96, to the precision this needs. */
function sqrtAtTick(tick: number): bigint {
  const ratio = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(ratio * 2 ** 96));
}

/**
 * Every transaction needed to go from "token deployed" to "pool trading",
 * in order, unsigned.
 *
 * CREATION AND SEEDING ARE ONE TRANSACTION, and they have to be. A v4 pool that
 * exists with no liquidity still has a price, and a swap against an empty pool
 * moves that price without exchanging anything worth having. Left as two
 * transactions, the gap between them is an open invitation: anyone watching can
 * shift the opening price, and the mint that follows lands at their number
 * instead of ours — pulling a lopsided mix of a supply that cannot be re-seeded.
 * The PositionManager's multicall closes the gap, and it is still one signature.
 *
 * What that costs is knowing which of the two steps failed, since they now
 * revert as one. That is a fair trade against handing a stranger the opening
 * price of a pool holding the entire supply.
 *
 * The approvals stay separate. That was never about atomicity — v4 pulls ERC-20s
 * through Permit2, which needs two grants (token -> Permit2, then Permit2 -> the
 * PositionManager), and this sequence is signed by a cold wallet that should be
 * able to read each grant for what it is. Neither approval is exploitable in the
 * gap: they authorise the PositionManager and nobody else.
 */
export function buildSeedTransactions(
  plan: SeedPlan,
  /**
   * Set when preflightSeed reports the pool already exists at our exact price.
   * The mint goes out alone, because bundling initializePool into a pool that
   * is already initialized reverts the whole transaction.
   */
  opts: { skipInitialize?: boolean } = {},
): { key: PoolKey; sqrtPriceX96: bigint; txs: UnsignedTx[] } {
  if (plan.hook === NATIVE_ETH) {
    throw new Error("hook address is required — a pool created without it can never be given one later");
  }
  const { tickLower, tickUpper } = {
    ...fullRangeTicks(MERD_POOL_TICK_SPACING),
    ...(plan.tickLower != null && plan.tickUpper != null ? { tickLower: plan.tickLower, tickUpper: plan.tickUpper } : {}),
  };

  const key: PoolKey = {
    currency0: NATIVE_ETH,
    currency1: MERD_ADDRESS,
    fee: MERD_POOL_FEE,
    tickSpacing: MERD_POOL_TICK_SPACING,
    hooks: plan.hook,
  };
  const sqrtPriceX96 = sqrtPriceX96For(plan.ethWei, plan.merdWei);
  const liquidity = liquidityFor(plan.ethWei, plan.merdWei, sqrtPriceX96, tickLower, tickUpper);
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks] as const;

  const mintParams = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
    [
      keyTuple as never,
      tickLower,
      tickUpper,
      liquidity,
      // Caps, not targets: the position takes what the price requires and never
      // more than this. Set to exactly what we intend to spend.
      plan.ethWei,
      plan.merdWei,
      plan.recipient,
      "0x",
    ],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [key.currency0, key.currency1]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
    encodePacked(["bytes1", "bytes1"], [MINT_POSITION, SETTLE_PAIR]),
    [mintParams, settleParams],
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  return {
    key,
    sqrtPriceX96,
    txs: [
      {
        to: MERD_ADDRESS,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, plan.merdWei] }),
        value: "0",
        description: `approve Permit2 to move ${plan.merdWei / 10n ** 18n} MERD`,
      },
      {
        to: PERMIT2,
        data: encodeFunctionData({
          abi: PERMIT2_ABI,
          functionName: "approve",
          // uint160 max is the Permit2 convention for "no amount limit"; the
          // expiry is what bounds it, and the mint below is the only spender.
          args: [MERD_ADDRESS, V4_POSITION_MANAGER, (1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 86_400],
        }),
        value: "0",
        description: "allow the PositionManager to pull MERD through Permit2 (24h)",
      },
      opts.skipInitialize
        ? {
            to: V4_POSITION_MANAGER,
            data: encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
            value: plan.ethWei.toString(),
            description:
              `seed the EXISTING pool and mint the position to ${plan.recipient} — ` +
              "creation is omitted because the pool already exists at our opening price",
          }
        : {
            to: V4_POSITION_MANAGER,
            // multicall delegatecalls each entry, so both run against the
            // PositionManager's own storage with the caller and msg.value intact.
            // initializePool ignores the value; modifyLiquidities spends it.
            data: encodeFunctionData({
              abi: POSITION_MANAGER_ABI,
              functionName: "multicall",
              args: [
                [
                  encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "initializePool", args: [keyTuple as never, sqrtPriceX96] }),
                  encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
                ],
              ],
            }),
            value: plan.ethWei.toString(),
            description:
              `create the ETH/MERD pool at ${MERD_POOL_FEE / 10_000}% with the treasury hook AND seed it in the same transaction, ` +
              `minting the position to ${plan.recipient} — atomic so the opening price cannot be moved in between`,
          },
    ],
  };
}
