// Real Uniswap v4 swap execution for stock-to-stock rotation, via STANDARD,
// hookless pools — a separate, verified-cheap venue from The Index's own
// custom fee-hook pools (uniswapV4.ts). The Index doesn't own these tokens:
// AAPL/TSLA/etc. are the same canonical Robinhood Stock Token contracts
// documented at docs.robinhood.com/chain/contracts/ (confirmed by exact
// address match), just traded here through plain Uniswap v4 pools (fee tier
// only, no hook) in the SAME shared PoolManager. Confirmed on-chain
// 2026-07-11 via extsload/StateView: real, nonzero liquidity at these exact
// (currency, fee, tickSpacing, hooks=0) keys — not guessed. 15 of the 18
// Index tickers have a verified pool this way; BE, MSFT, USAR don't (at
// these 4 standard tiers, against NATIVE or USDG) and are excluded, not
// assumed. See meridian-standard-stock-pools memory.
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
import { guardWalletOp, recordWalletOp } from "../risk.js";
import { INDEX_CONTRACTS } from "./indexContracts.js";
import { fetchEthUsd } from "./uniswapV4.js";
import { recordExecution, readAllExecutions } from "../executionsLog.js";

const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const POOL_MANAGER = INDEX_CONTRACTS.poolManager as Address;
// The canonical UniversalRouter for Robinhood Chain. IMPORTANT: this fork's
// V4Router does NOT accept the standard v4-periphery action encodings — it
// wants path-based SWAP_EXACT_IN (0x07) with a 5-field ExactInputParams
// (an extra empty `bytes` between path and the amounts), tuple-wrapped, plus
// SETTLE (0x0b) / TAKE (0x0e). Recipe reverse-engineered 2026-07-11 from real
// successful swaps on the exact USDG/META pool (tx 0xc81e4dde…) and verified
// byte-identical by re-encoding + eth_call simulation from OUR wallet (OK for
// ETH->USDG, ETH->USDG->META atomic multihop, and USDG->META). The standard
// SWAP_EXACT_IN_SINGLE/SETTLE_ALL/TAKE_ALL encoding reverts here with
// SliceOutOfBounds (0x3b99b53d); on indexUniversalRouter it silently reverts
// for every stock pool. Do not "simplify" back to the standard encoding.
export const UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // Robinhood's native stablecoin, assumed ~$1 like any USD stablecoin

type Quote = "NATIVE" | "USDG";

interface PoolEntry {
  token: Address;
  quote: Quote;
  fee: number;
  tickSpacing: number;
}

