// Can this system actually pay what it owes, right now?
//
// The 2026-08-01 rotation split the roles: revenue collects into the agent's
// treasury, and the engine signs with a different key. That is the intended
// design, but it created a trap. The original settlement path spends USDG
// FROM THE SIGNER, and the signer has no income any more, so it drains to
// zero and stays there while the treasury fills up. Nothing errors at boot:
// the first symptom is a scout who earned a bounty not being paid.
//
// This makes the money side legible before it bites: what each wallet holds,
// what is owed, and a plain verdict on whether settlement can happen.
import { formatUnits } from "viem";
import { getPublicClient } from "./venues/signer.js";
import { USDG } from "./venues/stockPools.js";
import { ENGINE_SIGNER_WALLET } from "./merd/wallets.js";
import { pendingPayouts } from "./earn/scout.js";

const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface WalletFunding {
  address: string;
  ethBalance: number;
  usdgBalance: number;
}

export interface FundingHealth {
  ok: boolean;
  treasury: WalletFunding;
  signer: WalletFunding;
  owedUsd: number;
  /** Plain sentences, in priority order. Empty when nothing needs attention. */
  warnings: string[];
}

// Gas on this chain runs around 0.02 gwei, so a transfer costs micro-ETH and
// even a small balance covers hundreds of them. This floor is not about one
// transaction, it is the point where a wallet can no longer be relied on.
const MIN_GAS_ETH = 0.0005;

let cache: { at: number; value: FundingHealth } | null = null;
const TTL_MS = 60_000;

async function readWallet(address: `0x${string}`): Promise<WalletFunding> {
  const client = getPublicClient();
  const [wei, usdgRaw] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDG, abi: balanceOfAbi, functionName: "balanceOf", args: [address] }),
  ]);
  return {
    address,
    ethBalance: Number(formatUnits(wei, 18)),
    usdgBalance: Number(formatUnits(usdgRaw as bigint, 6)),
  };
}

/** Live funding picture. Cached briefly: /api/ops is polled and these are chain reads. */
export async function fundingHealth(): Promise<FundingHealth> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  // Since 2026-09-04 the execution wallet is the house wallet: it earns, holds,
  // pays, and is the only wallet reported. The retired treasury is not read.
  const signer = await readWallet(ENGINE_SIGNER_WALLET as `0x${string}`);
  const treasury: WalletFunding = { address: "retired", ethBalance: 0, usdgBalance: 0 };

  const pending = pendingPayouts() as { payouts?: Array<{ balanceUsd: number }> };
  const owedUsd = Math.round((pending.payouts ?? []).reduce((s, p) => s + p.balanceUsd, 0) * 100) / 100;

  const warnings: string[] = [];
  // The owed money is the thing that has a person on the other end of it, so
  // it leads.
  if (owedUsd > 0 && signer.usdgBalance < owedUsd) {
    warnings.push(
      `$${owedUsd.toFixed(2)} of bounties are payable and the house wallet holds $${signer.usdgBalance.toFixed(2)} USDG. ` +
        "Scouts who earned them cannot be paid until it is funded.",
    );
  }
  if (signer.ethBalance < MIN_GAS_ETH) {
    warnings.push(
      `The engine signer holds ${signer.ethBalance.toFixed(5)} ETH, below the ${MIN_GAS_ETH} floor. ` +
        "Unattended operations that need to sign will start failing.",
    );
  }


  const value: FundingHealth = { ok: warnings.length === 0, treasury, signer, owedUsd, warnings };
  cache = { at: Date.now(), value };
  return value;
}

/** One-shot check for boot: says the quiet part into the log rather than waiting for a failure. */
export async function logFundingHealthAtBoot(): Promise<void> {
  try {
    const h = await fundingHealth();
    if (h.ok) {
      console.error(`[funding] treasury $${h.treasury.usdgBalance.toFixed(2)} USDG, signer ${h.signer.ethBalance.toFixed(5)} ETH, nothing owed`);
      return;
    }
    for (const w of h.warnings) console.error(`[funding] ${w}`);
  } catch (err) {
    // Never let a chain read stop the server booting.
    console.error("[funding] could not read balances:", err instanceof Error ? err.message : err);
  }
}
