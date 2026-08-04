// Taker exit: sell a meme token for native ETH through the UniversalRouter's
// V4_SWAP command. This is the desk's LAST RESORT and its guarantee: the maker
// exit (a sell band adjacent to spot) earns the fee and is always tried first,
// but when a token keeps falling and the band never fills, this path pays the
// pool fee once and gets the desk flat. Bounded loss beats open-ended
// inventory, which is the operator's standing order: never stay stuck holding
// tokens.
//
// Router identity: two verified UniversalRouters exist on this chain; this is
// the one with 5M transactions (the app's own route), constructor-wired to
// the same PoolManager, Permit2 and PositionManager the desk already uses.
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  parseAbiParameters,
  parseAbiItem,
  maxUint160,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { ETH_POOLS, PERMIT2, type EthPool, ethPoolSlot0 } from "./ethPools.js";
import { getPublicClient, getWalletClient, getAgentSigner } from "./signer.js";

export const UNIVERSAL_ROUTER: Address = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;

// UniversalRouter command + v4-router action ids.
const V4_SWAP = "0x10";
const SWAP_EXACT_IN_SINGLE = "0x06";
const SETTLE_ALL = "0x0c";
const TAKE_ALL = "0x0f";

/**
 * Build the UR calldata selling `tokenWei` of the pool's token for native ETH.
 * zeroForOne=false: currency1 (token) in, currency0 (ETH) out. The token side
 * settles by Permit2 pull, so Permit2 must have a UR allowance (see
 * ensureRouterApprovals).
 */
export function buildTokenSell(p: EthPool, tokenWei: bigint, minEthWei: bigint) {
  const swapParams = encodeAbiParameters(
    parseAbiParameters("((address,address,uint24,int24,address), bool, uint128, uint128, bytes)"),
    [[[NATIVE, p.token, p.fee, p.tickSpacing, NATIVE], false, tokenWei, minEthWei, "0x"]],
  );
  const settleParams = encodeAbiParameters(parseAbiParameters("address, uint256"), [p.token, tokenWei]);
  const takeParams = encodeAbiParameters(parseAbiParameters("address, uint256"), [NATIVE, minEthWei]);
  const actions = encodePacked(["bytes1", "bytes1", "bytes1"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [swapParams, settleParams, takeParams]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const data = encodeFunctionData({
    abi: [parseAbiItem("function execute(bytes commands, bytes[] inputs, uint256 deadline) payable")],
    functionName: "execute",
    args: [V4_SWAP as Hex, [input], deadline],
  });
  return { to: UNIVERSAL_ROUTER, data };
}

/** Permit2 must allow the ROUTER (a different spender than the
 *  PositionManager the mint path uses). Idempotent, sends only when missing. */
export async function ensureRouterApprovals(p: EthPool, amountWei: bigint): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner();
  if (!signer) throw new Error("no signer");
  const erc20 = await client.readContract({
    address: p.token,
    abi: [parseAbiItem("function allowance(address, address) view returns (uint256)")],
    functionName: "allowance",
    args: [signer.address, PERMIT2],
  });
  if (erc20 < amountWei) {
    const data = encodeFunctionData({
      abi: [parseAbiItem("function approve(address, uint256) returns (bool)")],
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    const h = await wallet.sendTransaction({ to: p.token, data });
    await client.waitForTransactionReceipt({ hash: h });
  }
  const [p2] = await client.readContract({
    address: PERMIT2,
    abi: [parseAbiItem("function allowance(address, address, address) view returns (uint160, uint48, uint48)")],
    functionName: "allowance",
    args: [signer.address, p.token, UNIVERSAL_ROUTER],
  });
  if (p2 < amountWei) {
    const data = encodeFunctionData({
      abi: [parseAbiItem("function approve(address, address, uint160, uint48)")],
      functionName: "approve",
      args: [p.token, UNIVERSAL_ROUTER, maxUint160, 2 ** 48 - 1],
    });
    const h = await wallet.sendTransaction({ to: PERMIT2, data });
    await client.waitForTransactionReceipt({ hash: h });
  }
}

/**
 * Sell `tokenWei` at market with a slippage floor derived from the pool's own
 * current price. Simulates before sending; returns the realized ETH. The
 * caller decides WHETHER selling is right; this only makes it safe.
 */
export async function sellTokenForEth(
  p: EthPool,
  tokenWei: bigint,
  slippagePct = 1.5,
): Promise<{ hash: Hex; ethOut: bigint; minOut: bigint }> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner();
  if (!signer) throw new Error("no signer");
  const { sqrtP } = await ethPoolSlot0(p);
  if (sqrtP === 0) throw new Error("pool uninitialized");
  const pxEth = 1 / (sqrtP / Q96) ** 2; // ETH per token, both 18-dec
  const feeFrac = p.fee / 1e6;
  const gross = Number(tokenWei) * pxEth;
  const minOut = BigInt(Math.floor(gross * (1 - feeFrac) * (1 - slippagePct / 100)));
  if (minOut <= 0n) throw new Error("sell too small to price");

  await ensureRouterApprovals(p, tokenWei);
  const tx = buildTokenSell(p, tokenWei, minOut);
  const before = await client.getBalance({ address: signer.address });
  await client.call({ account: signer.address, to: tx.to, data: tx.data });
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`sell reverted ${hash}`);
  const ethOut = (await client.getBalance({ address: signer.address })) - before;
  return { hash, ethOut: ethOut > 0n ? ethOut : 0n, minOut };
}

/** Prove the encoding against the live chain without spending. */
export async function simulateTokenSell(symbol: string, tokenAmount: number): Promise<{ ok: boolean; detail: string }> {
  const p = ETH_POOLS[symbol];
  if (!p) return { ok: false, detail: `no pool for ${symbol}` };
  const signer = getAgentSigner();
  if (!signer) return { ok: false, detail: "no signer" };
  const client = getPublicClient();
  const { sqrtP } = await ethPoolSlot0(p);
  const pxEth = 1 / (sqrtP / Q96) ** 2;
  const tokenWei = BigInt(Math.round(tokenAmount * 1e18));
  const minOut = BigInt(Math.floor(Number(tokenWei) * pxEth * (1 - p.fee / 1e6) * 0.985));
  const tx = buildTokenSell(p, tokenWei, minOut);
  try {
    await client.call({ account: signer.address, to: tx.to, data: tx.data });
    return { ok: true, detail: `sell encoding valid, minOut ${minOut} wei` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}