// Deepest real (nonzero-liquidity) pool per ticker, verified on-chain
// 2026-07-11 by probing StateView across the four standard fee tiers
// (100/500/3000/10000) with hooks=0x0, against both NATIVE and USDG.
// … and re-verified 2026-07-11 for DEPTH, not just existence: max USD input
// at ~2% price impact from in-range liquidity (L, sqrtP). Only pools that can
// absorb a ~$180 trade with well under 1% impact are kept:
//   NVDA $12.3k, AAPL $5.6k, TSLA $2.7k, GOOGL $2.4k, META $0.9k.
// "Pool exists with nonzero liquidity" was NOT a sufficient bar — SNDK's pool
// is real but has ~$1 of depth per 1% move, and routing a $177 trade into it
// reverted every tick. All five keepers are USDG-quoted, so every rotation is
// a 2-hop atomic path with no NATIVE bridge leg.
const POOLS: Record<string, PoolEntry> = {
  AAPL: { token: INDEX_CONTRACTS.tokens.AAPL as Address, quote: "USDG", fee: 10000, tickSpacing: 200 },
  GOOGL: { token: INDEX_CONTRACTS.tokens.GOOGL as Address, quote: "USDG", fee: 10000, tickSpacing: 200 },
  META: { token: INDEX_CONTRACTS.tokens.META as Address, quote: "USDG", fee: 3000, tickSpacing: 60 },
  NVDA: { token: INDEX_CONTRACTS.tokens.NVDA as Address, quote: "USDG", fee: 3000, tickSpacing: 60 },
  TSLA: { token: INDEX_CONTRACTS.tokens.TSLA as Address, quote: "USDG", fee: 3000, tickSpacing: 60 },
  // MSFT re-added 2026-07-21: excluded before only for DEPTH (the 0.05% tier was
  // ~$12), but the 0.3% pool has since deepened to ~$40k and a USDG→MSFT swap
  // lands in faithful eth_call simulation (holdable). Tradable now; LP-deploy is
  // still gated on a mint check (poolQualify.ts), not enabled here.
  MSFT: { token: INDEX_CONTRACTS.tokens.MSFT as Address, quote: "USDG", fee: 3000, tickSpacing: 60 },
  // SPCX still EXCLUDED. Removed 2026-07-16 after a real mint reverted (0x70a08…):
  // SPCX (SpaceX) is a TRANSFER-RESTRICTED token, so our wallet couldn't receive
  // or LP it. Re-checked 2026-07-21: a USDG→SPCX swap now LANDS in faithful
  // eth_call sim (restriction may have lifted, or we're allowlisted) — but the
  // rule stands: do not re-add on simulation alone. Needs a REAL swap + mint to
  // confirm before this becomes executable.
};
// Exclusion history, RECONCILED 2026-07-27. The 2026-07-16 measurements (max
// USDG in at ~1% impact: MU/USDG 1% ~$15, AMD/USDG 1% ~$40) are obsolete: a
// tick-walking re-measure against live state (naive constant-L formula and
// tick-crossed integration agree within a few percent, validated against the
// baseline pools, and independently re-derived by an adversarial review that
// also reproduced the $15 figure exactly at the 2026-07-16 block) found the
// pools genuinely deepened ~600x in eleven days (MU in-range L grew 596x,
// block 11239912 vs live). 1%-impact depth on 2026-07-27: MU 1% ~$9.1k,
// INTC 1% ~$6.9k, COIN 1% ~$7.1k, PLTR 1% ~$5.3k, USAR 1% ~$4.1k, AMZN 0.3%
// ~$2.9k, AMD 1% ~$2.5k, SNDK 1% ~$1.8k. Note the qualifier logs depth at a
// 2% move, roughly double these figures: same reality, different definition.
// The allocator's share trap still applies: a high $/day from being most of a
// pool does not transfer. As of 2026-07-27 this table is the SEED, not the
// ceiling: swap routing also consults the qualified set pushed in below by
// signals/poolQualify, the decision that measurement justified.

const BRIDGE_FEE = 500; // 0.05% NATIVE/USDG tier — deepest of the four real tiers found, used when a rotation's two legs don't share a quote currency
const BRIDGE_TICK_SPACING = 10;

/**
 * Qualified pools pushed in by signals/poolQualify once a symbol clears all
 * three of its gates (depth, fee-score, round-trip holdability sim). The
 * qualifier PUSHES rather than being imported here because it already imports
 * this module; pulling from it would be a cycle. Registration replaces the
 * whole dynamic set each time, so a pool that thins or restricts drops out on
 * the next qualification pass instead of lingering. The hand-verified POOLS
 * table above always wins on conflict: the seed is the floor, never overridden.
 *
 * Empty until the first qualification pass completes (the allocator warms it
 * at boot), so a cold process trades only the seed. Fail-safe by construction,
 * same doctrine as poolQualify.cachedQualified.
 */
const dynamicPools = new Map<string, PoolEntry>();
export function registerQualifiedPools(list: Array<{ symbol: string; token: Address; fee: number; tickSpacing: number }>): void {
  dynamicPools.clear();
  for (const p of list) {
    if (POOLS[p.symbol]) continue; // the seed outranks the qualifier
    dynamicPools.set(p.symbol, { token: p.token, quote: "USDG", fee: p.fee, tickSpacing: p.tickSpacing });
  }
}

/** Resolve a symbol to its pool entry: hand-verified seed first, then the qualified set. */
function poolEntryFor(symbol: string): PoolEntry | undefined {
  return POOLS[symbol] ?? dynamicPools.get(symbol);
}

