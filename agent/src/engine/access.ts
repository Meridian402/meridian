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
import { merdUsdSpot } from "../merd/merdSpot.js";
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

/** The stake bar, in USD of MERD at the live pool price (operator decision
 *  2026-08-25: $250). Same convention as the earn program's $100 bounty bar. */
export const ENGINE_STAKE_USD = Number(process.env.ENGINE_STAKE_USD ?? 250);

/** PURE: does a staked MERD balance clear the USD bar at the given spot?
 *  A zero or unknown spot price fails closed on purpose. */
export function stakeMeetsBar(stakedWei: bigint, merdUsd: number, barUsd = ENGINE_STAKE_USD): boolean {
  if (!(merdUsd > 0) || !(barUsd > 0)) return false;
  return (Number(stakedWei) / 1e18) * merdUsd >= barUsd;
}

async function hasStake(wallet: Address): Promise<boolean> {
  if (!stakingEnabled()) return false;
  const addr = stakingAddress();
  if (!addr) return false;
  try {
    const [staked, spot] = await Promise.all([
      getPublicClient().readContract({
        address: addr,
        abi: [parseAbiItem("function stakedOf(address account) view returns (uint256)")],
        functionName: "stakedOf",
        args: [wallet],
      }) as Promise<bigint>,
      merdUsdSpot(),
    ]);
    return stakeMeetsBar(staked, spot);
  } catch {
    return false; // fail closed
  }
}

/**
 * The Meridian path (operator decision 2026-08-25): the key is an ACTIVATED
 * seat, not a raw hold. Minting is free; activate() burns ~$25 of MERD and
 * clears on transfer; the 30 raffle seats activate free forever. The contract
 * has no per-owner enumeration yet, so the caller passes the seat id to check
 * (the mint ladder caps a wallet at 3 seats). When the pre-audit contract
 * additions land (per-owner active counter alongside the raffle module), this
 * upgrades to a hint-free read.
 */
async function hasMeridian(wallet: Address, seatId?: string): Promise<boolean> {
  const addr = meridiansNftAddress();
  if (!addr || !seatId || !/^\d{1,6}$/.test(seatId)) return false;
  try {
    const id = BigInt(seatId);
    const client = getPublicClient();
    const [owner, active] = await Promise.all([
      client.readContract({ address: addr, abi: [parseAbiItem("function ownerOf(uint256) view returns (address)")], functionName: "ownerOf", args: [id] }) as Promise<Address>,
      client.readContract({ address: addr, abi: [parseAbiItem("function isActive(uint256) view returns (bool)")], functionName: "isActive", args: [id] }) as Promise<boolean>,
    ]);
    return owner.toLowerCase() === wallet.toLowerCase() && active === true;
  } catch {
    return false; // fail closed
  }
}

// The tokenized-agent path: true when this wallet routed an agent launch
// through Meridian onto PONS v2 AND that launch graduated (operator decision
// 2026-08-26: access arrives at graduation, never at launch). Backed by the
// on-chain-verified launch registry; empty registry fails closed.
async function hasTokenizedAgent(wallet: Address): Promise<boolean> {
  return hasGraduatedLaunch(wallet);
}

/**
 * The gate. Reads chain state to decide access; never signs or moves funds.
 * Fails CLOSED on a malformed address, any read error, or a dormant path.
 * `opts.seatId` lets a Meridian holder point at the seat to verify.
 */
export async function hasEngineAccess(wallet: string, opts?: { seatId?: string }): Promise<AccessResult> {
  if (!ADDRESS_RE.test(wallet.trim())) return decideAccess([]);
  const w = wallet.trim() as Address;
  const paths: AccessVia[] = [];
  if (isAllowlisted(w)) paths.push("allowlist");
  const [staked, meridian, agent] = await Promise.all([hasStake(w), hasMeridian(w, opts?.seatId), hasTokenizedAgent(w)]);
  if (staked) paths.push("stake");
  if (meridian) paths.push("meridian");
  if (agent) paths.push("agent");
  return decideAccess(paths);
}
