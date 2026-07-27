// One-shot capital deployment at the market open: convert idle wallet ETH into
// USDG and open LP positions per an operator-defined plan, ~30min after the
// bell (the 13:30-14:00 UTC opening window is where gaps and toxic flow live).
//
// Deliberately conservative:
//   · plan comes from env (MERIDIAN_OPEN_DEPLOY_PLAN), hard-capped at $2k total,
//     baseline-tradable pools only
//   · fires ONCE per plan: a durable marker is written BEFORE execution, so a
//     crash mid-run can never double-deploy (fail-safe direction: skip, not repeat)
//   · the WHOLE plan runs under one house-wallet lock, so the LP guard's tick
//     can't interleave a retile and absorb a leg's USDG mid-plan
//   · a failed leg ABORTS the remainder — converted USDG stays in the wallet
//     for manual review rather than being swallowed by the next leg's mint
//   · POST /api/open-deploy {dryRun:true} previews everything tonight
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseAbiItem, type Address } from "viem";
import { dataPath } from "./dataDir.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { openInPool, phaseOf } from "./lpGuard.js";
import { realSwapEthToUsdg, isTradable, tradableSymbols } from "./venues/stockPools.js";
import { getAgentSigner, getPublicClient } from "./venues/signer.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";

const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const MARKER = dataPath("open-deploy-state.json");
const MAX_TOTAL_USD = 2000;
const FIRE_HOUR_UTC = Number(process.env.MERIDIAN_OPEN_DEPLOY_HOUR_UTC ?? 14); // 30min after the 13:30 open
const FIRE_MIN_UTC = 0;

interface Leg { symbol: string; usd: number; }

function readPlan(): { legs: Leg[]; error?: string } {
  const raw = process.env.MERIDIAN_OPEN_DEPLOY_PLAN;
  if (!raw) return { legs: [] };
  try {
    const legs = (JSON.parse(raw) as Leg[]).map((l) => ({ symbol: String(l.symbol).toUpperCase(), usd: Number(l.usd) }));
    for (const l of legs) {
      if (!isTradable(l.symbol)) return { legs: [], error: `${l.symbol} is not a tradable pool (seed or qualified: ${tradableSymbols().join(", ")})` };
      if (!Number.isFinite(l.usd) || l.usd < 50) return { legs: [], error: `leg ${l.symbol}: usd must be >= 50` };
    }
    const total = legs.reduce((s, l) => s + l.usd, 0);
    if (total > MAX_TOTAL_USD) return { legs: [], error: `plan total $${total} exceeds hard cap $${MAX_TOTAL_USD}` };
    return { legs };
  } catch {
    return { legs: [], error: "MERIDIAN_OPEN_DEPLOY_PLAN is not valid JSON" };
  }
}

const planKey = (legs: Leg[]) => legs.map((l) => `${l.symbol}:${l.usd}`).join(",");

function markerState(): { done: string[] } {
  try {
    if (existsSync(MARKER)) return JSON.parse(readFileSync(MARKER, "utf8"));
  } catch {}
  return { done: [] };
}

async function usdgBalance(owner: Address): Promise<number> {
  const raw = await getPublicClient().readContract({
    address: USDG,
    abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
    functionName: "balanceOf",
    args: [owner],
  });
  return Number(raw) / 1e6;
}

/** Preview for tonight's verification: plan, prices, balances, fire time — no money moved. */
export async function openDeployPreview() {
  const { legs, error } = readPlan();
  const signer = getAgentSigner();
  const [ethUsd, usdg, ethRaw] = signer
    ? await Promise.all([
        fetchEthUsd().catch(() => null),
        usdgBalance(signer.address).catch(() => null),
        getPublicClient().getBalance({ address: signer.address }).catch(() => null),
      ])
    : [null, null, null];
  const done = markerState().done.includes(planKey(legs));
  return {
    plan: legs,
    planError: error ?? null,
    alreadyExecuted: done,
    firesAtUtc: legs.length && !done ? `${nextFire().toISOString()}` : null,
    wallet: signer
      ? { ethUsd, eth: ethRaw != null ? Number(ethRaw) / 1e18 : null, ethValueUsd: ethRaw != null && ethUsd ? (Number(ethRaw) / 1e18) * ethUsd : null, usdg }
      : "no signer configured",
    hardCapUsd: MAX_TOTAL_USD,
  };
}

