// Daily profit reconciliation (operator policy 2026-08-23): lock the gains,
// compound deliberately. Fees are collected to cash intraday by the pilot
// guard and simply HELD — nothing is redeployed on the spot. Once per ET day,
// this measures the day's REALIZED CASH profit (the USDG side of collected
// fees only, since 2026-08-26; token-side fees are inventory until sold, and
// principal is never touched), skims a fixed share to the treasury where it
// can never be given back to the game, and compounds the rest into the
// lighter seat as a single batched top-up. Never intraday, never on
// principal, never on a token mark.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { encodeFunctionData, parseAbiItem } from "viem";
import { dataPath } from "./dataDir.js";
import { readAttributionRows } from "./attribution.js";
import { appendLedger } from "./ledger.js";
import { TREASURY_WALLET } from "./merd/wallets.js";
import { USDG } from "./venues/stockPools.js";
import { getPublicClient, getWalletClient, getAgentSigner } from "./venues/signer.js";
import { guardWalletOp, recordWalletOp } from "./risk.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { openInPool, HANDS_OFF_SYMBOLS } from "./lpGuard.js";
import { lpPositionsWithValue } from "./venues/lpPositions.js";

const STATE_PATH = dataPath("daily-reconcile.json");
const CHECK_MS = 60 * 60 * 1000; // hourly; acts when the ET day rolls over
const SKIM_PCT = Math.min(1, Math.max(0, Number(process.env.MERIDIAN_PROFIT_SKIM_PCT ?? 0.5)));
const MIN_SKIM_USD = Number(process.env.MERIDIAN_RECONCILE_MIN_SKIM_USD ?? 2);
const MIN_COMPOUND_USD = Number(process.env.MERIDIAN_RECONCILE_MIN_COMPOUND_USD ?? 50);

function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface State {
  lastDay: string;
  lastReconcileTs: number;
  carriedCompoundUsd: number;
  lastRun?: { day: string; profitUsd: number; skimmedUsd: number; compoundedUsd: number; carriedUsd: number };
}
let state: State = { lastDay: "", lastReconcileTs: 0, carriedCompoundUsd: 0 };
let loaded = false;

function ensureState(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(STATE_PATH)) {
      const r = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
      if (r && typeof r.lastDay === "string") {
        state = { lastDay: r.lastDay, lastReconcileTs: r.lastReconcileTs ?? 0, carriedCompoundUsd: r.carriedCompoundUsd ?? 0, lastRun: r.lastRun };
      }
    }
  } catch {
    /* fresh state re-seeds */
  }
}
function saveState(): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[reconcile] save failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
  }
}

/** PURE: the day-close split of realized profit. Exported for tests. */
export function reconcileSplit(profitUsd: number, skimPct = SKIM_PCT): { skimUsd: number; compoundUsd: number } {
  const p = Math.max(0, profitUsd);
  const skimUsd = Math.round(p * skimPct * 100) / 100;
  return { skimUsd, compoundUsd: Math.round((p - skimUsd) * 100) / 100 };
}

export function dailyReconcileState(): State {
  ensureState();
  return state;
}

/**
 * PURE: realized CASH profit across attribution rows = the USDG side of
 * collected fees. Exported for tests.
 *
 * Deliberately NOT feeUsd. feeUsd is the income truth (both sides valued at
 * collection-time price), and during a bleed that books depreciating token
 * fees as skimmable profit: measured live 2026-08-26, a "$217 profit" day
 * whose real cash earning was ~$18 shipped ~$109 of working USDG to the
 * treasury and deployed ~$109 more. usdOut is the cash truth, USDG that
 * actually landed in the wallet. Token-side fees stay inventory until a sell
 * row cashes them, and are never skimmed or compounded from here.
 */
export function cashCollectedSince(
  rows: { ts: number; mech?: string; backfilled?: boolean; usdOut: number }[],
  sinceMs: number,
): number {
  return rows
    .filter((r) => r.mech === "collect" && !r.backfilled && r.ts > sinceMs)
    .reduce((s, r) => s + (r.usdOut || 0), 0);
}

/** Realized cash profit since a timestamp (never principal, never token marks). */
function collectedFeesSince(sinceMs: number): number {
  return cashCollectedSince(readAttributionRows(sinceMs), sinceMs);
}

