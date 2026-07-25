// Real Uniswap v4 liquidity positions on the depth-verified stock pools —
// the LP side of the business: instead of paying the pool's fee on every
// trade, own a share of the range and collect it. Encoding verified against
// real successful mints on this chain (tx 0x5652c553…, canonical
// PositionManager, standard v4-periphery actions — unlike the router, this
// path is NOT forked).
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiParameters,
  parseAbiItem,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { getPublicClient, getWalletClient, getAgentSigner, getAgentAddress } from "./signer.js";
import { guardWalletOp, recordWalletOp } from "../risk.js";
import { INDEX_CONTRACTS } from "./indexContracts.js";
import { cachedQualified } from "../signals/poolQualify.js";
import { recordExecution } from "../executionsLog.js";
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";

const POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const Q96 = 2 ** 96;

// v4-periphery action ids (verified live on this chain)
const MINT_POSITION = "0x02";
const DECREASE_LIQUIDITY = "0x01";
const SETTLE_PAIR = "0x0d";
const TAKE_PAIR = "0x11";

const POSITIONS_PATH = dataPath("lp-positions.jsonl");

// LP-able pools: same keys as stockPools.POOLS, USDG-quoted.
const LP_POOLS: Record<string, { token: Address; fee: number; tickSpacing: number }> = {
  NVDA: { token: INDEX_CONTRACTS.tokens.NVDA as Address, fee: 3000, tickSpacing: 60 },
  TSLA: { token: INDEX_CONTRACTS.tokens.TSLA as Address, fee: 3000, tickSpacing: 60 },
  META: { token: INDEX_CONTRACTS.tokens.META as Address, fee: 3000, tickSpacing: 60 },
  AAPL: { token: INDEX_CONTRACTS.tokens.AAPL as Address, fee: 10000, tickSpacing: 200 },
  GOOGL: { token: INDEX_CONTRACTS.tokens.GOOGL as Address, fee: 10000, tickSpacing: 200 },
};
// The trusted, mint-proven baseline. Kept SEPARATE from the qualifier so these
// five are always deployable even before the qualifier's cache has warmed, and
// so any dynamically-qualified pool is strictly additive to (never replaces) it.
export const LP_BASELINE_SYMBOLS = Object.keys(LP_POOLS);

const pmAbi = [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")];
const erc20Abi = [
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
];
const permit2Abi = [
  parseAbiItem("function allowance(address owner, address token, address spender) view returns (uint160, uint48, uint48)"),
  parseAbiItem("function approve(address token, address spender, uint160 amount, uint48 expiration)"),
];

function poolKeyOf(symbol: string) {
  // Trusted baseline first; then any pool the qualifier has vetted (depth +
  // fee-score + round-trip receive/exit sim). The qualified set is read from a
  // warm cache — if it's cold, we simply fall through to the baseline, never to
  // an unvetted pool. A dynamically-resolved pool that somehow can't be minted
  // still fails safe: the mint reverts and no capital moves.
  let p: { token: Address; fee: number; tickSpacing: number } | undefined = LP_POOLS[symbol];
  if (!p) {
    const q = cachedQualified().find((x) => x.symbol === symbol);
    if (q) p = { token: q.token, fee: q.fee, tickSpacing: q.tickSpacing };
  }
  if (!p) throw new Error(`no LP pool config for ${symbol} (not in trusted baseline, not qualified)`);
  const [currency0, currency1] = p.token.toLowerCase() < USDG.toLowerCase() ? [p.token, USDG] : [USDG, p.token];
  return { currency0, currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: NATIVE, token: p.token };
}

export async function poolTick(symbol: string): Promise<number> {
  return (await slot0(symbol)).tick;
}

async function slot0(symbol: string): Promise<{ sqrtP: number; tick: number }> {
  const k = poolKeyOf(symbol);
  const id = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, k.fee, k.tickSpacing, NATIVE]),
  );
  const [sqrtP, tick] = await getPublicClient().readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [id],
  });
  return { sqrtP: Number(sqrtP), tick: Number(tick) };
}

async function ensureApprovedForPM(token: Address): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const erc20Allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [signer.address, PERMIT2] });
  if (erc20Allowance < 1n << 128n) {
    const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [PERMIT2, (1n << 256n) - 1n] });
    await client.waitForTransactionReceipt({ hash });
  }
  const [p2] = await client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [signer.address, token, POSITION_MANAGER] });
  if (BigInt(p2) < 1n << 100n) {
    const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
    const hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, POSITION_MANAGER, (1n << 160n) - 1n, expiration],
    });
    await client.waitForTransactionReceipt({ hash });
  }
}

