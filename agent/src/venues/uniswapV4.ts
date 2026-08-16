// Real Uniswap v4 swap execution for the ETH<->$INDEX pool, via
// indexUniversalRouter — a *verified* UniversalRouter deployment on Robinhood
// Chain, confirmed 2026-07-11 by decoding real successful ETH<->$INDEX swaps
// on-chain (not the `universalRouter` address from theindex.finance's own
// docs — a real attempt through that one reverted; this is the address real
// traders' transactions actually call for this specific hook-gated pool).
// Still deliberately not indexSwapRouter (unverified, no public ABI).
//
// PoolKey (currency0=native ETH, currency1=$INDEX, fee=10000, tickSpacing=200,
// hooks=indexFeeHook) was confirmed on-chain: reading its slot0 returns a
// non-zero sqrtPriceX96, i.e. this exact key resolves to the real, funded
// pool. The pool's own LP fee is 1% (static, to LPs); the separate 3% ETH
// fee that funds distributions is taken by the hook itself, not this fee
// field — both are real and distinct, per the on-chain read.
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbiParameters,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { getPublicClient, getWalletClient, getAgentSigner } from "./signer.js";
import { INDEX_CONTRACTS } from "./indexContracts.js";
import { exactTransferAmount } from "./positionAccounting.js";

const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // canonical, same address on every EVM chain
const POOL_MANAGER = INDEX_CONTRACTS.poolManager as Address;
const UNIVERSAL_ROUTER = INDEX_CONTRACTS.indexUniversalRouter as Address;
const INDEX_TOKEN = INDEX_CONTRACTS.indexToken as Address;
const HOOK = INDEX_CONTRACTS.indexFeeHook as Address;
const POOL_FEE = 10000; // 1% LP fee tier — confirmed on-chain, see module comment
const TICK_SPACING = 200;

// This pool is thin (~$3.6M cap): empirically measured via risk-free eth_call
// simulation (2026-07-11) that a $180 buy has ~4-4.5% real price impact — a
// 2% bound reverted every time, not from a bug but from the pool's own
// slippage protection correctly rejecting an unreachable minimum. 6% gives
// margin above the measured impact for further price movement before this
// executes. This is a real cost of trading this pool at this size, not free
// margin — revisit if trade sizing changes materially.
const MAX_SLIPPAGE_BPS = 600n; // 6%

const POOL_KEY = {
  currency0: NATIVE,
  currency1: INDEX_TOKEN,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: HOOK,
} as const;

function poolId(): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      POOL_KEY.currency0,
      POOL_KEY.currency1,
      POOL_KEY.fee,
      POOL_KEY.tickSpacing,
      POOL_KEY.hooks,
    ]),
  );
}

/** Live $INDEX-per-ETH price, read directly from the pool's own slot0 (no off-chain price needed for this leg). */
export async function readIndexPerEth(): Promise<number> {
  const client = getPublicClient();
  const id = poolId();
  const POOLS_SLOT = 6n;
  const base = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [id, POOLS_SLOT]));
  const slot0 = await client.readContract({
    address: POOL_MANAGER,
    abi: [parseAbiItem("function extsload(bytes32 slot) view returns (bytes32)")],
    functionName: "extsload",
    args: [base],
  });
  const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n);
  if (sqrtPriceX96 === 0n) throw new Error("$INDEX/ETH pool not initialized at the expected key");
  const Q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  return sqrtP * sqrtP; // token1(INDEX)/token0(ETH) — matches Uniswap's price convention
}

/**
 * ETH/USD from the on-chain NATIVE/USDG bridge pool (fee 500, tickSpacing 10) —
 * the same chain the wallet's ETH lives on, no external dependency. Matches Yahoo
 * to ~0.03%. Primary source because Yahoo (the fallback below) blocks datacenter
 * IPs, so from Railway it returned nothing and the wallet's ETH valued at $0.
 */
async function ethUsdFromPool(): Promise<number> {
  const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
  const Q96 = 2 ** 96;
  const poolId = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [NATIVE, USDG, 500, 10, NATIVE]),
  );
  const [sqrtP] = await getPublicClient().readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [poolId],
  });
  // (sqrtP/Q96)^2 is USDG(6dp) per NATIVE(18dp) in raw units; scale by 1e12 for the decimal gap.
  return (Number(sqrtP) / Q96) ** 2 * 1e12;
}

async function externalEthUsd(): Promise<number> {
  const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?range=1d&interval=1d", {
    headers: { "User-Agent": "Mozilla/5.0 (Meridian agent)" },
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
  const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== "number") throw new Error("couldn't fetch ETH/USD price");
  return price;
}

/**
 * PURE: which price to believe. The pool is one THIN venue: on 2026-08-16
 * someone displaced it to ~$484 for twenty minutes and the gauge marked the
 * whole book at quarter price, printing a phantom $1,658 record drawdown and
 * firing the breaker's stage-2 halt on a book that had lost nothing. So a
 * pool reading only stands on its own when it agrees with the last accepted
 * price; anything else is corroborated against the external feed first. A
 * REAL crash passes, because the world's price agrees with the pool's.
 */
