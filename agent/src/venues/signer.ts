import { createPublicClient, createWalletClient, http, fallback, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/** Robinhood Chain — an Arbitrum L2 (chain id 4663), not in viem's built-in list. */
export const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.robinhoodRpcUrl || "https://rpc.mainnet.chain.robinhood.com"] } },
  // Multicall3 at the canonical address (verified deployed on this chain).
  // Declaring it lets viem's batch.multicall collapse dozens of concurrent
  // reads into a single eth_call. Without it every readContract was a separate
  // call, and under prod's polling load the public RPC 429s the oversized batch
  // with a NON-array error body that viem surfaces as the cryptic
  // "Cannot read properties of undefined (reading 'error')".
  contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" as const } },
} as const;

/**
 * The agent's own signing wallet — reads a private key from
 * AGENT_SIGNER_PRIVATE_KEY, never accepted as a request parameter. This is
 * what lets the background loop execute enter_index/exit_index decisions
 * with no human supplying a payer wallet per trade (see agentLoop.ts). Absent
 * this env var, autonomous execution can't run — IndexTrader falls back to
 * its stub (logs intent, doesn't touch the chain), same as with no RPC set.
 *
 * EXACTLY ONE RUNNING PROCESS MAY HOLD THIS KEY.
 *
 * Setting it does more than enable trading: startLpGuard() runs unconditionally
 * (it is NOT gated by AGENT_LIVE_TRADING, because position protection must work
 * even with signal trading off), so every process that can read this key becomes
 * an independent LP guard over the same wallet. withHouseWalletLock serialises
 * house-wallet ops WITHIN a process; it is a module-level lock and cannot
 * coordinate across processes or hosts. Two guards therefore each see the same
 * position and can each decide to re-center, withdraw, or collect it — a real
 * double-spend on live capital, and one that stays invisible while the wallet is
 * empty because there is nothing for either to act on.
 *
 * So: set it on the ONE host that should manage the book, and nowhere else. A
 * second box that only needs to read (portfolio, console, valuations) sets
 * MERIDIAN_WALLET_ADDRESS instead — see getAgentAddress below.
 */
let cached: { account: ReturnType<typeof privateKeyToAccount>; address: Address } | null = null;

export function getAgentSigner() {
  const key = process.env.AGENT_SIGNER_PRIVATE_KEY;
  if (!key) return null;
  if (!cached) {
    const account = privateKeyToAccount(key as `0x${string}`);
    cached = { account, address: account.address };
  }
  return cached;
}

/**
 * The wallet address for READ paths (portfolio, console, valuations).
 * A read-only deployment carries no private key — it sets
 * MERIDIAN_WALLET_ADDRESS instead, so every balance/position read works while
 * nothing on the box can sign, and it never becomes a competing LP guard.
 *
 * This is the setting for any instance that is NOT the one managing the book.
 * (It is not currently the cloud: as deployed, Railway holds the signer key and
 * is the guard. Whichever host is the guard, the others should use this.)
 */
export function getAgentAddress(): `0x${string}` | null {
  const signer = getAgentSigner();
  if (signer) return signer.address;
  const addr = process.env.MERIDIAN_WALLET_ADDRESS;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

// One shared client, with two layers of request coalescing so the several
// pollers (marketData, basis, lpGuard, allocator, snapshotter) don't each fire
// separate RPC calls for overlapping reads:
//   - multicall: concurrent eth_calls (getSlot0/getLiquidity/balanceOf) merge
//     into a single multicall contract call
//   - http batch: multiple JSON-RPC requests in a ~100ms window ship as one
//     HTTP POST
// This is transparent to callers and is the main lever against rate-limits.
let publicClient: ReturnType<typeof createPublicClient> | null = null;
export function getPublicClient() {
  if (!publicClient) {
    // READS: a fallback over the configured endpoints, primary (dedicated
    // provider) first, public endpoint last. viem's fallback() fails over to the
    // next transport on error/timeout, so a provider throttle doesn't surface as
    // a read failure. Each leg keeps its own batching + 429 retry.
    const legs = (config.robinhoodReadRpcUrls.length ? config.robinhoodReadRpcUrls : ["https://rpc.mainnet.chain.robinhood.com"]).map(
      (url) => http(url, { batch: { wait: 100, batchSize: 10 }, retryCount: 4, retryDelay: 250 }),
    );
    publicClient = createPublicClient({
      chain: robinhoodChain,
      transport: legs.length > 1 ? fallback(legs) : legs[0],
      batch: { multicall: { wait: 50 } },
    });
  }
  return publicClient;
}

export function getWalletClient() {
  const signer = getAgentSigner();
  if (!signer) throw new Error("AGENT_SIGNER_PRIVATE_KEY not configured");
  // WRITES go straight to the sequencer (robinhoodWriteRpcUrl) for the fewest
  // hops to inclusion — not through a read provider that would relay to it.
  return createWalletClient({ account: signer.account, chain: robinhoodChain, transport: http(config.robinhoodWriteRpcUrl) });
}
