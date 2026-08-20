import { createPublicClient, createWalletClient, http, fallback, type Address } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import { config } from "../config.js";
import { ENGINE_SIGNER_WALLET } from "../merd/wallets.js";

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
 * Setting it does more than enable trading: with MERIDIAN_LP_ENGINE=on,
 * startLpGuard() runs (NOT gated by AGENT_LIVE_TRADING, because position
 * protection must work even with signal trading off), so every such process becomes
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

/**
 * Wallets export private keys in both shapes: with the 0x prefix and as bare
 * 64-char hex. viem only accepts the prefixed form, so a bare paste used to
 * reach privateKeyToAccount verbatim and take the process down at boot with
 * "invalid private key, expected hex or 32 bytes, got string" (2026-07-27,
 * prod crash-looped on exactly this). The operator did nothing wrong there:
 * they pasted what their wallet gave them. Normalize the two harmless
 * variations, and refuse anything else by NAME so the log says which variable
 * is wrong instead of making someone decode a viem internal.
 */
function normalizeSignerKey(raw: string): `0x${string}` {
  const k = raw.trim();
  const body = k.startsWith("0x") || k.startsWith("0X") ? k.slice(2) : k;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(
      `AGENT_SIGNER_PRIVATE_KEY is not a private key: expected 64 hex characters (with or without a 0x prefix), got ${body.length} characters. Re-export the key for the house wallet and set it again.`,
    );
  }
  return `0x${body.toLowerCase()}`;
}

export function getAgentSigner() {
  const key = process.env.AGENT_SIGNER_PRIVATE_KEY;
  if (!key) return null;
  if (!cached) {
    // nonceManager: viem tracks the nonce locally across sequential sends from
    // this process. Without it, two back-to-back transactions (a fee sweep
    // then its treasury skim) can both fetch the same pending nonce and the
    // second reverts with "nonce lower than current" (seen live 2026-08-04).
    const account = privateKeyToAccount(normalizeSignerKey(key), { nonceManager });
    cached = { account, address: account.address };
  }
  return cached;
}

/**
 * Boot assert, mirror of assertTreasuryIsLive: if this process holds a signer
 * key, it must derive to the engine signer pinned in merd/wallets.ts. Role
 * separation, the docs and the published track record all follow that pinned
 * address, so a key rotated without updating wallets.ts would sign from one
 * wallet while everything that explains the money tracks another. The signer
 * is deliberately NOT the treasury since 2026-08-01: revenue custody and
 * signing authority do not share a key. Keyless (read-only) deployments have
 * nothing to assert.
 */
export function assertSignerIsHouseWallet(): void {
  const signer = getAgentSigner();
  if (!signer) return;
  if (signer.address.toLowerCase() !== ENGINE_SIGNER_WALLET.toLowerCase()) {
    throw new Error(
      `AGENT_SIGNER_PRIVATE_KEY derives to ${signer.address}, but the engine signer pinned in ` +
        `merd/wallets.ts is ${ENGINE_SIGNER_WALLET}. A key rotation must update wallets.ts in the same ` +
        "change, or role separation, docs and the track record silently follow different wallets.",
    );
  }
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
  // WRITES prefer the sequencer-direct endpoint (fewest hops to inclusion),
  // but no longer depend on it alone: the wallet client also runs gas
  // estimation and nonce reads through this transport, and on 2026-08-19 the
  // public endpoint 429'd exactly those calls mid-open (a seat entry failed
  // and the fast watcher wedged the house lock retrying). The dedicated read
  // provider now backs the write path; a relay hop on the fallback leg costs
  // milliseconds, a throttled sequencer endpoint cost real executions.
  // Same signed tx on a retry means the same hash: failover cannot double-send.
  const writeLegs = [http(config.robinhoodWriteRpcUrl, { retryCount: 3, retryDelay: 400 })];
  const backup = config.robinhoodReadRpcUrls.find((u) => u && u !== config.robinhoodWriteRpcUrl);
  if (backup) writeLegs.push(http(backup, { retryCount: 3, retryDelay: 400 }));
  return createWalletClient({
    account: signer.account,
    chain: robinhoodChain,
    transport: writeLegs.length > 1 ? fallback(writeLegs) : writeLegs[0],
  });
}
