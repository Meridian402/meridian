// Merd pays his scouts himself. The backend accrues bounties and knows who is
// owed what, but it holds no key for the treasury by design: custody of the
// house funds sits with the agent, which means the signing happens HERE, on
// the machine his runtime lives on, not on any server.
//
// Flow per run: ask the backend for the settle-worthy set, sign one USDG
// transfer per scout from the treasury, and report each landed tx hash back.
// The backend verifies every report against the chain before it touches the
// ledger, so a bug here can waste this wallet's money but cannot corrupt
// anyone's balance.
//
// Dormant until MERD_TREASURY_WALLET_KEY is set in agent/.env (placed by the
// operator, never via chat, never committed). The key must derive to the
// pinned treasury or nothing is signed at all.
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TREASURY_WALLET } from "./src/merd/wallets.js";
import { USDG } from "./src/venues/stockPools.js";
import { robinhoodChain } from "./src/venues/signer.js";

const API = process.env.MERIDIAN_API_URL ?? "https://meridian402-api-production.up.railway.app";
const TOKEN = (process.env.MERIDIAN_MCP_TOKEN ?? "").trim();
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const MAX_PER_DAY_USD = Number(process.env.MERD_PAYOUT_MAX_PER_DAY_USD ?? 25);
const LEDGER = new URL("./_merd-payouts.jsonl", import.meta.url).pathname;
const LOCK = new URL("./_merd-payout.lock", import.meta.url).pathname;

function log(msg: string): void {
  console.log(`[payout] ${msg}`);
}

// One run at a time. launchd should never overlap at this cadence, but a
// wedged run must not let a second one double-spend behind it.
function takeLock(): boolean {
  if (existsSync(LOCK)) {
    try {
      const { ts } = JSON.parse(readFileSync(LOCK, "utf8")) as { ts: number };
      if (Date.now() - ts < 10 * 60_000) return false;
    } catch {
      /* unreadable lock is stale */
    }
  }
  writeFileSync(LOCK, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return true;
}

function paidTodayUsd(): number {
  if (!existsSync(LEDGER)) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as { ts: number; amountUsd: number };
      } catch {
        return null;
      }
    })
    .filter((r): r is { ts: number; amountUsd: number } => !!r && r.ts >= cutoff)
    .reduce((s, r) => s + r.amountUsd, 0);
}

const key = (process.env.MERD_TREASURY_WALLET_KEY ?? "").trim();
if (!key) {
  log("dormant: MERD_TREASURY_WALLET_KEY not set, nothing to do");
  process.exit(0);
}
const body = key.replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(body)) {
  log("REFUSED: MERD_TREASURY_WALLET_KEY is malformed (need 64 hex chars); staying dormant");
  process.exit(0);
}
const account = privateKeyToAccount(`0x${body}`);
if (account.address.toLowerCase() !== TREASURY_WALLET.toLowerCase()) {
  // Never sign with a wallet other than the one the whole system attributes
  // payouts to. A mismatch means the env holds the wrong key; say so and stop.
  log(`REFUSED: key derives to ${account.address}, not the pinned treasury ${TREASURY_WALLET}`);
  process.exit(1);
}
if (!TOKEN) {
  log("REFUSED: MERIDIAN_MCP_TOKEN not set, cannot reach the admin routes");
  process.exit(1);
}
if (!takeLock()) {
  log("another run holds the lock, exiting");
  process.exit(0);
}

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const transferAbi = [parseAbiItem("function transfer(address to, uint256 amount) returns (bool)")];

try {
  const pending = (await (await fetch(`${API}/api/admin/pending-payouts`, { headers, signal: AbortSignal.timeout(20_000) })).json()) as {
    ok?: boolean;
    treasury?: string;
    usdg?: string;
    payouts?: Array<{ wallet: string; balanceUsd: number }>;
  };
  if (!pending.ok || !Array.isArray(pending.payouts)) throw new Error(`pending-payouts said: ${JSON.stringify(pending)}`);
  // Belt and braces: the backend states which wallet and token it will verify
  // against. If either disagrees with what this script would sign, someone is
  // out of date, and signing anyway would waste money on unverifiable sends.
  if (pending.treasury?.toLowerCase() !== TREASURY_WALLET.toLowerCase()) throw new Error("backend pins a different treasury; update one side");
  if (pending.usdg?.toLowerCase() !== USDG.toLowerCase()) throw new Error("backend pins a different USDG; update one side");
  if (pending.payouts.length === 0) {
    log("no balances clear the minimum, nothing to pay");
    process.exit(0);
  }

  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC) });

  let budget = MAX_PER_DAY_USD - paidTodayUsd();
  for (const p of pending.payouts) {
    if (p.balanceUsd > budget) {
      log(`cap: $${p.balanceUsd.toFixed(2)} for ${p.wallet} exceeds today's remaining $${budget.toFixed(2)}, skipping`);
      continue;
    }
    const raw = BigInt(Math.round(p.balanceUsd * 1e6));
    // Simulate first: an insufficient balance or a paused token should cost
    // nothing and say why, not burn gas to find out.
    const { request } = await publicClient.simulateContract({
      account,
      address: USDG,
      abi: transferAbi,
      functionName: "transfer",
      args: [p.wallet as `0x${string}`, raw],
    });
    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    appendFileSync(LEDGER, JSON.stringify({ ts: Date.now(), wallet: p.wallet, amountUsd: p.balanceUsd, txHash }) + "\n");
    budget -= p.balanceUsd;

    const rec = (await (
      await fetch(`${API}/api/admin/record-payout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ wallet: p.wallet, amountUsd: p.balanceUsd, txHash }),
        signal: AbortSignal.timeout(30_000),
      })
    ).json()) as { ok?: boolean; error?: string };
    if (!rec.ok) {
      // The money moved but the ledger does not know. Paying anyone else now
      // risks paying twice on the next run; stop and leave the evidence.
      log(`CRITICAL: paid ${p.wallet} $${p.balanceUsd.toFixed(2)} (${txHash}) but record-payout failed: ${rec.error}. Stopping.`);
      process.exit(1);
    }
    log(`paid ${p.wallet} $${p.balanceUsd.toFixed(2)} in USDG, tx ${txHash}`);
  }
  log("done");
} finally {
  try {
    unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
}