const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick) * Q96;

export interface LpPositionRecord {
  tokenId: string;
  symbol: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  usdgIn: number;
  tokenIn: number;
  mintedAt: number;
  txHash: string;
  // The position's OWN pool identity, read from chain alongside it. Carried on
  // the record so downstream valuation never has to re-guess the fee tier from
  // the symbol — that guess is wrong for every pool outside the hardcoded
  // baseline, and a wrong tier means a wrong poolId, which silently reads the
  // WRONG pool's price and fee growth. Optional only because file-registry rows
  // written before this existed don't carry it.
  fee?: number;
  tickSpacing?: number;
  /**
   * True when this position's cost basis (usdgIn/tokenIn/mintedAt) came from the
   * file registry. Chain discovery finds every position the wallet owns, but the
   * registry only knows what THIS backend minted — so a position minted from
   * another machine, or one whose ledger row never synced, has no basis. P&L that
   * treats a missing basis as "deposited $0" reports the entire position value as
   * profit, so every consumer must check this before measuring against cost.
   */
  hasCostBasis?: boolean;
}

/**
 * Mint a concentrated two-sided range around the current price, sized to the
 * wallet's ACTUAL balances of both currencies (deploys the largest liquidity
 * both sides can support). widthPct is total width, e.g. 4 => ±2%.
 */
