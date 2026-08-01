// MERD staking, the read + advise-then-approve surface.
//
// SHIPS DORMANT. MERD is not deployed and the staking contract has no address
// yet, so stakingEnabled() is false until BOTH MERD_TOKEN_ADDRESS and
// MERD_STAKING_ADDRESS are set. Every read below returns the dormant shape until
// then, and the Earn card is gated on `enabled`, so nothing about MERD renders
// on the site before the pool is seeded. Same embargo-safe pattern custody used.
//
// THE MODEL (MeridianStakingRewards.sol): stake MERD as principal that does not
// change, and earn a separate reward in USDG — 20% of platform revenue — that
// you actively CLAIM while staying staked. There is no APR and no rate: rewards
// are only what actually arrived, split pro-rata by stake at the moment revenue
// is funded in. The honest numbers are total MERD staked, your stake, and the
// USDG you have accrued and can claim now. All backward-looking.
//
// SIGNING: like the rest of earn, this builds UNSIGNED {to,data,value} steps the
// user signs from their own wallet. Nothing here holds a key or can move a
// staker's MERD or their rewards.
import { encodeFunctionData, parseAbiItem, formatUnits, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { merdTokenAddress, MERD_ADDRESS } from "../merd/merd.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const stakingAbi = [
  parseAbiItem("function stake(uint256 amount)"),
  parseAbiItem("function unstake(uint256 amount)"),
  parseAbiItem("function claim() returns (uint256 owed)"),
  parseAbiItem("function exit()"),
  parseAbiItem("function stakedOf(address account) view returns (uint256)"),
  parseAbiItem("function earned(address account) view returns (uint256)"),
  parseAbiItem("function totalStaked() view returns (uint256)"),
];
const erc20Abi = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
];

const MIN_STAKE_MERD = 1; // matches the contract's MIN_STAKE = 1e18

/**
 * The staking contract address, or null when staking is not live here.
 * Env-driven and dormant by default: the contract is not deployed and has no
 * entry in the merd.ts address book, so there is nothing to point at until an
 * operator sets MERD_STAKING_ADDRESS after launch.
 */
export function stakingAddress(): Address | null {
  const raw = (process.env.MERD_STAKING_ADDRESS ?? "").trim();
  return ADDRESS_RE.test(raw) ? (raw as Address) : null;
}

/** Staking is offerable only when MERD itself is live AND the vault is set. */
export function stakingEnabled(): boolean {
  return merdTokenAddress() !== null && stakingAddress() !== null;
}

export interface StakingState {
  enabled: boolean;
  /** Total MERD staked across everyone, human units. */
  totalStakedMerd?: number;
  /** This wallet's staked MERD, when an address is given. */
  yourStakedMerd?: number;
  /** This wallet's accrued USDG, claimable right now. The "additional money". */
  yourClaimableUsdg?: number;
}

/**
 * The public + per-wallet staking read. Returns { enabled: false } while dormant,
 * so a caller never special-cases a missing contract and the card just hides.
 */
export async function stakingState(address?: string): Promise<StakingState> {
  if (address && !ADDRESS_RE.test(address)) throw new Error("invalid address");
  const vault = stakingAddress();
  if (!stakingEnabled() || !vault) return { enabled: false };

  const client = getPublicClient();
  const totalStaked = await client.readContract({ address: vault, abi: stakingAbi, functionName: "totalStaked" });
  const out: StakingState = { enabled: true, totalStakedMerd: Number(formatUnits(totalStaked, 18)) };

  if (address) {
    const owner = address as Address;
    const [staked, earned] = await Promise.all([
      client.readContract({ address: vault, abi: stakingAbi, functionName: "stakedOf", args: [owner] }),
      client.readContract({ address: vault, abi: stakingAbi, functionName: "earned", args: [owner] }),
    ]);
    out.yourStakedMerd = Number(formatUnits(staked, 18));
    out.yourClaimableUsdg = Number(formatUnits(earned, 6)); // USDG is 6 decimals
  }
  return out;
}

