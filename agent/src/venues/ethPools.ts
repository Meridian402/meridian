// ETH-quoted v4 pools: the memecoin family, where the quote side is native ETH
// rather than USDG. Separate module from lpPositions on purpose: those pools
// are equities with market hours and a stablecoin quote; these trade 24/7 in
// tokens that can move 50% in a week, and blurring the two families is how a
// stock-tuned guard ends up managing a memecoin position with equity
// assumptions.
//
// EXPERIMENTAL, deliberately unwired: nothing in the guard or the allocator
// imports this yet. The deployment gate is measurement, not code: a pool
// becomes a candidate only after lpScore-style markout clears it (the same
// fees-minus-toxicity bar that flagged NVDA as a $944/day LP loser), and the
// first real mint is a hand-run act sized in tens of dollars.
//
// What native-quote changes vs the USDG path, all four handled here:
//   1. pairing: currency0 is ALWAYS native (0x0 sorts below every token)
//   2. the ETH side has no balanceOf; it is the wallet's native balance
//   3. modifyLiquidities must carry msg.value for the ETH side
//   4. excess msg.value must be SWEPT back, or it strands in the PM
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiParameters,
  parseAbiItem,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { getPublicClient, getAgentSigner } from "./signer.js";

const POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;

// v4-periphery action ids. MINT/SETTLE_PAIR verified live by every equity
// mint; SWEEP is from the same Actions enum and the simulation below is the
// proof it is right before any real transaction uses it.
const MINT_POSITION = "0x02";
const SETTLE_PAIR = "0x0d";
const SWEEP = "0x14";

export interface EthPool {
  symbol: string;
  token: Address;
  fee: number;
  tickSpacing: number;
  /** The census-measured pool id; poolId() must reproduce it exactly. */
  expectedId: Hex;
  /** Spacings between spot and a fresh ETH band's lower bound. Coarse-spacing
   *  pools use 1 (STONK's 2%-per-spacing at the default 2 idled 11% off spot);
   *  fine-spacing pools keep 2 for drift headroom. */
  offsetAbove: number;
  /** Band width in spacings. Width is fee density's denominator: the same
   *  capital across 16% of price earns half of what it earns across 8%, so
   *  coarse-spacing pools take fewer spacings. Absent means 8. */
  widthSpacings?: number;
}

/**
 * Vetted ETH-quoted pools, keys taken from the 2026-08-03 chain census and
 * pinned here with their measured pool ids so a typo in any parameter fails
 * the id check instead of silently pointing at an empty pool.
 */
export const ETH_POOLS: Record<string, EthPool> = {
  CASHCAT: {
    symbol: "CASHCAT",
    token: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    fee: 2900,
    tickSpacing: 29,
    expectedId: "0x1252fbfc4f6530a025ca351494245797b2a147b7b5d2dc8af7893e4e1a2e9df3",
    offsetAbove: 2,
  },
  STONKBROKER: {
    symbol: "STONKBROKER",
    token: "0xe934e36A439C94017B64a3FecE66AF12099aBF50",
    fee: 10000,
    tickSpacing: 200,
    expectedId: "0xd33c8fd38b06e989cdbd4dffdefab71c4bdd415b24964c8d69e38ff35b068f92",
    offsetAbove: 1,
    widthSpacings: 4,
  },
  // Pinned 2026-08-04 from the analyst's vetted sweep. UNIFROG was pinned in
  // the same batch and UNPINNED 2026-08-05 after three stop-loss cycles in one
  // day: its one great 24h snapshot was a pump top, and pinned venues bypass
  // the entry gates that would have refused it afterward. If it re-earns its
  // way through the analyst's two-sweep gate as a candidate, so be it; it gets
  // no standing invitation. BOURSE keeps 90% of gross after toxicity.
  BOURSE: {
    symbol: "BOURSE",
    token: "0x60Edd303679c3923b628c8F02cE0bE69e96deb1d",
    fee: 20000,
    tickSpacing: 200,
    expectedId: "0x7eba77f0403bd49df11633280d276e008f561b797a9acede173ae6e90f0086aa",
    offsetAbove: 1,
    widthSpacings: 4,
  },
};