export async function mintRange(params: { symbol: string; widthPct: number }): Promise<LpPositionRecord> {
  const { symbol, widthPct } = params;
  guardWalletOp(`lp-mint ${symbol}`); // global runaway breaker (counts every deploy attempt)
  recordWalletOp(0, "lp-mint");
  const k = poolKeyOf(symbol);
  const signer = getAgentSigner()!;
  const client = getPublicClient();
  const { sqrtP, tick } = await slot0(symbol);

  const halfTicks = Math.log(1 + widthPct / 200) / Math.log(1.0001);
  const ts = k.tickSpacing;
  const tickLower = Math.floor((tick - halfTicks) / ts) * ts;
  const tickUpper = Math.ceil((tick + halfTicks) / ts) * ts;

  const [bal0Raw, bal1Raw] = await Promise.all(
    [k.currency0, k.currency1].map((c) =>
      client.readContract({ address: c, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
    ),
  );
  // Keep a whisper of headroom so maxes never bind on rounding.
  const amt0 = Number(bal0Raw) * 0.995;
  const amt1 = Number(bal1Raw) * 0.995;

  const sC = Math.min(Math.max(sqrtP, sqrtAtTick(tickLower)), sqrtAtTick(tickUpper));
  const sA = sqrtAtTick(tickLower);
  const sB = sqrtAtTick(tickUpper);
  // In-range: currency0 fills [current..upper], currency1 fills [lower..current].
  const lFrom0 = (amt0 * ((sC / Q96) * (sB / Q96))) / (sB / Q96 - sC / Q96);
  const lFrom1 = amt1 / (sC / Q96 - sA / Q96);
  // Extra 1% haircut on the final liquidity: the pool pulls amounts at
  // EXECUTION-time price, not calc-time price, and the first live re-center
  // reverted exactly here — price drifted mid-rally and the needed amount
  // busted the balance cap. Headroom buys ~±1.5% of drift tolerance.
  const liquidity = BigInt(Math.floor(Math.min(lFrom0, lFrom1) * 0.99));
  if (liquidity <= 0n) throw new Error("insufficient balances for any liquidity in this range");

  await ensureApprovedForPM(k.currency0);
  await ensureApprovedForPM(k.currency1);

  const mintParams = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
    [
      [k.currency0, k.currency1, k.fee, k.tickSpacing, NATIVE],
      tickLower,
      tickUpper,
      liquidity,
      bal0Raw, // amountMax caps: never spend beyond the wallet's real balances
      bal1Raw,
      signer.address,
      "0x",
    ],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [k.currency0, k.currency1]);
  const actions = encodePacked(["bytes1", "bytes1"], [MINT_POSITION, SETTLE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [mintParams, settleParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`mint reverted: ${hash}`);

  // tokenId from the ERC721 mint Transfer(0x0 -> us) on the PositionManager.
  const transferTopic = keccak256(toBytes("Transfer(address,address,uint256)"));
  const mintLog = receipt.logs.find(
    (l) => l.address.toLowerCase() === POSITION_MANAGER.toLowerCase() && l.topics[0] === transferTopic && BigInt(l.topics[1]!) === 0n,
  );
  const tokenId = mintLog ? BigInt(mintLog.topics[3]!).toString() : "unknown";

  const [after0, after1] = await Promise.all(
    [k.currency0, k.currency1].map((c) =>
      client.readContract({ address: c, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] }),
    ),
  );
  const usdgIsC0 = k.currency0.toLowerCase() === USDG.toLowerCase();
  const usdgIn = Number((usdgIsC0 ? bal0Raw : bal1Raw) - (usdgIsC0 ? after0 : after1)) / 1e6;
  const tokenIn = Number((usdgIsC0 ? bal1Raw : bal0Raw) - (usdgIsC0 ? after1 : after0)) / 1e18;

  const record: LpPositionRecord = {
    tokenId,
    symbol,
    tickLower,
    tickUpper,
    liquidity: liquidity.toString(),
    usdgIn,
    tokenIn,
    mintedAt: Date.now(),
    txHash: hash,
    fee: k.fee,
    tickSpacing: k.tickSpacing,
    hasCostBasis: true,
  };
  appendLedger("lp-positions.jsonl", record);
  recordExecution({ ts: Date.now(), kind: "lp-mint", fromSymbol: "USDG", toSymbol: symbol, amountUsd: usdgIn * 2, success: true, txHash: hash });
  return record;
}

/**
 * Positions minted but not yet closed, per the FILE registry (closure rows share
 * the same file). This is the operator-side record and can desync from chain —
 * it only knows what THIS backend minted. The management path (lpGuard) and the
 * allocator still read it; migrating those to `discoverOwnedPositions` (chain
 * truth) is the remaining half of the desync fix, deferred because it drives
 * autonomous withdrawals and deserves its own careful change. Valuation already
 * uses chain discovery via `lpPositionsWithValue`.
 */
export function openPositions(): LpPositionRecord[] {
  if (!existsSync(POSITIONS_PATH)) return [];
  const minted = new Map<string, LpPositionRecord>();
  const closed = new Set<string>();
  for (const line of readFileSync(POSITIONS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.closedAt) closed.add(String(r.tokenId));
      else if (r.tokenId) minted.set(String(r.tokenId), r as LpPositionRecord);
    } catch {}
  }
  return [...minted.values()].filter((p) => !closed.has(String(p.tokenId)));
}

export interface LpPositionValue extends LpPositionRecord {
  inRange: boolean;
  usdgAmount: number;
  tokenAmount: number;
  tokenPriceUsd: number;
  valueUsd: number;
  rangePct: number;
}

// --- On-chain position discovery -------------------------------------------
// Positions are discovered from CHAIN, not the file registry. The registry only
// knows positions minted through THIS backend, so a position minted from another
// machine (or a file that failed to sync) was invisible: that is how
// balanceOf(PositionManager)=9 coexisted with a registry that knew 1, and how a
// stale registry row valued the wallet at $157 while it held $0.82.
//
// The v4 PositionManager is not ERC721Enumerable, but Transfer(from,to,tokenId)
// has all three fields indexed, so filtering by the wallet returns its tokenIds
// in one cheap call even over full history (verified: 9 ids in ~170ms). A burn
// is Transfer(owner -> 0x0), so `from == wallet`, which the sent set removes;
// received-minus-sent is therefore exactly what the wallet still holds.
const SYMBOL_BY_TOKEN: Record<string, string> = Object.fromEntries(
  Object.entries(INDEX_CONTRACTS.tokens).map(([s, a]) => [String(a).toLowerCase(), s]),
);
const xferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const poolAndInfoAbi = [
  parseAbiItem(
    "function getPoolAndPositionInfo(uint256) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  ),
];
const liqByIdAbi = [parseAbiItem("function getPositionLiquidity(uint256) view returns (uint128)")];
// v4 PositionInfo packs (right-aligned): 8 bits subscriber | 24 tickLower | 24 tickUpper | 200 poolId.
const signed24 = (v: bigint) => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x; };

interface ChainPosition {
  tokenId: string;
  symbol: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
}

/**
 * The LP position NFTs a wallet currently owns, read entirely from chain: token
 * ids from Transfer logs, then each position's pool, range and live liquidity
 * from the PositionManager. Throws (does not return []) on an RPC failure, so a
 * failed read is never mistaken for "no positions" — the caller decides whether
 * to degrade or retry.
 */
export async function discoverOwnedPositions(wallet: Address): Promise<ChainPosition[]> {
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  const [received, sent] = await Promise.all([
    client.getLogs({ address: POSITION_MANAGER, event: xferEvent, args: { to: wallet }, fromBlock: 0n, toBlock: head }),
    client.getLogs({ address: POSITION_MANAGER, event: xferEvent, args: { from: wallet }, fromBlock: 0n, toBlock: head }),
  ]);
  const owned = new Map<string, bigint>();
  for (const l of received) owned.set((l.args as { tokenId: bigint }).tokenId.toString(), (l.args as { tokenId: bigint }).tokenId);
  for (const l of sent) owned.delete((l.args as { tokenId: bigint }).tokenId.toString());
  if (owned.size === 0) return [];

  return Promise.all(
    [...owned.values()].map(async (tokenId): Promise<ChainPosition> => {
      const [liq, poolAndInfo] = await Promise.all([
        client.readContract({ address: POSITION_MANAGER, abi: liqByIdAbi, functionName: "getPositionLiquidity", args: [tokenId] }),
        client.readContract({ address: POSITION_MANAGER, abi: poolAndInfoAbi, functionName: "getPoolAndPositionInfo", args: [tokenId] }),
      ]);
      const [poolKey, info] = poolAndInfo;
      const stock = [poolKey.currency0, poolKey.currency1].find((c) => c.toLowerCase() !== USDG.toLowerCase()) ?? poolKey.currency1;
      return {
        tokenId: tokenId.toString(),
        symbol: SYMBOL_BY_TOKEN[stock.toLowerCase()] ?? stock,
        tickLower: signed24(info >> 8n),
        tickUpper: signed24(info >> 32n),
        liquidity: liq as bigint,
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: Number(poolKey.fee),
        tickSpacing: Number(poolKey.tickSpacing),
      };
    }),
  );
}

/**
 * The wallet's live LP positions, marked to current pool state: what each range
 * holds right now and its USD value (excl. uncollected fees). Chain-sourced —
 * only what the wallet actually owns and only positions that still hold
 * liquidity. The file registry contributes cost-basis metadata (usdgIn,
 * mintedAt, txHash) by tokenId when present, but never decides what exists.
 */
export async function lpPositionsWithValue(): Promise<LpPositionValue[]> {
  const wallet = getAgentAddress();
  if (!wallet) return [];
  const positions = await discoverOwnedPositions(wallet);
  const meta = new Map(openPositions().map((p) => [String(p.tokenId), p]));

  const out: LpPositionValue[] = [];
  for (const p of positions) {
    if (p.liquidity === 0n) continue; // emptied position: it is owned but holds nothing
    const poolId = keccak256(
      encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [p.currency0, p.currency1, p.fee, p.tickSpacing, NATIVE]),
    );
    const [sqrtRaw, tickRaw] = await getPublicClient().readContract({
      address: STATE_VIEW,
      abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
      functionName: "getSlot0",
      args: [poolId],
    });
    const sqrtP = Number(sqrtRaw);
    const tick = Number(tickRaw);
    const L = Number(p.liquidity);
    const sA = sqrtAtTick(p.tickLower);
    const sB = sqrtAtTick(p.tickUpper);
    const sC = Math.min(Math.max(sqrtP, sA), sB);
    const amount0 = L * Q96 * (1 / sC - 1 / sB);
    const amount1 = (L * (sC - sA)) / Q96;
    const usdgIs0 = p.currency0.toLowerCase() === USDG.toLowerCase();
    const usdgAmount = (usdgIs0 ? amount0 : amount1) / 1e6;
    const tokenAmount = (usdgIs0 ? amount1 : amount0) / 1e18;
    const praw = (sqrtP / Q96) ** 2; // currency1 raw per currency0 raw
    const tokenPriceUsd = (usdgIs0 ? 1 / praw : praw) * 1e12;
    const m = meta.get(p.tokenId);
    out.push({
      tokenId: p.tokenId,
      symbol: p.symbol,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity.toString(),
      usdgIn: m?.usdgIn ?? 0,
      tokenIn: m?.tokenIn ?? 0,
      mintedAt: m?.mintedAt ?? 0,
      txHash: m?.txHash ?? "",
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hasCostBasis: !!m && m.mintedAt > 0,
      inRange: tick >= p.tickLower && tick < p.tickUpper,
      usdgAmount,
      tokenAmount,
      tokenPriceUsd,
      valueUsd: usdgAmount + tokenAmount * tokenPriceUsd,
      rangePct: (1.0001 ** ((p.tickUpper - p.tickLower) / 2) - 1) * 100,
    });
  }
  return out;
}

