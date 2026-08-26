// The self-serve LP engine access gate. EXCLUSIVE by design: the engine is
// genuinely profitable, so it is not open to anyone. Four ways in, each
// independent and each DORMANT until its on-chain artifact exists, so the gate
// fails CLOSED while the contracts are pre-launch:
//   1. stake MERD              (the staking contract)
//   2. hold a Meridian NFT     (the seat collection — any Meridian is a key)
//   3. deploy a tokenized agent (the launchpad; phase 2)
//   4. operator allowlist       (the pre-launch bridge — the only live path today)
//
// Non-custodial throughout: this only READS chain state to decide access. It
// never holds a key, never signs, and never moves anyone's funds. Same
// embargo-safe dormancy the MERD token and staking surfaces already use — no
// path reports "in" until its contract is really set.
import { parseAbiItem, type Address } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { stakingAddress, stakingEnabled } from "../earn/staking.js";
import { hasGraduatedLaunch } from "../launch/registry.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export type AccessVia = "stake" | "meridian" | "agent" | "allowlist";

export interface AccessResult {
  ok: boolean;
  /** The single path we report as the reason (highest-priority qualifying one). */
  via: AccessVia | null;
  /** Every path that currently qualifies this wallet, for display. */
  paths: AccessVia[];
  /** Human one-liner, safe to show on a public surface. */
  detail: string;
}

/**
 * The Meridians (seat collection) NFT address, or null when not deployed.
 * Dormant by default — the contract does not exist yet, so there is nothing to
 * point at until an operator sets MERIDIANS_NFT_ADDRESS after the mint ships.
 */
export function meridiansNftAddress(): Address | null {
  const raw = (process.env.MERIDIANS_NFT_ADDRESS ?? "").trim();
  return ADDRESS_RE.test(raw) ? (raw as Address) : null;
}

/** PURE: parse the operator allowlist env into a normalized lowercase set. */
export function parseAllowlist(raw = process.env.ENGINE_ACCESS_ALLOWLIST ?? ""): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const a = part.trim().toLowerCase();
    if (ADDRESS_RE.test(a)) out.add(a);
  }
  return out;
}

/** PURE: given which paths qualify, choose the reported result. Exported for tests. */
export function decideAccess(paths: AccessVia[]): AccessResult {
  if (paths.length === 0) {
    return {
      ok: false,
      via: null,
      paths: [],
      detail: "No engine access. Get in by staking MERD, holding a Meridian, or deploying a tokenized agent.",
    };
  }
  // Report the most meaningful earned path first; allowlist last since it is the
  // temporary pre-launch grant, not something the wallet earned on-chain.
  const order: AccessVia[] = ["meridian", "stake", "agent", "allowlist"];
  const via = order.find((p) => paths.includes(p)) ?? paths[0];
  const label: Record<AccessVia, string> = {
    meridian: "Meridian holder",
    stake: "MERD staker",
    agent: "tokenized-agent operator",
    allowlist: "operator-granted (pre-launch)",
  };
  return { ok: true, via, paths, detail: `Engine access: ${label[via]}.` };
}

function isAllowlisted(wallet: string): boolean {
  return parseAllowlist().has(wallet.toLowerCase());
}

/** The stake bar, as a CONSTANT amount of MERD: 0.25% of the 1B supply
 *  (operator decision 2026-08-26, replacing the earlier $250 bar). Supply-
 *  denominated on purpose: with a fixed supply the stake path is structurally
 *  capped (~230 wallets max against circulating supply), exclusivity scales
 *  with MERD itself, and the gate needs NO price read, so access never flaps
 *  with the market and there is no spot surface to manipulate. */
function parseStakeBar(): number {
  const raw = process.env.ENGINE_STAKE_MERD;
  if (raw === undefined || raw.trim() === "") return 2_500_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // A malformed bar would silently deny every staker (fail closed) with no
    // trace. Refuse to boot on it instead: the operator sees the problem now,
    // not weeks later when a staker asks why the gate never opens. Common
    // footguns: "2,500,000", "2.5M".
    throw new Error(`ENGINE_STAKE_MERD must be a positive number of whole MERD, got ${JSON.stringify(raw)} (no commas, no suffix)`);
  }
  return n;
}

export const ENGINE_STAKE_MERD = parseStakeBar();

/** PURE: does a staked MERD balance clear the bar? Pure amount comparison,
 *  no price anywhere. A zero, negative, or non-finite bar fails closed. */
