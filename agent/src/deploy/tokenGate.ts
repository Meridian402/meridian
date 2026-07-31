// Access gate for personal agents. Multi-token OR: a wallet clears the gate if
// it satisfies ANY of the ways in. Built to ship BEFORE MERD exists.
//
// SHIPS DORMANT, behind its OWN switch: MERIDIAN_HOLDER_GATE=on. Anything else,
// including unset, and the whole gate is a no-op.
//
// It used to key off MERD_TOKEN_ADDRESS, on the reasoning that MERD launching is
// the moment gating goes live. That became a trap once credits could be PAID in
// MERD, because enabling that also requires MERD_TOKEN_ADDRESS. Setting one
// variable to let people spend MERD would have silently locked every wallet
// that does not hold 0.25% of PONS or INDEX out of the product, and the first
// symptom would have been new users being told to go buy a token.
//
// The two also answer different questions and they contradict. Credits are
// metering: start free, then pay for what you use, which is what the site
// promises and what the onboarding is built around. This gate is admission:
// hold a quarter of a percent of a token's entire supply or you cannot use the
// product at all. Running both means a person must buy their way in and then
// pay per message, and the free tier becomes a thing nobody can reach. So the
// gate now has to be asked for by name, and turning MERD payments on no longer
// turns admission control on with it.
//
// The ways to qualify, each measured against that token's OWN live total supply:
//   MERD   hold + stake >= 0.1%   (10 bps)  read from the staking contract
//   PONS   hold         >= 0.25%  (25 bps)  plain balanceOf
//   INDEX  hold         >= 0.25%  (25 bps)  plain balanceOf
//
// MERD is stake-based: its balance is read from MERD_STAKING_ADDRESS, so that
// condition stays inactive until a staking source is wired (pending the
// launchpad-vs-custom decision). PONS and INDEX are plain holds of tokens that
// already exist on-chain (verified 2026-07-28: both ERC-20, symbol PONS / Index,
// 1B supply each). Enforcement is server-side in ensureUserAgent, the one
// chokepoint every agent path funnels through, so a client cannot route around
// it. Balance reads are cached per wallet so re-checking every message does not
// hammer the RPC.
import { parseAbiItem, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { MERD_ADDRESS } from "../merd/merd.js";

const CACHE_MS = Number(process.env.MERD_GATE_CACHE_MS ?? 60_000);
// How long a previously-confirmed pass may be reused while balance reads are
// failing. Long enough to ride out an RPC outage, short enough that access does
// not outlive the stake that earned it.
const STALE_GRACE_MS = Number(process.env.MERD_GATE_STALE_GRACE_MS ?? 60 * 60_000);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// The contract MERD is staked into. Until it is set there is nowhere to read a
// staked balance, so the MERD condition is simply not one of the active OR ways.
const MERD_STAKING = (process.env.MERD_STAKING_ADDRESS ?? "").trim();

// Known ecosystem tokens (verified on-chain 2026-07-28). Env-overridable in case
// an address ever moves, but the defaults are the live tokens. Holding 0.25% of
// either is an alternative way in, independent of MERD.
const PONS_TOKEN = (process.env.PONS_GATE_ADDRESS ?? "0x39dBED3a2bd333467115dE45665cC57F813C4571").trim();
const INDEX_TOKEN = (process.env.INDEX_GATE_ADDRESS ?? "0x56910D4409F3a0C78C64DD8D0545FF0705389870").trim();

// Thresholds in basis points of each token's live supply.
const MERD_BPS = Math.max(0, Number(process.env.MERD_GATE_BPS ?? 10)); // 0.1%
const PONS_BPS = Math.max(0, Number(process.env.PONS_GATE_BPS ?? 25)); // 0.25%
const INDEX_BPS = Math.max(0, Number(process.env.INDEX_GATE_BPS ?? 25)); // 0.25%

/**
 * The MERD token address, or null while MERD does not exist yet.
 *
 * The single answer to "is MERD live", read in one place so every feature that
 * waits on the launch (this gate, paying for credits in MERD) turns on from the
 * same env var and none of them can disagree. Read at call time, not at import,
 * so the dormant and live states are both reachable in tests.
 */
export function merdTokenAddress(): Address | null {
  const raw = (process.env.MERD_TOKEN_ADDRESS ?? "").trim();
  if (!ADDRESS_RE.test(raw)) return null;
  // Hex-shaped is not the same as "is MERD". Two misconfigurations would
  // otherwise arm a live payment path silently: the zero address, and any other
  // real token (USDG pasted into the wrong line). Either would have people
  // paying for credits in something that is not MERD, and the price is a flat
  // number of wei that only makes sense for MERD, so the loss would be real.
  //
  // MERD's address is deterministic and this repo already knows it, so a
  // mismatch is a mistake rather than a deployment we did not anticipate. Fail
  // closed and say why. If MERD is ever deployed somewhere else, MERD_ADDRESS in
  // merd/merd.ts is where its identity lives and is the one place to change.
  if (raw.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    console.error("[merd] MERD_TOKEN_ADDRESS is the zero address, ignoring it and staying dormant");
    return null;
  }
  if (raw.toLowerCase() !== MERD_ADDRESS.toLowerCase()) {
    console.error(
      `[merd] MERD_TOKEN_ADDRESS is ${raw}, which is not MERD (${MERD_ADDRESS}). Staying dormant rather than ` +
        "pricing credits in an unknown token. Update MERD_ADDRESS in merd/merd.ts if MERD really moved.",
    );
    return null;
  }
  return raw as Address;
}

const erc20 = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function totalSupply() view returns (uint256)"),
];
// The staking contract's staked-balance read. The exact function name depends on
// the staking source we settle on; stakedBalanceOf is the assumed shape and is
// isolated here so wiring a different one is a one-line change.
const stakingAbi = [parseAbiItem("function stakedBalanceOf(address) view returns (uint256)")];

