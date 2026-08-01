// MERD staking, the read + advise-then-approve surface.
//
// SHIPS DORMANT. MERD is not deployed and the staking contract has no address
// yet, so stakingEnabled() is false until BOTH MERD_TOKEN_ADDRESS and
// MERD_STAKING_ADDRESS are set. Every read below returns the dormant shape
// until then, and the Earn card is gated on `enabled`, so nothing about MERD
// renders on the site before the pool is seeded. This is the same embargo-safe
// pattern custody and the old holder gate used.
//
// NO APR, ON PURPOSE. MeridianStaking.sol has no rate variable, no emission and
// no reward token. Stakers earn only because fund() adds MERD to the pot (from
// buybacks and platform revenue) WITHOUT minting shares, so each share quietly
// becomes worth more MERD. There is no forward rate to honestly display, and
// inventing one would be exactly the fabricated number this project refuses. The
// only honest metric is share price, which starts at 1e18 and can only rise, so
// the card shows realised growth ("each share is up X% since launch"), never a
// projection.
//
// SIGNING: like the rest of earn, this builds UNSIGNED {to,data,value} steps the
// user signs from their own wallet. Nothing here holds a key or can move a
// staker's MERD.
import { encodeFunctionData, parseAbiItem, formatUnits, type Address, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { merdTokenAddress, MERD_ADDRESS } from "../merd/merd.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ONE = 10n ** 18n;

const stakingAbi = [
  parseAbiItem("function stake(uint256 assets) returns (uint256 shares)"),
  parseAbiItem("function unstake(uint256 shares) returns (uint256 assets)"),
  parseAbiItem("function unstakeAll() returns (uint256 assets)"),
  parseAbiItem("function stakedBalanceOf(address account) view returns (uint256)"),
  parseAbiItem("function sharesOf(address account) view returns (uint256)"),
  parseAbiItem("function totalAssets() view returns (uint256)"),
  parseAbiItem("function sharePrice() view returns (uint256)"),
  parseAbiItem("function previewUnstake(uint256 shares) view returns (uint256)"),
];
const erc20Abi = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address owner, address spender) view returns (uint256)"),
  parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
];

/**
 * The staking contract address, or null when staking is not live here.
 *
 * Env-driven and dormant by default: the contract is not deployed and has no
 * entry in the merd.ts address book, so there is deliberately nothing to point
 * at until an operator sets MERD_STAKING_ADDRESS after launch.
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
  /** Realised growth of one share since inception, percent. Never a projection. */
  growthSinceLaunchPct?: number;
  /** A staker's current MERD claim (everything compounded in), when address given. */
  yourStakedMerd?: number;
  yourShares?: string;
}

/**
 * The public + per-wallet staking read. Returns { enabled: false } while dormant,
 * so a caller never has to special-case a missing contract, and the card simply
 * does not render.
 */
export async function stakingState(address?: string): Promise<StakingState> {
  if (address && !ADDRESS_RE.test(address)) throw new Error("invalid address");
  const vault = stakingAddress();
  if (!stakingEnabled() || !vault) return { enabled: false };

  const client = getPublicClient();
  const [totalAssets, sharePrice] = await Promise.all([
    client.readContract({ address: vault, abi: stakingAbi, functionName: "totalAssets" }),
    client.readContract({ address: vault, abi: stakingAbi, functionName: "sharePrice" }),
  ]);

  const out: StakingState = {
    enabled: true,
    totalStakedMerd: Number(formatUnits(totalAssets, 18)),
    // sharePrice starts at exactly 1e18 and only rises, so (price - 1) is the
    // realised return of a share held since inception. This is history, not a
    // forecast, which is the only honest thing to show for a rate-free vault.
    growthSinceLaunchPct: Number(((sharePrice - ONE) * 10_000n) / ONE) / 100,
  };

  if (address) {
    const owner = address as Address;
    const [staked, shares] = await Promise.all([
      client.readContract({ address: vault, abi: stakingAbi, functionName: "stakedBalanceOf", args: [owner] }),
      client.readContract({ address: vault, abi: stakingAbi, functionName: "sharesOf", args: [owner] }),
    ]);
    out.yourStakedMerd = Number(formatUnits(staked, 18));
    out.yourShares = shares.toString();
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
 * Build the unsigned steps to stake `amountMerd` (human units). Approves the
 * vault for MERD if needed, then stakes. The user signs both. Refuses if the
 * wallet does not hold the amount, so no step is built that would revert.
 */
export async function prepareStake(params: { address: string; amountMerd: number; direction: "stake" | "unstake" }): Promise<Record<string, unknown>> {
  const { address, direction } = params;
  if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
  const vault = stakingAddress();
  if (!stakingEnabled() || !vault) throw new Error("staking is not live yet");
  const merd = merdTokenAddress() ?? MERD_ADDRESS;
  const owner = address as Address;
  const client = getPublicClient();

  if (direction === "unstake") {
    const shares = await client.readContract({ address: vault, abi: stakingAbi, functionName: "sharesOf", args: [owner] });
    if (shares === 0n) throw new Error("no staked position to unstake");
    const payout = await client.readContract({ address: vault, abi: stakingAbi, functionName: "previewUnstake", args: [shares] });
    return {
      ok: true,
      kind: "staking",
      chainId: 4663,
      direction,
      complete: true,
      amountOutMerd: Number(formatUnits(payout, 18)),
      steps: [
        {
          kind: "unstake",
          description: "Unstake your full position and everything it compounded",
          to: vault,
          data: encodeFunctionData({ abi: stakingAbi, functionName: "unstakeAll" }),
          value: "0",
        },
      ],
      note: "Unstakes the whole position at the current share price, including all growth funded into it. No fee, no lockup.",
    };
  }

  const amountWei = BigInt(Math.round(params.amountMerd * 1e6)) * 10n ** 12n; // 6dp of precision, scaled to 18
  // MeridianStaking enforces MIN_STAKE = 1e18 (one whole MERD). Refuse below it
  // here rather than hand the user a transaction that reverts on-chain.
  if (amountWei < ONE) throw new Error("the minimum stake is 1 MERD");
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
    note: "Staking mints you shares of the pot. You earn as buybacks and platform revenue fund it; there is no fixed rate and no lockup, and your claim only grows.",
  };
}