/** The static hand-verified seed. Fixed membership; samplers that pay per-symbol costs (basis/Yahoo) stay on this. */
export const TRADABLE_SYMBOLS = Object.keys(POOLS);
/** The live tradable set: seed plus currently-qualified pools. Grows and shrinks with qualification. */
export function tradableSymbols(): string[] {
  return [...TRADABLE_SYMBOLS, ...dynamicPools.keys()];
}
export function isTradable(symbol: string): boolean {
  return !!poolEntryFor(symbol);
}

// The originally hand-verified baseline: standard params, depth-checked, and
// proven to mint. Fixed on purpose (NOT derived from POOLS) so ANY pool added
// beyond these must earn auto-executability with a real landed mint.
const TRUSTED_BASELINE = new Set(["AAPL", "GOOGL", "META", "NVDA", "TSLA"]);
let mintedCache: { at: number; symbols: Set<string> } | null = null;

/**
 * The LANDED-MINT GATE. A pool is safe to AUTO-execute into only if it's
 * baseline-trusted OR a real lp-mint has already SUCCEEDED in it (the durable
 * executions ledger is the proof). This is what stops autonomous rebalancing
 * from moving into a discovered-but-unproven pool — e.g. SPCX, which passed
 * depth checks but reverts on mint (transfer-restricted). New pools become
 * auto-executable only after a deliberate lp-open lands a mint.
 */
export function isAutoExecutable(symbol: string): boolean {
  if (!isTradable(symbol)) return false; // no pool params → can't execute at all
  if (TRUSTED_BASELINE.has(symbol)) return true;
  if (!mintedCache || Date.now() - mintedCache.at > 5 * 60 * 1000) {
    const symbols = new Set<string>();
    for (const r of readAllExecutions()) if (r.kind === "lp-mint" && r.success && r.toSymbol) symbols.add(r.toSymbol);
    mintedCache = { at: Date.now(), symbols };
  }
  return mintedCache.symbols.has(symbol);
}

/** Per-leg pool fee in percent (0.3 or 1.0 across the current universe) — the strategy's cost-aware bar consults this. */
export function poolFeePct(symbol: string): number {
  const entry = poolEntryFor(symbol);
  return entry ? entry.fee / 10_000 : 1;
}

// The four standard Uniswap fee tiers (fee, tickSpacing) we probe for a USDG
// pool. Discovery reads pool state + flow across every ticker × tier, so a pool
// that has GAINED depth/volume since the last manual census surfaces on its own.
const STANDARD_TIERS: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

export interface PoolCandidate {
  name: string; // "SYMBOL/USDG X%" — matches lp_score's pool naming for the join
  symbol: string;
  token: Address;
  fee: number;
  ts: number;
  feeRate: number; // fee as a fraction, e.g. 3000 -> 0.003
}

/**
 * Every (ticker × standard fee tier) USDG pool key to probe for LIVE discovery,
 * so the allocator/lp_score re-check the whole on-chain stock universe each scan
 * instead of a fixed 5. Broad by design: downstream, a pool with no liquidity is
 * skipped and one with no swap volume scores zero — only pools that actually pay
 * survive the ranking. This is how "the census feeds trading": new depth/flow on
 * any of the 18 tickers gets picked up without a code change.
 */
export function poolCandidates(): PoolCandidate[] {
  const out: PoolCandidate[] = [];
  for (const [symbol, token] of Object.entries(INDEX_CONTRACTS.tokens)) {
    for (const [fee, ts] of STANDARD_TIERS) {
      out.push({ name: `${symbol}/USDG ${fee / 10_000}%`, symbol, token: token as Address, fee, ts, feeRate: fee / 1_000_000 });
    }
  }
  return out;
}

// Several of these pools are visibly thinner than $INDEX's own (some in the
// 1e11-1e12 raw-liquidity range vs 1e15-1e17 for others — see
// meridian-standard-stock-pools memory) — a wider default bound than
// $INDEX's empirically-measured 6% until each pool's real price impact at
// live trade sizes is separately measured. Revisit downward per-pool once
// that's done.
const DEFAULT_SLIPPAGE_BPS = 800n; // 8%

