// Launch a token to PONS custodially, triggered from X.
//
// The operator chose custodial deploy: Meridian's own launch wallet signs and
// pays for a launch when someone requests one on X, instead of handing them a
// transaction to sign themselves. This module is that deployer.
//
// IT IS WALLED OFF FROM THE TREASURY, ON PURPOSE. A wallet that spends on a
// PUBLIC trigger (anyone can tweet) is a drain vector, so it uses its own
// dedicated key (MERD_LAUNCH_WALLET_KEY), never AGENT_SIGNER_PRIVATE_KEY. Fund
// it with only what you are willing to see spent, because its balance is the
// ultimate backstop behind the caps.
//
// SHIPS DORMANT: no launch key set, no launching. custodialLaunchEnabled() is
// false until an operator deliberately funds a wallet and sets its key.
//
// FEE ATTRIBUTION: Meridian is the on-chain creator (it signs), but feeWallet is
// the REQUESTER's address, so the token's trading fees and initial-buy belong to
// them, not to Meridian. Meridian pays the launch fee and gas and keeps nothing.
// There is no initial buy, so the only spend is the fee plus gas.
//
// CAPS, non-negotiable: a global daily ceiling and a per-requester daily limit,
// both folded from an append-only ledger so a restart cannot reset them, same
// doctrine as the chat spend ceiling.
//
// SIMULATE BEFORE SPEND: every launch is simulated against the chain first, so a
// request that would revert costs nothing. Money only moves once the launch is
// proven to land.
import { createWalletClient, http, parseEther, formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync } from "node:fs";
import { getPublicClient, robinhoodChain } from "../venues/signer.js";
import { config } from "../config.js";
import { dataPath } from "../dataDir.js";
import { appendLedger } from "../ledger.js";
import { buildPonsLaunch, simulatePonsLaunch, validateTokenIdentity } from "./pons.js";

export const LAUNCHES_FILE = "custodial-launches.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
/** Total launches Meridian will pay for in a day, across everyone. */
export function maxLaunchesPerDay(): number {
  return intEnv("LAUNCH_MAX_PER_DAY", 25);
}
/** How many one requester may trigger in a day. Default 1: a launch is not a
 *  thing anyone needs to do repeatedly, and a low number blunts a spam-drain. */
export function maxPerRequesterPerDay(): number {
  return intEnv("LAUNCH_MAX_PER_REQUESTER_PER_DAY", 1);
}
/**
 * The most ETH one launch may carry. The caps above count LAUNCHES, so without
 * this a PONS fee increase would scale the daily drain silently: 25 launches a
 * day is a very different promise at 0.001 ETH each versus 0.1. The fee is
 * read live from the factory, so the ceiling is what turns "whatever PONS
 * charges" back into an operator decision.
 */
export function maxLaunchSpendWei(): bigint {
  const raw = process.env.MERD_LAUNCH_MAX_ETH ?? "0.02";
  try {
    const wei = parseEther(raw.trim());
    return wei > 0n ? wei : parseEther("0.02");
  } catch {
    return parseEther("0.02");
  }
}

function normalizeKey(raw: string): Hex {
  const body = raw.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error("MERD_LAUNCH_WALLET_KEY must be 64 hex characters (with or without 0x)");
  }
  return `0x${body}`;
}

/** The dedicated launch wallet, or null when custodial launch is off. */
export function launchWallet(): { account: ReturnType<typeof privateKeyToAccount>; address: Address } | null {
  const key = (process.env.MERD_LAUNCH_WALLET_KEY ?? "").trim();
  if (!key) return null;
  const account = privateKeyToAccount(normalizeKey(key));
  return { account, address: account.address };
}

export function custodialLaunchEnabled(): boolean {
  try {
    return launchWallet() !== null;
  } catch {
    // A malformed key is OFF, not a crash: a typo in an env var must not take a
    // public feature down, it must leave it dormant.
    return false;
  }
}

interface LaunchRow {
  requester?: string;
  feeWallet?: string;
  token?: string;
  symbol?: string;
  txHash?: string;
  at?: number;
  /** "attempt" is written before the send and is what the caps count, so a
   *  send that dies mid-flight still consumed its slot. "landed"/"reverted"
   *  are audit outcomes for the same launch and are excluded from cap math.
   *  Legacy rows (no status) predate the split and count as attempts. */
  status?: "attempt" | "landed" | "reverted";
}

function readLaunches(): LaunchRow[] {
  try {
    const p = dataPath(LAUNCHES_FILE);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as LaunchRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is LaunchRow => r !== null);
  } catch {
    return [];
  }
}

export interface CapStatus {
  globalToday: number;
  globalMax: number;
  requesterToday: number;
  requesterMax: number;
}

/** How much of the daily allowance is used, globally and for one requester. */
export function launchCapStatus(requester?: string, now = Date.now()): CapStatus {
  const since = now - DAY_MS;
  const recent = readLaunches().filter(
    (r) => typeof r.at === "number" && (r.at as number) >= since && (r.status === "attempt" || r.status === undefined),
  );
  const requesterToday = requester
    ? recent.filter((r) => (r.requester ?? "").toLowerCase() === requester.toLowerCase()).length
    : 0;
  return {
    globalToday: recent.length,
    globalMax: maxLaunchesPerDay(),
    requesterToday,
    requesterMax: maxPerRequesterPerDay(),
  };
}