type Way = "MERD" | "PONS" | "INDEX";

interface Condition {
  key: Way;
  token: Address; // the token whose supply the threshold is a fraction of
  bps: number;
  kind: "hold" | "stake";
  balanceFrom: Address; // where the caller's qualifying balance is read
}

/**
 * The active ways to qualify, assembled from config. MERD only participates when
 * both its token and a staking source are set; PONS and INDEX participate
 * whenever the gate is on, since their addresses are known.
 */
function conditions(): Condition[] {
  const out: Condition[] = [];
  const merd = merdTokenAddress();
  if (merd && ADDRESS_RE.test(MERD_STAKING)) {
    out.push({ key: "MERD", token: merd, bps: MERD_BPS, kind: "stake", balanceFrom: MERD_STAKING as Address });
  }
  if (ADDRESS_RE.test(PONS_TOKEN)) out.push({ key: "PONS", token: PONS_TOKEN as Address, bps: PONS_BPS, kind: "hold", balanceFrom: PONS_TOKEN as Address });
  if (ADDRESS_RE.test(INDEX_TOKEN)) out.push({ key: "INDEX", token: INDEX_TOKEN as Address, bps: INDEX_BPS, kind: "hold", balanceFrom: INDEX_TOKEN as Address });
  return out;
}

export interface ConditionResult {
  key: Way;
  kind: "hold" | "stake";
  requiredPct: number; // threshold as a percent of that token's supply
  heldPct: number; // the wallet's holding (or stake), as a percent
  passed: boolean;
  error?: boolean; // this condition's read failed
}

export interface GateResult {
  enabled: boolean; // is the gate configured (MERD address set)?
  ok: boolean; // does this wallet clear ANY condition? (always true when disabled)
  conditions: ConditionResult[];
  error?: string; // set when balances couldn't be read and none passed
  retryable?: boolean;
}

export function merdGateEnabled(): boolean {
  // Explicit opt-in, and deliberately NOT inferred from any other setting. A
  // gate that switches itself on as a side effect of an unrelated change is a
  // gate that locks people out on a day nobody was thinking about access.
  return (process.env.MERIDIAN_HOLDER_GATE ?? "").trim().toLowerCase() === "on";
}

export function fmtPct(p: number): string {
  if (!isFinite(p) || p <= 0) return "0%";
  return parseFloat(p >= 1 ? p.toFixed(2) : p.toFixed(4)) + "%";
}