function quoteAddress(q: Quote): Address {
  return q === "NATIVE" ? NATIVE : USDG;
}

function sortedPoolKey(a: Address, b: Address, fee: number, tickSpacing: number) {
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: NATIVE } as const;
}
type PoolKey = ReturnType<typeof sortedPoolKey>;

function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

async function readSqrtPriceX96(key: PoolKey): Promise<bigint> {
  const client = getPublicClient();
  const id = poolId(key);
  const POOLS_SLOT = 6n;
  const base = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [id, POOLS_SLOT]));
  const slot0 = await client.readContract({
    address: POOL_MANAGER,
    abi: [parseAbiItem("function extsload(bytes32 slot) view returns (bytes32)")],
    functionName: "extsload",
    args: [base],
  });
  return BigInt(slot0) & ((1n << 160n) - 1n);
}

/** currency1-per-currency0 price, Uniswap's own convention. */
function priceFromSqrt(sqrtPriceX96: bigint): number {
  const Q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  return sqrtP * sqrtP;
}

async function currencyBalance(currency: Address, owner: Address): Promise<bigint> {
  const client = getPublicClient();
  if (currency === NATIVE) return client.getBalance({ address: owner });
  return client.readContract({
    address: currency,
    abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
    functionName: "balanceOf",
    args: [owner],
  });
}

const erc20Abi = [
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
];
const permit2Abi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
  parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)"),
];

/** Idempotent, generalized to any ERC20 input currency (native needs no approval). */
async function ensureApprovedForSwap(token: Address, amount: bigint): Promise<void> {
  if (token === NATIVE) return;
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;

  const erc20Allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [signer.address, PERMIT2],
  });
  if (erc20Allowance < amount) {
    const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [PERMIT2, (1n << 256n) - 1n] });
    await client.waitForTransactionReceipt({ hash });
  }

  const [permit2Allowance] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [signer.address, token, UNIVERSAL_ROUTER],
  });
  if (BigInt(permit2Allowance) < amount) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, UNIVERSAL_ROUTER, (1n << 160n) - 1n, expiration],
    });
    await client.waitForTransactionReceipt({ hash });
  }
}

const V4_SWAP_COMMAND = "0x10";
const ACTION_SWAP_EXACT_IN = "0x07"; // path-based, NOT 0x06 single (see UNIVERSAL_ROUTER comment)
const ACTION_SETTLE = "0x0b";
const ACTION_TAKE = "0x0e";
const universalRouterAbi = [parseAbiItem("function execute(bytes commands, bytes[] inputs, uint256 deadline) payable")];

/** One hop of a swap path: the pool is (input currency of this hop, outputCurrency) at (fee, tickSpacing). */
export interface RouteHop {
  outputCurrency: Address;
  fee: number;
  tickSpacing: number;
}

/**
 * Raw-unit output-per-input rate of one hop's pool at current price. Raw
 * units compose across a path regardless of each currency's decimals — the
 * 1e18/1e6 scale factors are baked into the pool prices themselves.
 */
export async function hopRate(inputCurrency: Address, h: RouteHop): Promise<number> {
  const key = sortedPoolKey(inputCurrency, h.outputCurrency, h.fee, h.tickSpacing);
  const sqrtPriceX96 = await readSqrtPriceX96(key);
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized at the expected key");
  const price = priceFromSqrt(sqrtPriceX96); // currency1 per currency0
  return key.currency0.toLowerCase() === inputCurrency.toLowerCase() ? price : 1 / price;
}

/**
 * Encode one atomic multi-hop exact-in v4 swap as a raw {to, data, value}
 * transaction for ANY sender — the same patched path encoding the house wallet
 * executes with (see the UNIVERSAL_ROUTER comment for provenance), split out so
 * the earn surface can hand a user a transaction THEIR wallet signs. Pure
 * encoding: no reads, no signing, no approvals — the caller owns those.
 */