export function chooseEthUsd(
  pool: number | null,
  external: number | null,
  lastGood: number | null,
  tolerance = 0.25,
): { price: number; source: "pool" | "external" | "last-good" } | null {
  const near = (a: number, b: number) => Math.abs(a - b) / b <= tolerance;
  if (pool != null && lastGood != null && near(pool, lastGood)) return { price: pool, source: "pool" };
  if (pool != null && external != null && near(pool, external)) return { price: pool, source: "pool" };
  if (external != null) return { price: external, source: "external" };
  if (lastGood != null) return { price: lastGood, source: "last-good" };
  if (pool != null) return { price: pool, source: "pool" }; // nothing to check against; best effort
  return null;
}

let lastGoodEthUsd: { price: number; at: number } | null = null;
const LAST_GOOD_TTL_MS = 24 * 3600e3;

/** ETH/USD, on-chain first, DESPIKED: a suspicious pool reading is checked
 *  against the external feed before it can reprice the book, including on a
 *  fresh boot (booting INTO a displaced pool is how the 08-16 poisoning got
 *  in: the restart had no memory, so the $484 reading looked normal). */
export async function fetchEthUsd(): Promise<number> {
  let pool: number | null = null;
  try {
    const p = await ethUsdFromPool();
    if (Number.isFinite(p) && p > 0) pool = p;
  } catch {
    /* on-chain read failed */
  }
  const lg = lastGoodEthUsd && Date.now() - lastGoodEthUsd.at < LAST_GOOD_TTL_MS ? lastGoodEthUsd.price : null;
  // Fast path: the pool agrees with recent history, no external call needed.
  const fast = pool != null && lg != null ? chooseEthUsd(pool, null, lg) : null;
  if (fast && fast.source === "pool") {
    lastGoodEthUsd = { price: fast.price, at: Date.now() };
    return fast.price;
  }
  let external: number | null = null;
  try {
    const e = await externalEthUsd();
    if (Number.isFinite(e) && e > 0) external = e;
  } catch {
    /* external unreachable */
  }
  const pick = chooseEthUsd(pool, external, lg);
  if (!pick) throw new Error("couldn't fetch ETH/USD price");
  if (pick.source !== "pool") {
    console.error(
      `[ethUsd] pool reads ${pool == null ? "nothing" : `$${pool.toFixed(0)}`}, trusting ${pick.source} $${pick.price.toFixed(0)}${lg != null ? ` (last good $${lg.toFixed(0)})` : ""}`,
    );
  }
  lastGoodEthUsd = { price: pick.price, at: Date.now() };
  return pick.price;
}

const erc20Abi = [
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
];
const permit2Abi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
  parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)"),
];

/** Idempotent — only sends an approval tx if the current allowance is insufficient. ERC20-in swaps (selling $INDEX) settle through Permit2, so both hops need approving once. */
async function ensureIndexApprovedForSwap(amount: bigint): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;

  const erc20Allowance = await client.readContract({
    address: INDEX_TOKEN,
    abi: erc20Abi,
    functionName: "allowance",
    args: [signer.address, PERMIT2],
  });
  if (erc20Allowance < amount) {
    const hash = await wallet.writeContract({
      address: INDEX_TOKEN,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, (1n << 256n) - 1n],
    });
    await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  }

  const [permit2Allowance] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [signer.address, INDEX_TOKEN, UNIVERSAL_ROUTER],
  });
  if (BigInt(permit2Allowance) < amount) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
    const hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [INDEX_TOKEN, UNIVERSAL_ROUTER, (1n << 160n) - 1n, expiration],
    });
    await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  }
}

// Uniswap v4 Universal Router command + action bytes (canonical, from
// Uniswap's own Commands.sol / Actions.sol — not this-project-specific).
const V4_SWAP_COMMAND = "0x10";
const ACTION_SWAP_EXACT_IN_SINGLE = "0x06";
const ACTION_SETTLE_ALL = "0x0c";
const ACTION_TAKE_ALL = "0x0f";

const universalRouterAbi = [
  parseAbiItem("function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"),
];

/**
 * Encode one ETH<->$INDEX exact-in single-pool swap as a raw {to, data, value}
 * transaction for ANY sender — extracted from the house execution path so the
 * earn surface can hand a user a transaction THEIR wallet signs. Standard v4
 * encoding on the VERIFIED indexUniversalRouter (see module comment); output
 * goes to msg.sender via TAKE_ALL, so no recipient parameter exists to pin —
 * whoever signs receives. Pure encoding: no reads, no signing, no approvals.
 */