/** Execute the plan now (scheduler and the manual endpoint both land here). */
export async function runOpenDeploy(): Promise<{ ok: boolean; results: unknown[]; error?: string }> {
  const { legs, error } = readPlan();
  if (error) return { ok: false, results: [], error };
  if (!legs.length) return { ok: false, results: [], error: "no plan configured" };
  const key = planKey(legs);
  const state = markerState();
  if (state.done.includes(key)) return { ok: false, results: [], error: "plan already executed (marker present)" };
  const signer = getAgentSigner();
  if (!signer) return { ok: false, results: [], error: "no signer configured" };

  // Burn the marker FIRST: if we crash mid-run the plan stays un-repeatable and
  // any converted USDG waits safely in the wallet for manual review.
  state.done.push(key);
  writeFileSync(MARKER, JSON.stringify(state));

  const results: unknown[] = [];
  await withHouseWalletLock("open-deploy", async () => {
    for (const leg of legs) {
      try {
        const have = await usdgBalance(signer.address);
        const need = leg.usd - have;
        let converted = 0;
        if (need > 25) {
          // +1% so pool fee/slippage on the conversion doesn't leave the leg short.
          const swap = await realSwapEthToUsdg({ amountUsd: need * 1.01 });
          converted = swap.usdgReceived;
          console.error(`[openDeploy] converted ~$${converted.toFixed(2)} ETH->USDG for ${leg.symbol} (${swap.hash})`);
        }
        const pos = await openInPool(leg.symbol);
        console.error(`[openDeploy] ✓ ${leg.symbol}: opened #${pos.tokenId} (target $${leg.usd})`);
        results.push({ symbol: leg.symbol, ok: true, tokenId: pos.tokenId, convertedUsd: converted });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 160) : String(err);
        console.error(`[openDeploy] ✗ ${leg.symbol} failed: ${msg} — ABORTING remaining legs; USDG stays in wallet for manual review`);
        results.push({ symbol: leg.symbol, ok: false, error: msg });
        break; // never let a later leg swallow this leg's capital
      }
    }
  });
  return { ok: results.every((r: any) => r.ok), results };
}

function nextFire(): Date {
  const d = new Date();
  const fire = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), FIRE_HOUR_UTC, FIRE_MIN_UTC, 0));
  if (d >= fire) fire.setUTCDate(fire.getUTCDate() + 1);
  while (fire.getUTCDay() === 0 || fire.getUTCDay() === 6) fire.setUTCDate(fire.getUTCDate() + 1); // weekdays only
  return fire;
}

/** Arm the one-shot at boot. No plan configured → logs nothing and does nothing. */
export function scheduleOpenDeploy(): void {
  const { legs, error } = readPlan();
  if (error) { console.error(`[openDeploy] plan invalid, NOT scheduling: ${error}`); return; }
  if (!legs.length) return;
  if (markerState().done.includes(planKey(legs))) { console.error("[openDeploy] plan already executed — not rescheduling"); return; }
  const fire = nextFire();
  const ms = fire.getTime() - Date.now();
  console.error(`[openDeploy] armed: ${legs.map((l) => `$${l.usd} ${l.symbol}`).join(" + ")} at ${fire.toISOString()} (${(ms / 3.6e6).toFixed(1)}h from now)`);
  const t = setTimeout(() => {
    if (phaseOf(new Date()) !== "weekday-market") { console.error("[openDeploy] fire time reached but not market phase — skipping"); return; }
    void runOpenDeploy().then((r) => console.error(`[openDeploy] run finished ok=${r.ok}: ${JSON.stringify(r.results).slice(0, 300)}`));
  }, ms);
  t.unref?.();
}