export function buildSwapExactInCalldata(params: {
  currencyIn: Address;
  route: RouteHop[];
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** who receives the output currency — the tx sender for user swaps */
  recipient: Address;
  deadlineSec?: number;
}): { to: Address; data: Hex; value: bigint } {
  const { currencyIn, route, amountIn, amountOutMinimum, recipient } = params;
  const outputCurrency = route[route.length - 1].outputCurrency;

  const swapParams = encodeAbiParameters(
    parseAbiParameters(
      "(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, bytes extra, uint128 amountIn, uint128 amountOutMinimum) p",
    ),
    [
      {
        currencyIn,
        path: route.map((h) => ({ intermediateCurrency: h.outputCurrency, fee: h.fee, tickSpacing: h.tickSpacing, hooks: NATIVE, hookData: "0x" as Hex })),
        extra: "0x" as Hex,
        amountIn,
        amountOutMinimum,
      },
    ],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [currencyIn, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [outputCurrency, recipient, 0n]);

  const actions = encodePacked(["bytes1", "bytes1", "bytes1"], [ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE]);
  const v4SwapInput = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [actions, [swapParams, settleParams, takeParams]]);

  const deadline = BigInt(params.deadlineSec ?? Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [V4_SWAP_COMMAND, [v4SwapInput], deadline] });
  return { to: UNIVERSAL_ROUTER, data, value: currencyIn === NATIVE ? amountIn : 0n };
}

/**
 * ONE atomic multi-hop exact-in swap through the UniversalRouter's patched
 * v4 path encoding (see the UNIVERSAL_ROUTER comment for provenance). All
 * hops settle in a single transaction — no stranded intermediate currency if
 * a later leg can't fill, unlike the previous one-tx-per-hop design (which
 * did exactly that on its first live run: $180 parked in USDG when leg 2
 * reverted). Output measured as a real balance delta.
 */
async function swapExactInPath(params: {
  currencyIn: Address;
  route: RouteHop[];
  amountIn: bigint;
}): Promise<{ hash: Hex; amountOutReal: bigint }> {
  const { currencyIn, route, amountIn } = params;
  const signer = getAgentSigner()!;
  const wallet = getWalletClient();
  const outputCurrency = route[route.length - 1].outputCurrency;

  // Expected output = amountIn × product of per-hop rates; slippage floor
  // compounds per hop (each pool contributes its own fee + impact).
  let expected = Number(amountIn);
  let cur = currencyIn;
  for (const h of route) {
    expected *= await hopRate(cur, h);
    expected *= Number(10_000n - DEFAULT_SLIPPAGE_BPS) / 10_000;
    cur = h.outputCurrency;
  }
  const amountOutMinimum = BigInt(Math.round(expected));

  await ensureApprovedForSwap(currencyIn, amountIn);

  const { to, data, value } = buildSwapExactInCalldata({ currencyIn, route, amountIn, amountOutMinimum, recipient: signer.address });

  const balanceBefore = await currencyBalance(outputCurrency, signer.address);
  const hash = await wallet.sendTransaction({ to, data, value });
  const client = getPublicClient();
  await client.waitForTransactionReceipt({ hash });
  const balanceAfter = await currencyBalance(outputCurrency, signer.address);
  return { hash, amountOutReal: balanceAfter - balanceBefore };
}

const BRIDGE_HOP_TO_USDG: RouteHop = { outputCurrency: USDG, fee: BRIDGE_FEE, tickSpacing: BRIDGE_TICK_SPACING };

/**
 * Pure NATIVE to USDG swap builder through the proven bridge pool, for a
 * sender whose key lives OFF this box (the treasury funding its own scout
 * payouts from its fee income). No reads, no signing: the caller owns the
 * amounts, the slippage floor, and the signature.
 */