export function buildIndexSwapCalldata(params: {
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadlineSec?: number;
}): { to: Address; data: Hex; value: bigint } {
  const { zeroForOne, amountIn, amountOutMinimum } = params;
  const swapParams = encodeAbiParameters(
    parseAbiParameters(
      "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData",
    ),
    [POOL_KEY, zeroForOne, amountIn, amountOutMinimum, "0x"],
  );
  const settleCurrency = zeroForOne ? POOL_KEY.currency0 : POOL_KEY.currency1;
  const takeCurrency = zeroForOne ? POOL_KEY.currency1 : POOL_KEY.currency0;
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount"), [settleCurrency, amountIn]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount"), [takeCurrency, amountOutMinimum]);

  const actions = encodePacked(
    ["bytes1", "bytes1", "bytes1"],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
  );
  const v4SwapInput = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [
    actions,
    [swapParams, settleParams, takeParams],
  ]);

  const deadline = BigInt(params.deadlineSec ?? Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [V4_SWAP_COMMAND, [v4SwapInput], deadline],
  });
  return { to: UNIVERSAL_ROUTER, data, value: zeroForOne ? amountIn : 0n };
}

/**
 * One ETH<->$INDEX leg through the verified UniversalRouter, exact-input,
 * single pool, with an on-chain-derived slippage floor. `zeroForOne=true`
 * is ETH->INDEX (buy); false is INDEX->ETH (sell). Returns the real amount
 * received, decoded from the receipt's Transfer log — the actual fill,
 * reflecting real execution, not the pre-trade estimate — so callers can
 * track a true cost/proceeds basis instead of the nominal amountUsd.
 */
async function swapExactInSingle(params: {
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Promise<{ hash: Hex; amountReceived: number | null }> {
  const { zeroForOne, amountIn, amountOutMinimum } = params;
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;

  const { to, data, value } = buildIndexSwapCalldata({ zeroForOne, amountIn, amountOutMinimum });

  const hash = await wallet.sendTransaction({ to, data, value });
  const client = getPublicClient();
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  const outputToken = zeroForOne ? POOL_KEY.currency1 : POOL_KEY.currency0;
  const amountReceived =
    outputToken === NATIVE
      ? null // native ETH received doesn't emit a Transfer log; balance-diff would be needed instead
      : exactTransferAmount(receipt, outputToken, signer.address);
  return { hash, amountReceived };
}

/** ETH -> $INDEX for `amountUsd` notional. Returns the tx hash and the exact $INDEX tokens received. */
export async function realBuyIndex(amountUsd: number): Promise<{ hash: Hex; amountReceived: number | null }> {
  const [ethUsd, indexPerEth] = await Promise.all([fetchEthUsd(), readIndexPerEth()]);
  const amountInEth = amountUsd / ethUsd;
  const amountIn = BigInt(Math.round(amountInEth * 1e18));
  const expectedOut = amountInEth * indexPerEth;
  const amountOutMinimum = BigInt(Math.round(expectedOut * 1e18 * Number(10_000n - MAX_SLIPPAGE_BPS) / 10_000));
  return swapExactInSingle({ zeroForOne: true, amountIn, amountOutMinimum });
}

/** $INDEX -> ETH for `amountUsd` notional (the position's tracked entry size). Returns the tx hash (ETH received isn't decodable from a Transfer log — native currency). */
export async function realSellIndex(amountUsd: number): Promise<{ hash: Hex; amountReceived: number | null }> {
  const [ethUsd, indexPerEth] = await Promise.all([fetchEthUsd(), readIndexPerEth()]);
  const indexUsd = ethUsd / indexPerEth;
  const amountInIndex = amountUsd / indexUsd;
  const amountIn = BigInt(Math.round(amountInIndex * 1e18));
  await ensureIndexApprovedForSwap(amountIn);
  const expectedOutEth = amountInIndex / indexPerEth;
  const amountOutMinimum = BigInt(Math.round(expectedOutEth * 1e18 * Number(10_000n - MAX_SLIPPAGE_BPS) / 10_000));
  return swapExactInSingle({ zeroForOne: false, amountIn, amountOutMinimum });
}

/**
 * $INDEX -> ETH for an EXACT wei amount (e.g. a real wallet balance read via
 * `balanceOf`) — takes a bigint, not a JS number, deliberately: a real
 * balance at 18 decimals routinely needs ~22 significant digits, well beyond
 * a float64's ~15-17, so round-tripping through `number` (as the amountUsd-
 * based helpers above do) can reconstruct a wei amount that doesn't exactly
 * match the real balance and revert with TRANSFER_FROM_FAILED. Use this when
 * the intent is to fully clear a holding, not estimate one.
 */
export async function realSellIndexExactWei(amountInWei: bigint): Promise<{ hash: Hex; amountReceived: number | null }> {
  const indexPerEth = await readIndexPerEth();
  await ensureIndexApprovedForSwap(amountInWei);
  const amountInTokens = Number(amountInWei) / 1e18;
  const expectedOutEth = amountInTokens / indexPerEth;
  const amountOutMinimum = BigInt(Math.round(expectedOutEth * 1e18 * Number(10_000n - MAX_SLIPPAGE_BPS) / 10_000));
  return swapExactInSingle({ zeroForOne: false, amountIn: amountInWei, amountOutMinimum });
}