/** Lightest held hands-off seat symbol, to compound into and keep the book balanced. */
async function lightestSeatSymbol(): Promise<string | null> {
  const positions = (await lpPositionsWithValue()).filter((p) => HANDS_OFF_SYMBOLS.has(p.symbol.toUpperCase()));
  if (positions.length === 0) return null;
  const bySymbol = new Map<string, number>();
  for (const p of positions) bySymbol.set(p.symbol.toUpperCase(), (bySymbol.get(p.symbol.toUpperCase()) ?? 0) + p.valueUsd);
  return [...bySymbol.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

async function reconcile(): Promise<void> {
  const now = Date.now();
  const since = state.lastReconcileTs || now - 25 * 60 * 60 * 1000;
  const profit = collectedFeesSince(since);
  const { skimUsd, compoundUsd } = reconcileSplit(profit);
  let skimmed = 0;
  let compounded = 0;

  // --- SKIM to treasury (USDG), capped by available USDG (never principal beyond what we hold as cash) ---
  if (skimUsd >= MIN_SKIM_USD) {
    const signer = getAgentSigner();
    if (signer) {
      const client = getPublicClient();
      const bal = await client.readContract({
        address: USDG,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [signer.address],
      });
      const availUsd = Number(bal) / 1e6;
      const send = Math.min(skimUsd, availUsd);
      if (send >= MIN_SKIM_USD) {
        guardWalletOp(`profit-skim $${send.toFixed(0)}`);
        recordWalletOp(send, "profit-skim");
        const data = encodeFunctionData({
          abi: [parseAbiItem("function transfer(address, uint256) returns (bool)")],
          functionName: "transfer",
          args: [TREASURY_WALLET, BigInt(Math.floor(send * 1e6))],
        });
        const wallet = getWalletClient();
        const hash = await wallet.sendTransaction({ to: USDG, data });
        skimmed = send;
        appendLedger("daily-reconcile.jsonl", { ts: now, kind: "profit-skim", usd: send, tx: hash });
        console.error(`[reconcile] profit skim: $${send.toFixed(2)} USDG -> treasury (locked), tx ${hash}`);
      } else {
        console.error(`[reconcile] skim $${skimUsd.toFixed(2)} deferred: only $${availUsd.toFixed(2)} USDG on hand`);
      }
    }
  }

  // --- COMPOUND the rest, batched; carry forward until it clears the min entry ---
  state.carriedCompoundUsd += compoundUsd;
  if (state.carriedCompoundUsd >= MIN_COMPOUND_USD) {
    const sym = await lightestSeatSymbol();
    if (sym) {
      try {
        const pos = await openInPool(sym, 20, state.carriedCompoundUsd); // ±10%, the proven width
        compounded = state.carriedCompoundUsd;
        appendLedger("daily-reconcile.jsonl", { ts: now, kind: "compound", symbol: sym, usd: compounded, tokenId: pos.tokenId });
        console.error(`[reconcile] compounded $${compounded.toFixed(2)} into ${sym} #${pos.tokenId}`);
        state.carriedCompoundUsd = 0;
      } catch (e) {
        console.error(`[reconcile] compound into ${sym} failed, carrying forward: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
  }

  state.lastRun = { day: todayET(), profitUsd: Math.round(profit * 100) / 100, skimmedUsd: skimmed, compoundedUsd: compounded, carriedUsd: Math.round(state.carriedCompoundUsd * 100) / 100 };
  console.error(`[reconcile] ET day close: profit $${profit.toFixed(2)} -> skim $${skimmed.toFixed(2)} to treasury, compound $${compounded.toFixed(2)} (carry $${state.carriedCompoundUsd.toFixed(2)})`);
}

async function tick(): Promise<void> {
  ensureState();
  const etDay = todayET();
  if (state.lastDay === "") {
    // First boot: set the baseline, do not reconcile a partial day.
    state.lastDay = etDay;
    state.lastReconcileTs = Date.now();
    saveState();
    return;
  }
  if (etDay === state.lastDay) return; // still the same ET day
  try {
    await withHouseWalletLock("daily-reconcile", reconcile, { operator: true });
  } catch (e) {
    console.error(`[reconcile] failed: ${e instanceof Error ? e.message.slice(0, 140) : e}`);
  }
  state.lastDay = etDay;
  state.lastReconcileTs = Date.now();
  saveState();
}

export function startDailyReconcile(): NodeJS.Timeout | undefined {
  if (process.env.MERIDIAN_DAILY_RECONCILE === "off") {
    console.log("[reconcile] off (MERIDIAN_DAILY_RECONCILE=off)");
    return;
  }
  console.log(`[reconcile] armed: at each ET day close, skim ${Math.round(SKIM_PCT * 100)}% of the day's collected fees to the treasury, compound the rest (min $${MIN_COMPOUND_USD})`);
  const t = setInterval(() => void tick(), CHECK_MS);
  t.unref?.();
  void tick();
  return t;
}