export function buildEthToUsdgCalldata(params: { amountInWei: bigint; amountOutMinimum: bigint; recipient: Address }): {
  to: Address;
  data: Hex;
  value: bigint;
} {
  return buildSwapExactInCalldata({
    currencyIn: NATIVE,
    route: [BRIDGE_HOP_TO_USDG],
    amountIn: params.amountInWei,
    amountOutMinimum: params.amountOutMinimum,
    recipient: params.recipient,
  });
}
const BRIDGE_HOP_TO_NATIVE: RouteHop = { outputCurrency: NATIVE, fee: BRIDGE_FEE, tickSpacing: BRIDGE_TICK_SPACING };

/**
 * Convert ~amountUsd of native ETH into USDG through the same bridge pool every
 * ETH-entry trade already uses (proven path: first live trade + yield entries).
 * Used to fund LP deployments from the wallet's idle ETH without touching any
 * stock pool. Returns the realized USDG credited (measured balance delta).
 */
export async function realSwapEthToUsdg(params: { amountUsd: number }): Promise<{ hash: Hex; usdgReceived: number }> {
  guardWalletOp(`eth->usdg $${params.amountUsd.toFixed(0)}`);
  recordWalletOp(params.amountUsd, "eth-usdg");
  const ethUsd = await fetchEthUsd();
  const amountIn = BigInt(Math.round((params.amountUsd / ethUsd) * 1e18));
  const { hash, amountOutReal } = await swapExactInPath({ currencyIn: NATIVE, route: [BRIDGE_HOP_TO_USDG], amountIn });
  return { hash, usdgReceived: Number(amountOutReal) / 10 ** USDG_DECIMALS };
}

const USDG_DECIMALS = 6; // stock tokens and NATIVE are 18

/** USD price of one `entry` token, derived on-chain (pool price × quote's USD value) — no off-chain feed needed for this leg, matching uniswapV4.ts's own pattern. */
async function tokenPriceUsd(entry: PoolEntry): Promise<number> {
  const quoteAddr = quoteAddress(entry.quote);
  const key = sortedPoolKey(entry.token, quoteAddr, entry.fee, entry.tickSpacing);
  const sqrtPriceX96 = await readSqrtPriceX96(key);
  if (sqrtPriceX96 === 0n) throw new Error("pool not initialized at the expected key");
  const price = priceFromSqrt(sqrtPriceX96); // currency1/currency0, RAW units
  const tokenIsCurrency0 = key.currency0.toLowerCase() === entry.token.toLowerCase();
  const quotePerTokenRaw = tokenIsCurrency0 ? price : 1 / price;
  // Raw ratio → human units: quote_raw/token_raw × 10^(tokenDec-quoteDec).
  // USDG is 6 decimals vs the stocks' 18, so skipping this scales the price
  // by 1e-12 and any amount sized from it by 1e12 (billions of shares).
  const quoteDecimals = entry.quote === "NATIVE" ? 18 : USDG_DECIMALS;
  const quotePerToken = quotePerTokenRaw * 10 ** (18 - quoteDecimals);
  const quoteUsd = entry.quote === "NATIVE" ? await fetchEthUsd() : 1; // USDG assumed ~$1
  return quotePerToken * quoteUsd;
}

/**
 * Current on-chain USD price for every tradable ticker — the 24/7 price feed
 * for the venue we actually execute on. Unlike the NYSE-derived equity feed,
 * these keep moving nights and weekends, which is what lets the agent trade
 * RWAs around the clock instead of staring at a frozen Friday close.
 */
/**
 * The ERC-8056 UI multiplier per symbol, as a float where 1.0 means "no
 * corporate action applied yet."
 *
 * Robinhood's tokenized stocks handle dividends and splits by adjusting this
 * multiplier while leaving balanceOf static, so a raw token now represents
 * `uiMultiplier / 1e18` real shares. Swaps trade RAW tokens, so the pool price
 * is per raw token — to compare it against a real per-share equity price you
 * must first divide by this. Verified on-chain: AAPL/NVDA sit at exactly 1.0
 * today, but MU is already 1.0000748, so this is live, not hypothetical.
 *
 * Defaults to 1.0 for any token that reverts or lacks the extension, so a token
 * without ERC-8056 behaves exactly as before rather than breaking.
 */