/** currency0 is native by construction: 0x0 sorts below every real token. */
export function poolId(p: EthPool): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [NATIVE, p.token, p.fee, p.tickSpacing, NATIVE]),
  );
}

/** Throws if any registry entry's derived id disagrees with the census id. */
export function assertRegistryIds(): void {
  for (const p of Object.values(ETH_POOLS)) {
    const got = poolId(p);
    if (got.toLowerCase() !== p.expectedId.toLowerCase()) {
      throw new Error(`${p.symbol}: derived pool id ${got} != census id ${p.expectedId}; a pool parameter is wrong`);
    }
  }
}

export async function ethPoolSlot0(p: EthPool): Promise<{ sqrtP: number; tick: number }> {
  const [sqrtP, tick] = await getPublicClient().readContract({
    address: STATE_VIEW,
    abi: [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")],
    functionName: "getSlot0",
    args: [poolId(p)],
  });
  return { sqrtP: Number(sqrtP), tick: Number(tick) };
}

const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick) * Q96;

/**
 * Build the calldata + msg.value for a SINGLE-SIDED native mint: a range
 * entirely above the current tick, so the position holds only currency0 (ETH)
 * and needs zero of the token. This is the encoding proof for the native path
 * (payable settle + sweep); the production two-sided mint reuses exactly this
 * action string with a real token balance.
 */
export function buildNativeOnlyMint(p: EthPool, currentTick: number, ethWei: bigint, recipient: Address, spacingsAbove = 2) {
  const ts = p.tickSpacing;
  // Entirely above spot: default two spacings up so a small drift cannot drag
  // the range into two-sided territory mid-flight. Coarse-spacing pools
  // (STONKBROKER ts=200 means 2% per spacing) pass 1: at +2 the band starts 4%
  // above spot and measured flow rarely reaches it.
  const tickLower = (Math.floor(currentTick / ts) + Math.max(1, spacingsAbove)) * ts;
  const tickUpper = tickLower + (p.widthSpacings ?? 8) * ts;
  const sA = sqrtAtTick(tickLower) / Q96;
  const sB = sqrtAtTick(tickUpper) / Q96;
  // All-currency0 range: L = amt0 * (sA*sB)/(sB-sA), with a 1% haircut so the
  // execution-time pull can never exceed msg.value.
  const liquidity = BigInt(Math.floor(((Number(ethWei) * (sA * sB)) / (sB - sA)) * 0.99));
  if (liquidity <= 0n) throw new Error("ethWei too small for any liquidity in this range");

  const mintParams = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
    [[NATIVE, p.token, p.fee, p.tickSpacing, NATIVE], tickLower, tickUpper, liquidity, ethWei, 0n, recipient, "0x"],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [NATIVE, p.token]);
  // Sweep any unspent native back to the recipient; without this the headroom
  // between msg.value and the execution-time pull strands in the PM.
  const sweepParams = encodeAbiParameters(parseAbiParameters("address, address"), [NATIVE, recipient]);
  const actions = encodePacked(["bytes1", "bytes1", "bytes1"], [MINT_POSITION, SETTLE_PAIR, SWEEP]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [mintParams, settleParams, sweepParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")],
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });
  return { to: POSITION_MANAGER, data, value: ethWei, tickLower, tickUpper, liquidity };
}

/**
 * Prove the native mint encoding against the real chain WITHOUT spending:
 * eth_call from the signer with msg.value. A clean return means pairing,
 * payable settle and sweep are all right; a revert names what is not.
 */