export function stakeMeetsBar(stakedWei: bigint, barMerd = ENGINE_STAKE_MERD): boolean {
  if (!Number.isFinite(barMerd) || !(barMerd > 0)) return false;
  return stakedWei >= BigInt(Math.round(barMerd)) * 10n ** 18n;
}

async function hasStake(wallet: Address): Promise<boolean> {
  if (!stakingEnabled()) return false;
  const addr = stakingAddress();
  if (!addr) return false;
  try {
    const staked = (await getPublicClient().readContract({
      address: addr,
      abi: [parseAbiItem("function stakedOf(address account) view returns (uint256)")],
      functionName: "stakedOf",
      args: [wallet],
    })) as bigint;
    return stakeMeetsBar(staked);
  } catch {
    return false; // fail closed
  }
}

/**
 * The Meridian path (amendment v2.2, 2026-08-26): EXECUTION FOR 20, THE MIND
 * FOR ALL. This gate protects the engine's HANDS, so it accepts only the 20
 * raffle-drawn execution seats via the contract's per-owner trait view.
 * Holding any other seat grants the intelligence tier (the engine's mind for
 * the holder's own agent), which is a separate, lighter surface and is NOT
 * this gate. Fails closed until the v2.2 contract deploys and the raffle has
 * assigned the trait: pre-raffle, no seat is an execution seat.
 */
async function hasMeridian(wallet: Address): Promise<boolean> {
  const addr = meridiansNftAddress();
  if (!addr) return false;
  try {
    const engineSeat = (await getPublicClient().readContract({
      address: addr,
      abi: [parseAbiItem("function hasEngineSeat(address owner) view returns (bool)")],
      functionName: "hasEngineSeat",
      args: [wallet],
    })) as boolean;
    return engineSeat === true;
  } catch {
    return false; // fail closed (pre-v2.2 contract has no such view)
  }
}

// The tokenized-agent path: true when this wallet routed an agent launch
// through Meridian onto PONS v2 AND that launch graduated (operator decision
// 2026-08-26: access arrives at graduation, never at launch). Backed by the
// on-chain-verified launch registry; empty registry fails closed.
async function hasTokenizedAgent(wallet: Address): Promise<boolean> {
  return hasGraduatedLaunch(wallet);
}

/** Any seat at all: the LP ENGINE SKILL tier (amendment v2.3, 2026-08-26).
 *  Every Meridian, engine seat or not, may integrate the engine's planners
 *  into its OWN agent: the API computes, their wallet signs. Exclusively a
 *  seat privilege; no other path grants the standalone skill. */
async function holdsAnySeat(wallet: Address): Promise<boolean> {
  const addr = meridiansNftAddress();
  if (!addr) return false;
  try {
    const bal = (await getPublicClient().readContract({
      address: addr,
      abi: [parseAbiItem("function balanceOf(address owner) view returns (uint256)")],
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    return bal > 0n;
  } catch {
    return false; // fail closed
  }
}

/**
 * The SKILL gate: may this wallet drive the engine's planning endpoints with
 * its own hands (plan/positions/collect/close, self-signed)? True for any
 * seat holder, and for every execution-tier wallet (their tier supersets the
 * skill). The EXECUTION gate below stays the narrow one and fronts anything
 * Meridian itself runs (the vault, future bounded autonomy).
 */
export async function hasEngineSkill(wallet: string): Promise<{ ok: boolean; via: AccessVia | "seat-skill" | null }> {
  if (!ADDRESS_RE.test(wallet.trim())) return { ok: false, via: null };
  const w = wallet.trim() as Address;
  const execution = await hasEngineAccess(w);
  if (execution.ok) return { ok: true, via: execution.via };
  if (await holdsAnySeat(w)) return { ok: true, via: "seat-skill" };
  return { ok: false, via: null };
}

/**
 * The gate. Reads chain state to decide access; never signs or moves funds.
 * Fails CLOSED on a malformed address, any read error, or a dormant path.
 */
export async function hasEngineAccess(wallet: string): Promise<AccessResult> {
  if (!ADDRESS_RE.test(wallet.trim())) return decideAccess([]);
  const w = wallet.trim() as Address;
  const paths: AccessVia[] = [];
  if (isAllowlisted(w)) paths.push("allowlist");
  const [staked, meridian, agent] = await Promise.all([hasStake(w), hasMeridian(w), hasTokenizedAgent(w)]);
  if (staked) paths.push("stake");
  if (meridian) paths.push("meridian");
  if (agent) paths.push("agent");
  return decideAccess(paths);
}