export async function uiMultipliers(symbols: string[]): Promise<Record<string, number>> {
  const client = getPublicClient();
  const abi = [parseAbiItem("function uiMultiplier() view returns (uint256)")];
  const pairs = await Promise.all(
    symbols.map(async (sym) => {
      const entry = poolEntryFor(sym);
      if (!entry) return [sym, 1] as const;
      try {
        const m = (await client.readContract({ address: entry.token, abi, functionName: "uiMultiplier" })) as bigint;
        // A zero or absurd multiplier is treated as 1.0 rather than trusted: a
        // bad read must never silently rescale a price by a wrong factor, which
        // would be worse than the drift this exists to correct.
        const f = Number(m) / 1e18;
        return [sym, Number.isFinite(f) && f > 0 ? f : 1] as const;
      } catch {
        return [sym, 1] as const;
      }
    }),
  );
  return Object.fromEntries(pairs);
}

export async function poolPricesUsd(): Promise<Record<string, number>> {
  // Seed plus qualified: the guard's rebalance math divides by these prices,
  // so any symbol the engine can hold MUST price here or a retile of a
  // dynamic pool would value the stock side at zero and buy the book again.
  const entries = [...Object.entries(POOLS), ...dynamicPools.entries()];
  const priced = await Promise.all(entries.map(async ([sym, e]) => [sym, await tokenPriceUsd(e)] as const));
  return Object.fromEntries(priced);
}

/**
 * Real on-chain rotation between two Index-basket stock tickers, routed
 * through their own verified hookless pools. ONE atomic transaction:
 * from-stock -> its quote (-> bridge if the quotes differ) -> to-stock. A
 * failure anywhere reverts the whole route — funds never strand mid-path.
 */
export async function realSwapStockToStock(params: {
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
}): Promise<{ hash: Hex; amountReceived: number; hops: number }> {
  const { fromSymbol, toSymbol, amountUsd } = params;
  const fromEntry = poolEntryFor(fromSymbol);
  const toEntry = poolEntryFor(toSymbol);
  if (!fromEntry) throw new Error(`no verified cheap pool for ${fromSymbol}`);
  if (!toEntry) throw new Error(`no verified cheap pool for ${toSymbol}`);

  // A rotation moves the WHOLE position between assets and pays a pool fee on
  // every hop, so it is the most expensive additive op there is — and it was the
  // only one the runaway breaker never saw. risk.ts claims to cover "ALL
  // house-wallet money movement"; this was the hole in that claim, and this exact
  // path is what churned NVDA->AAPL->NVDA in 2h on 2026-07-13.
  guardWalletOp(`rotation ${fromSymbol}->${toSymbol} $${amountUsd.toFixed(0)}`);
  recordWalletOp(amountUsd, "rotation");

  const fromPriceUsd = await tokenPriceUsd(fromEntry);
  const signer = getAgentSigner()!;
  const held = await currencyBalance(fromEntry.token, signer.address);
  let amountIn = BigInt(Math.round((amountUsd / fromPriceUsd) * 1e18));
  if (amountIn > held) amountIn = held; // price rounding must never oversell the real holding
  if (amountIn === 0n) throw new Error(`wallet holds no ${fromSymbol} to rotate`);

  const route: RouteHop[] = [{ outputCurrency: quoteAddress(fromEntry.quote), fee: fromEntry.fee, tickSpacing: fromEntry.tickSpacing }];
  if (fromEntry.quote !== toEntry.quote) route.push(toEntry.quote === "USDG" ? BRIDGE_HOP_TO_USDG : BRIDGE_HOP_TO_NATIVE);
  route.push({ outputCurrency: toEntry.token, fee: toEntry.fee, tickSpacing: toEntry.tickSpacing });

  const { hash, amountOutReal } = await swapExactInPath({ currencyIn: fromEntry.token, route, amountIn });
  return { hash, amountReceived: Number(amountOutReal) / 1e18, hops: route.length };
}

/**
 * Real on-chain LIQUIDATION: sell a held stock token into its quote currency
 * (USDG for the whole current universe) in one atomic swap. Defaults to the
 * full wallet balance; never sells more than actually held.
 */