/**
 * Open positions from CHAIN, in the LpPositionRecord shape the management and
 * reporting paths expect. This is the chain-truth replacement for
 * openPositions(): existence, range, and liquidity come from what the wallet
 * actually owns and still holds liquidity in; the file contributes only
 * cost-basis metadata (usdgIn, tokenIn, mintedAt, txHash) by tokenId. Async,
 * because chain reads are; every caller is already in an async context.
 *
 * Throws on an RPC failure (via discoverOwnedPositions) rather than returning [],
 * so lpGuard never mistakes a failed read for "flat" and triggers a spurious
 * recovery — a failed read leaves the tick to no-op, not to act on bad data.
 */
export async function openPositionsOnChain(): Promise<LpPositionRecord[]> {
  const wallet = getAgentAddress();
  if (!wallet) return [];
  const positions = await discoverOwnedPositions(wallet);
  const meta = new Map(openPositions().map((p) => [String(p.tokenId), p]));
  return positions
    .filter((p) => p.liquidity > 0n)
    .map((p) => {
      const m = meta.get(p.tokenId);
      return {
        tokenId: p.tokenId,
        symbol: p.symbol,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity.toString(),
        usdgIn: m?.usdgIn ?? 0,
        tokenIn: m?.tokenIn ?? 0,
        mintedAt: m?.mintedAt ?? 0,
        txHash: m?.txHash ?? "",
        // Pool identity always comes from CHAIN, never from the registry row —
        // the position itself is the authority on which pool it is in.
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hasCostBasis: !!m && m.mintedAt > 0,
      };
    });
}