export interface PreparedStep {
  kind: string;
  description: string;
  to: Address;
  data: Hex;
  value: string;
}

/**
 * Build the unsigned steps for a staking action the user signs from their own
 * wallet: stake (approve MERD if needed, then stake), unstake the full position,
 * or claim accrued USDG without touching the stake.
 */
export async function prepareStake(params: { address: string; amountMerd: number; direction: "stake" | "unstake" | "claim" }): Promise<Record<string, unknown>> {
  const { address, direction } = params;
  if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
  const vault = stakingAddress();
  if (!stakingEnabled() || !vault) throw new Error("staking is not live yet");
  const owner = address as Address;
  const client = getPublicClient();

  if (direction === "claim") {
    const earned = await client.readContract({ address: vault, abi: stakingAbi, functionName: "earned", args: [owner] });
    if (earned === 0n) throw new Error("nothing to claim yet");
    return {
      ok: true,
      kind: "staking",
      chainId: 4663,
      direction,
      complete: true,
      amountOutUsdg: Number(formatUnits(earned, 6)),
      steps: [
        { kind: "claim", description: "Claim your accrued USDG", to: vault, data: encodeFunctionData({ abi: stakingAbi, functionName: "claim" }), value: "0" },
      ],
      note: "Claims the USDG revenue you have accrued. Your staked MERD is untouched and keeps earning.",
    };
  }

  if (direction === "unstake") {
    const staked = await client.readContract({ address: vault, abi: stakingAbi, functionName: "stakedOf", args: [owner] });
    if (staked === 0n) throw new Error("no staked position to unstake");
    const earned = await client.readContract({ address: vault, abi: stakingAbi, functionName: "earned", args: [owner] });
    return {
      ok: true,
      kind: "staking",
      chainId: 4663,
      direction,
      complete: true,
      amountOutMerd: Number(formatUnits(staked, 18)),
      alsoClaimsUsdg: Number(formatUnits(earned, 6)),
      steps: [
        // exit() claims accrued USDG and withdraws the whole stake in one tx, so
        // a full exit never leaves rewards behind.
        { kind: "exit", description: "Claim your USDG and unstake your MERD", to: vault, data: encodeFunctionData({ abi: stakingAbi, functionName: "exit" }), value: "0" },
      ],
      note: "Withdraws your full MERD stake and claims any accrued USDG in the same transaction. No fee, no lockup.",
    };
  }

  // stake
  const merd = merdTokenAddress() ?? MERD_ADDRESS;
  if (params.amountMerd < MIN_STAKE_MERD) throw new Error("the minimum stake is 1 MERD");
  const amountWei = BigInt(Math.round(params.amountMerd * 1e6)) * 10n ** 12n; // 6dp precision, scaled to 18
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: merd, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: merd, abi: erc20Abi, functionName: "allowance", args: [owner, vault] }),
  ]);
  if (balance < amountWei) throw new Error(`not enough MERD: staking ${params.amountMerd} needs more than the wallet holds`);

  const steps: PreparedStep[] = [];
  if (allowance < amountWei) {
    steps.push({
      kind: "approve",
      description: "Allow the staking vault to pull your MERD (one-time)",
      to: merd,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, (1n << 256n) - 1n] }),
      value: "0",
    });
  }
  steps.push({
    kind: "stake",
    description: `Stake ${params.amountMerd} MERD`,
    to: vault,
    data: encodeFunctionData({ abi: stakingAbi, functionName: "stake", args: [amountWei] }),
    value: "0",
  });

  return {
    ok: true,
    kind: "staking",
    chainId: 4663,
    direction,
    complete: true,
    amountInMerd: params.amountMerd,
    steps,
    note: "Staking earns you a share of platform revenue in USDG, paid pro-rata to your stake. There is no fixed rate and no lockup; you claim the USDG whenever you like and your MERD stays yours.",
  };
}