export async function realSellStockForUsdg(params: {
  fromSymbol: string;
  amountTokens?: number;
}): Promise<{ hash: Hex; usdgReceived: number; tokensSold: number }> {
  const entry = poolEntryFor(params.fromSymbol);
  if (!entry) throw new Error(`no verified cheap pool for ${params.fromSymbol}`);
  if (entry.quote !== "USDG") throw new Error(`${params.fromSymbol} is not USDG-quoted`);
  // A sell converts stock -> USDG: de-risking, an EXIT. Never breaker-blocked —
  // a tripped breaker must not trap you from liquidating to cash. Recorded for
  // visibility, but only additive ops (buys/mints) are guarded by guardWalletOp.
  recordWalletOp(0, "lp-sell");
  const signer = getAgentSigner()!;
  const held = await currencyBalance(entry.token, signer.address);
  let amountIn = params.amountTokens ? BigInt(Math.round(params.amountTokens * 1e18)) : held;
  if (amountIn > held) amountIn = held;
  if (amountIn === 0n) throw new Error(`wallet holds no ${params.fromSymbol}`);
  const { hash, amountOutReal } = await swapExactInPath({
    currencyIn: entry.token,
    route: [{ outputCurrency: USDG, fee: entry.fee, tickSpacing: entry.tickSpacing }],
    amountIn,
  });
  const usdgReceived = Number(amountOutReal) / 1e6;
  recordExecution({
    ts: Date.now(),
    kind: "liquidation",
    fromSymbol: params.fromSymbol,
    toSymbol: "USDG",
    amountUsd: usdgReceived,
    success: true,
    txHash: hash,
  });
  return { hash, usdgReceived, tokensSold: Number(amountIn) / 1e18 };
}

/**
 * Real on-chain ENTRY into a single Index-basket stock ticker when the wallet
 * has no stock position to rotate out of. Prefers spending an existing USDG
 * balance (e.g. recovered/stranded quote currency) before touching native
 * ETH; either way it's ONE atomic transaction.
 */
export async function realBuyStockFromNative(params: {
  toSymbol: string;
  amountUsd: number;
}): Promise<{ hash: Hex; amountReceived: number; hops: number }> {
  const { toSymbol, amountUsd } = params;
  const toEntry = poolEntryFor(toSymbol);
  if (!toEntry) throw new Error(`no verified cheap pool for ${toSymbol}`);
  guardWalletOp(`lp-buy ${toSymbol}`); // global runaway breaker
  recordWalletOp(amountUsd, "lp-buy");
  const signer = getAgentSigner()!;

  const stockHop: RouteHop = { outputCurrency: toEntry.token, fee: toEntry.fee, tickSpacing: toEntry.tickSpacing };

  // Spend an existing USDG balance first if it can fund (most of) the trade —
  // this is also the recovery path for quote currency stranded by any earlier
  // partial route.
  if (toEntry.quote === "USDG") {
    const usdgBalance = await currencyBalance(USDG, signer.address);
    const wantedUsdgRaw = BigInt(Math.round(amountUsd * 1e6)); // USDG is 6 decimals, ~$1
    if (usdgBalance >= (wantedUsdgRaw * 95n) / 100n) {
      const amountIn = usdgBalance < wantedUsdgRaw ? usdgBalance : wantedUsdgRaw;
      const { hash, amountOutReal } = await swapExactInPath({ currencyIn: USDG, route: [stockHop], amountIn });
      return { hash, amountReceived: Number(amountOutReal) / 1e18, hops: 1 };
    }
  }

  const ethUsd = await fetchEthUsd();
  const amountIn = BigInt(Math.round((amountUsd / ethUsd) * 1e18));
  const route: RouteHop[] = toEntry.quote === "NATIVE" ? [stockHop] : [BRIDGE_HOP_TO_USDG, stockHop];
  const { hash, amountOutReal } = await swapExactInPath({ currencyIn: NATIVE, route, amountIn });
  return { hash, amountReceived: Number(amountOutReal) / 1e18, hops: route.length };
}