export interface LaunchRequest {
  symbol: string;
  name: string;
  /** The requester's wallet: receives the token's fees and initial buy. */
  feeWallet: string;
  /** A stable id for the requester (e.g. an X user id) for the per-requester
   *  cap. REQUIRED: with a wallet-based fallback, one person rotates fee
   *  wallets and the per-requester cap stops existing. No identity, no
   *  launch. */
  requester?: string;
}

export type LaunchResult =
  | { ok: true; token: Address; txHash: Hex; symbol: string; name: string }
  | { ok: false; error: string; code: "disabled" | "invalid" | "capped" | "would_revert" | "reverted" | "failed" };

// One launch at a time. The caps are read from the ledger and the attempt row
// is written back to it, so two mentions racing through the gap would both
// pass a cap with one slot left. The engage runner is a single process, which
// makes this queue a complete fix, not a best effort.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Deploy a token to PONS from the launch wallet. Validates identity, enforces
 * the caps and the per-launch spend ceiling, simulates, writes the attempt to
 * the cap ledger, then sends. On-chain creator is the launch wallet;
 * feeWallet is the requester, so Meridian pays but does not profit.
 */
export function executeCustodialLaunch(req: LaunchRequest): Promise<LaunchResult> {
  const run = queue.then(() => doLaunch(req));
  queue = run.catch(() => undefined);
  return run;
}

async function doLaunch(req: LaunchRequest): Promise<LaunchResult> {
  const wallet = launchWallet();
  if (!wallet) return { ok: false, code: "disabled", error: "custodial launch is not enabled" };
  if (!ADDRESS_RE.test(req.feeWallet)) {
    return { ok: false, code: "invalid", error: "a valid fee-wallet address is required so you own the token" };
  }
  const requester = (req.requester ?? "").trim().toLowerCase();
  if (!requester) {
    return { ok: false, code: "invalid", error: "a stable requester identity is required for the daily limit" };
  }

  let id: { name: string; symbol: string };
  try {
    id = validateTokenIdentity(req.name, req.symbol);
  } catch (err) {
    return { ok: false, code: "invalid", error: err instanceof Error ? err.message : "invalid token name or symbol" };
  }

  // Caps, checked BEFORE any chain work so a capped request costs nothing.
  const caps = launchCapStatus(requester);
  if (caps.globalToday >= caps.globalMax) {
    return { ok: false, code: "capped", error: "the daily launch limit is reached, try again tomorrow" };
  }
  if (caps.requesterToday >= caps.requesterMax) {
    return { ok: false, code: "capped", error: "you have already launched today" };
  }

  // creator = launch wallet (it signs), feeWallet = requester, no initial buy.
  const built = await buildPonsLaunch({
    name: id.name,
    symbol: id.symbol,
    creator: wallet.address,
    feeWallet: req.feeWallet as Address,
    initialBuyWei: 0n,
  });

  // The fee is read live from the factory; the ceiling is ours. Refusing here
  // means a PONS fee hike parks the feature loudly instead of scaling the
  // daily spend 25x quietly.
  const ceiling = maxLaunchSpendWei();
  if (built.value > ceiling) {
    return {
      ok: false,
      code: "capped",
      error: `the launch fee (${formatEther(built.value)} ETH) is over the per-launch ceiling (${formatEther(ceiling)} ETH), so launches are paused`,
    };
  }

  // Prove it lands before spending a cent.
  const sim = await simulatePonsLaunch(built, wallet.address);
  if (!sim.ok) {
    const why = sim.underfunded ? "the launch wallet is out of funds" : sim.error ?? "it would revert";
    return { ok: false, code: "would_revert", error: `launch not sent: ${why}` };
  }

  // The attempt is ledgered BEFORE the send: a send that dies after leaving
  // this process (or a receipt wait that throws) has still spent money, so it
  // must have already consumed its cap slot. Simulation has passed by here, so
  // an honest requester's slot is not burned on a launch that never could land.
  appendLedger(LAUNCHES_FILE, {
    requester,
    feeWallet: req.feeWallet.toLowerCase(),
    symbol: id.symbol,
    at: Date.now(),
    status: "attempt",
  });

  try {
    const client = createWalletClient({ account: wallet.account, chain: robinhoodChain, transport: http(config.robinhoodWriteRpcUrl) });
    const txHash = await client.sendTransaction({ to: built.to, data: built.data, value: built.value });
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      appendLedger(LAUNCHES_FILE, { requester, txHash, at: Date.now(), status: "reverted" });
      return { ok: false, code: "reverted", error: `launch transaction reverted: ${txHash}` };
    }
    // The audit row ties every token this wallet created to who asked for it.
    appendLedger(LAUNCHES_FILE, {
      requester,
      feeWallet: req.feeWallet.toLowerCase(),
      token: built.predictedToken.toLowerCase(),
      symbol: id.symbol,
      txHash,
      at: Date.now(),
      status: "landed",
    });
    return { ok: true, token: built.predictedToken, txHash, symbol: id.symbol, name: id.name };
  } catch (err) {
    return { ok: false, code: "failed", error: err instanceof Error ? err.message : "launch failed to send" };
  }
}