/** Human sentence listing the ways to qualify, for a blocked wallet. */
export function gateMessage(g: GateResult): string {
  if (g.error) return g.error;
  const ways = g.conditions.map((c) =>
    c.kind === "stake" ? `stake ${fmtPct(c.requiredPct)} of ${c.key}` : `hold ${fmtPct(c.requiredPct)} of ${c.key}`,
  );
  const list = ways.length ? ways.join(", or ") : "hold a qualifying ecosystem token";
  return `To run your own agent, ${list}. Your wallet meets none of these yet.`;
}

/**
 * OR semantics, stated once and explicitly: a wallet clears the gate if AT LEAST
 * ONE condition passes. It never has to satisfy all of them. Staking 0.1% of
 * MERD, holding 0.25% of PONS, or holding 0.25% of INDEX are alternatives, not a
 * checklist. Pure and exported so this exact rule is unit-tested.
 */
export function clearsGate(conditions: ConditionResult[]): boolean {
  return conditions.some((c) => c.passed);
}

const cache = new Map<string, { at: number; result: GateResult }>();

/**
 * Resolve whether a wallet clears the access gate. Passes if ANY active
 * condition clears. Cached per wallet for CACHE_MS. On an RPC error a condition
 * counts as not-passed, and if NO condition passed while some read failed, the
 * result is retryable and reuses a recent success (stale-while-error) so a
 * transient blip cannot eject a qualifying wallet mid-session.
 */
export async function checkMerdGate(address: string): Promise<GateResult> {
  if (!merdGateEnabled()) return { enabled: false, ok: true, conditions: [] };
  if (!ADDRESS_RE.test(address)) return { enabled: true, ok: false, conditions: [], error: "invalid wallet address" };

  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const client = getPublicClient();
  const conds = conditions();
  const results: ConditionResult[] = await Promise.all(
    conds.map(async (c): Promise<ConditionResult> => {
      try {
        const [balance, total] = await Promise.all([
          c.kind === "stake"
            ? client.readContract({ address: c.balanceFrom, abi: stakingAbi, functionName: "stakedBalanceOf", args: [address as Address] })
            : client.readContract({ address: c.balanceFrom, abi: erc20, functionName: "balanceOf", args: [address as Address] }),
          client.readContract({ address: c.token, abi: erc20, functionName: "totalSupply" }),
        ]);
        // Exact threshold via bigint; the percent is a float only for display.
        const required = total > 0n ? (total * BigInt(c.bps)) / 10_000n : 1n;
        const passed = total > 0n && balance >= required;
        const heldPct = total > 0n ? (Number(balance) / Number(total)) * 100 : 0;
        return { key: c.key, kind: c.kind, requiredPct: c.bps / 100, heldPct: Math.round(heldPct * 1e6) / 1e6, passed };
      } catch {
        return { key: c.key, kind: c.kind, requiredPct: c.bps / 100, heldPct: 0, passed: false, error: true };
      }
    }),
  );

  const ok = clearsGate(results);
  const anyError = results.some((r) => r.error);

  if (!ok && anyError) {
    // Could not confirm any pass AND a read failed: do not lock out on a blip.
    // The grace is BOUNDED, though. Reusing a pass of unbounded age would mean a
    // wallet that unstaked keeps access for as long as the RPC keeps failing,
    // and since nothing evicts this map, a pass cached once could be replayed
    // indefinitely. An hour covers any realistic outage and still expires.
    if (hit?.result.ok && Date.now() - hit.at < STALE_GRACE_MS) return hit.result;
    return { enabled: true, ok: false, conditions: results, error: "couldn't verify your token balances, try again in a moment", retryable: true };
  }

  const result: GateResult = { enabled: true, ok, conditions: results };
  cache.set(key, { at: Date.now(), result });
  return result;
}

export class MerdGateError extends Error {
  readonly code = "merd_gate";
  readonly gate: GateResult;
  constructor(gate: GateResult) {
    super(gateMessage(gate));
    this.name = "MerdGateError";
    this.gate = gate;
  }
}

/** Throw if the gate is enabled and this wallet clears none of the ways in. */
export async function assertMerdGate(address: string): Promise<void> {
  const gate = await checkMerdGate(address);
  if (gate.enabled && !gate.ok) throw new MerdGateError(gate);
}