/**
 * Realize accrued fees WITHOUT closing the position: a zero-liquidity decrease
 * sweeps the owed fees, TAKE_PAIR sends them to the wallet, and the position's
 * liquidity and range are untouched (it keeps earning). Measured as the real
 * balance delta across both currencies.
 */
/** USD value of fees owed but not yet collected on a position — drives auto-collect. */
export async function uncollectedFeesUsd(p: LpPositionRecord): Promise<number> {
  const k = poolKeyOf(p.symbol);
  const client = getPublicClient();
  // Use the position's OWN pool identity when it carries one (chain-read). The
  // symbol lookup resolves to the baseline/qualified config, which is the wrong
  // pool for a position minted in a different fee tier of the same ticker — and
  // a wrong poolId reads another pool's fee growth without erroring.
  const fee = p.fee ?? k.fee;
  const tickSpacing = p.tickSpacing ?? k.tickSpacing;
  const poolId = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [k.currency0, k.currency1, fee, tickSpacing, NATIVE]),
  );
  const salt = `0x${BigInt(p.tokenId).toString(16).padStart(64, "0")}` as Hex;
  const posKey = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [POSITION_MANAGER, p.tickLower, p.tickUpper, salt]));
  const [liq, last0, last1] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getPositionInfo(bytes32,bytes32) view returns (uint128,uint256,uint256)")],
    functionName: "getPositionInfo",
    args: [poolId, posKey],
  });
  const [now0, now1] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)")],
    functionName: "getFeeGrowthInside",
    args: [poolId, p.tickLower, p.tickUpper],
  });
  const [sqrtP] = await client.readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [poolId],
  });
  const L = Number(liq);
  // feeGrowthInside is a deliberately-wrapping uint256 (the pool subtracts it
  // unchecked), so `now < last` means it wrapped, not that fees went negative.
  // Plain BigInt subtraction would report a large negative fee owed — which
  // would silently suppress auto-collect on a position that IS owed money.
  const U256 = 1n << 256n;
  const delta = (now: bigint, last: bigint) => (now - last + U256) % U256;
  const fee0 = (Number(delta(BigInt(now0), BigInt(last0))) * L) / 2 ** 128;
  const fee1 = (Number(delta(BigInt(now1), BigInt(last1))) * L) / 2 ** 128;
  const usdgIs0 = k.currency0.toLowerCase() === USDG.toLowerCase();
  const tokenUsd = ((usdgIs0 ? 1 / ((Number(sqrtP) / Q96) ** 2) : (Number(sqrtP) / Q96) ** 2)) * 1e12;
  return (usdgIs0 ? fee0 : fee1) / 1e6 + ((usdgIs0 ? fee1 : fee0) / 1e18) * tokenUsd;
}