export async function simulateNativeMint(symbol: string, ethAmount: number): Promise<{ ok: boolean; detail: string }> {
  assertRegistryIds();
  const p = ETH_POOLS[symbol];
  if (!p) return { ok: false, detail: `no ETH pool registered for ${symbol}` };
  const signer = getAgentSigner();
  if (!signer) return { ok: false, detail: "no signer key in this environment" };
  const { tick, sqrtP } = await ethPoolSlot0(p);
  if (sqrtP === 0) return { ok: false, detail: "pool uninitialized" };
  const tx = buildNativeOnlyMint(p, tick, BigInt(Math.round(ethAmount * 1e18)), signer.address);
  try {
    await getPublicClient().call({ account: signer.address, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true, detail: `mint encoding valid: ticks [${tx.tickLower}, ${tx.tickUpper}], L=${tx.liquidity}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/** Canonical Permit2, verified deployed on Robinhood Chain. The token side of
 *  a mint settles by Permit2 pull, so both approvals (token to Permit2, then
 *  Permit2 to the PositionManager) must exist before a token mint simulates. */
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * Build a SINGLE-SIDED token mint: a range entirely below the current tick, so
 * the position holds only currency1 (the token) and zero ETH. This is the
 * sell side of the book: as the token's price climbs (tick falls) through the
 * range, inventory converts to ETH while EARNING the pool fee, instead of
 * paying that same fee to exit by swapping. If price never climbs, we simply
 * still hold the tokens, inside the position instead of the wallet.
 */
export function buildTokenOnlyMint(p: EthPool, currentTick: number, tokenWei: bigint, recipient: Address, spacingsBelow = 1) {
  const ts = p.tickSpacing;
  // Entirely below spot, with at least one spacing of headroom so a small
  // drift cannot drag the range two-sided mid-flight.
  const tickUpper = (Math.floor(currentTick / ts) - Math.max(1, spacingsBelow)) * ts;
  const tickLower = tickUpper - (p.widthSpacings ?? 8) * ts;
  const sA = sqrtAtTick(tickLower) / Q96;
  const sB = sqrtAtTick(tickUpper) / Q96;
  // All-currency1 range: amt1 = L * (sB - sA), with a small haircut so the
  // execution-time pull can never exceed the approval.
  const liquidity = BigInt(Math.floor((Number(tokenWei) / (sB - sA)) * 0.999));
  if (liquidity <= 0n) throw new Error("tokenWei too small for any liquidity in this range");

  const mintParams = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"),
    [[NATIVE, p.token, p.fee, p.tickSpacing, NATIVE], tickLower, tickUpper, liquidity, 0n, tokenWei, recipient, "0x"],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, address"), [NATIVE, p.token]);
  // No SWEEP: the ERC20 settle pulls exactly what is owed, nothing strands.
  const actions = encodePacked(["bytes1", "bytes1"], [MINT_POSITION, SETTLE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [mintParams, settleParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")],
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });
  return { to: POSITION_MANAGER, data, tickLower, tickUpper, liquidity };
}

// v4-periphery action ids for the unwind, mirrored from the equity path where
// both are proven live (withdrawPosition in lpPositions.ts).
const DECREASE_LIQUIDITY = "0x01";
const TAKE_PAIR = "0x11";

/**
 * Build the calldata for a full unwind of a native-quoted position: burn all
 * liquidity, take BOTH sides (ETH + token, principal plus every accrued fee)
 * to the recipient. Native take pays out chain ETH; no value, no sweep.
 */
export function buildNativeWithdraw(p: EthPool, tokenId: bigint, liquidity: bigint, recipient: Address) {
  const decreaseParams = encodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
    [tokenId, liquidity, 0n, 0n, "0x"],
  );
  const takeParams = encodeAbiParameters(parseAbiParameters("address, address, address"), [NATIVE, p.token, recipient]);
  const actions = encodePacked(["bytes1", "bytes1"], [DECREASE_LIQUIDITY, TAKE_PAIR]);
  const unlockData = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [decreaseParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const data = encodeFunctionData({
    abi: [parseAbiItem("function modifyLiquidities(bytes unlockData, uint256 deadline) payable")],
    functionName: "modifyLiquidities",
    args: [unlockData, deadline],
  });
  return { to: POSITION_MANAGER, data };
}

/** Prove the unwind against the real chain without spending: eth_call from the signer. */
export async function simulateNativeWithdraw(symbol: string, tokenId: bigint, liquidity: bigint): Promise<{ ok: boolean; detail: string }> {
  assertRegistryIds();
  const p = ETH_POOLS[symbol];
  if (!p) return { ok: false, detail: `no ETH pool registered for ${symbol}` };
  const signer = getAgentSigner();
  if (!signer) return { ok: false, detail: "no signer key in this environment" };
  const tx = buildNativeWithdraw(p, tokenId, liquidity, signer.address);
  try {
    await getPublicClient().call({ account: signer.address, to: tx.to, data: tx.data });
    return { ok: true, detail: "withdraw encoding valid" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}