export async function collectFees(params: { tokenId: string; symbol: string }): Promise<{ txHash: Hex; usdgCollected: number; tokenCollected: number }> {
  const k = poolKeyOf(params.symbol);
  const signer = getAgentSigner()!;
  const client = getPublicClient();
  const bal = (t: Address) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [signer.address] });
  const [usdgBefore, tokenBefore] = await Promise.all([bal(USDG), bal(k.token)]);

  const decreaseParams = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
    [BigInt(params.tokenId), 0n, 0n, 0n, "0x"], // 0 liquidity removed → only fees move
  );
  const takeParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [k.currency0, k.currency1, signer.address]);
  const actions = encodePacked(["bytes1", "bytes1"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [decreaseParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`collect reverted: ${hash}`);

  const [usdgAfter, tokenAfter] = await Promise.all([bal(USDG), bal(k.token)]);
  const usdgCollected = Number(usdgAfter - usdgBefore) / 1e6;
  const tokenCollected = Number(tokenAfter - tokenBefore) / 1e18;
  recordExecution({ ts: Date.now(), kind: "lp-collect", fromSymbol: params.symbol, toSymbol: "USDG", amountUsd: usdgCollected, success: true, txHash: hash });
  return { txHash: hash, usdgCollected, tokenCollected };
}

/**
 * The pool we were most recently in, read from CHAIN. withdrawPosition removes
 * liquidity but does not burn the NFT, so an emptied position is still owned and
 * still carries its pool identity — and tokenId increases monotonically per mint
 * on the PositionManager, so the highest one the wallet holds is the latest.
 *
 * This is the chain-truth replacement for lastMintedPosition() in the recovery
 * path. The file registry only knows what THIS backend minted, so after the
 * migration to chain discovery it could name a pool we are no longer in (or miss
 * one entirely) — and recovery spends real money on that answer.
 *
 * Returns null when it cannot be determined, so the caller can fall back rather
 * than guess.
 */
export async function lastPoolOnChain(): Promise<string | null> {
  const wallet = getAgentAddress();
  if (!wallet) return null;
  try {
    const positions = await discoverOwnedPositions(wallet);
    if (positions.length === 0) return null;
    const latest = positions.reduce((a, b) => (BigInt(a.tokenId) > BigInt(b.tokenId) ? a : b));
    // A raw address here means the token wasn't in the known universe — not a
    // symbol we can act on.
    return latest.symbol.startsWith("0x") ? null : latest.symbol;
  } catch {
    return null;
  }
}

/** The most recent minted position (open or closed) — tells auto-recovery which pool we were last in and roughly how much was deployed. */
export function lastMintedPosition(): { symbol: string; depositUsd: number } | null {
  if (!existsSync(POSITIONS_PATH)) return null;
  let last: LpPositionRecord | null = null;
  for (const line of readFileSync(POSITIONS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.symbol && r.usdgIn != null) last = r as LpPositionRecord; // a mint row (closure rows have no symbol/usdgIn)
    } catch {}
  }
  return last ? { symbol: last.symbol, depositUsd: last.usdgIn * 2 } : null; // balanced mint ≈ 2× the USDG side
}

/** Pull a position: remove all (or part of) its liquidity and take both currencies back to the wallet. */
export async function withdrawPosition(params: { tokenId: string; symbol: string; liquidity: string }): Promise<{ txHash: Hex }> {
  const k = poolKeyOf(params.symbol);
  const signer = getAgentSigner()!;
  const decreaseParams = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
    [BigInt(params.tokenId), BigInt(params.liquidity), 0n, 0n, "0x"],
  );
  const takeParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [k.currency0, k.currency1, signer.address]);
  const actions = encodePacked(["bytes1", "bytes1"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [decreaseParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    to: POSITION_MANAGER,
    data: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [unlockData, deadline] }),
  });
  const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`withdraw reverted: ${hash}`);
  appendLedger("lp-positions.jsonl", { tokenId: params.tokenId, closedAt: Date.now(), txHash: hash });
  recordExecution({ ts: Date.now(), kind: "lp-exit", fromSymbol: params.symbol, toSymbol: "USDG", amountUsd: 0, success: true, txHash: hash });
  return { txHash: hash };
}
