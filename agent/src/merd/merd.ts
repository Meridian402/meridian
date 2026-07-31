// MERD's deployment parameters, fixed.
//
// These are recorded here rather than passed in at the call site because every
// one of them is permanent and public the moment the transaction lands, and
// because the SALT only produces the intended address for this exact set. Any
// change to name, symbol, supply or treasury changes the init code hash, which
// changes the address, which silently voids the salt below. A test asserts the
// address still reproduces, so that goes from a silent surprise to a red build.
import type { Address, Hex } from "viem";
import type { TokenDeployment } from "./deployToken.js";
import type { HookDeployment } from "./deployHook.js";
import type { LockDeployment } from "./deployLock.js";
import {
  V4_POOL_MANAGER,
  V4_POSITION_MANAGER,
  NATIVE_ETH,
  MERD_POOL_FEE,
  MERD_POOL_TICK_SPACING,
  type PoolKey,
} from "./v4Pool.js";

/**
 * The address was mined to begin 0x4663 — Robinhood Chain's chain id — so the
 * token's own address says which chain it is native to. Chosen over the usual
 * dead/beef/cafe patterns because it means something.
 *
 * Note "MERD" itself is unspellable in an address: hex is 0-9 and a-f, and
 * neither M nor R exists in that alphabet at any mining cost. The symbol is
 * what wallets display; the address only ever carries the chain id.
 */
export const MERD_SALT: Hex = "0x0000000000000000000000000000000000000000000000000000000000012e8a"; // 77450

/** Where MERD lands. Deterministic, and verified before any broadcast. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const MERD_ADDRESS: Address = "0x4663196C0Ad93594907555b2018457695Db8Ccef";

/**
 * Receives the entire supply, and separately receives x402 revenue. One
 * treasury doing both jobs, by design.
 *
 * Since the 2026-07-27 single-wallet decision this IS also the hot signing
 * wallet: the operator chose one address for all money in and out, accepting
 * that a compromise of the unattended key reaches the supply authority and
 * the revenue as well. The spend caps and the wallet-op breaker are the
 * remaining bound. deployToken() still refuses outright if the treasury is
 * ever the deploying key.
 *
 * Rotated 2026-07-27 (third rotation; the prior treasuries are recorded in
 * wallets.ts and config.ts's retired list). Every launch address below was
 * re-mined for this value.
 */
export const MERD_TREASURY: Address = "0x7037b347B21D5e72452dA1445FB1f01D652d40CC";

/**
 * The pool's fee schedule, fixed at hook construction and unchangeable after.
 *
 *   phase 1  10% -> 3% over the first 10 minutes   (anti-sniper ramp)
 *   phase 2  flat 3% until 24h from the first swap (a settled, quotable rate)
 *   phase 3  3% -> 1% over the following 24h, then 1% forever
 *
 * The clock starts on the FIRST SWAP, not at deployment, so a gap between
 * deploying and opening the pool cannot burn the protection before anyone can
 * trade.
 *
 * The floor is the number that matters most. It is what a trader compares
 * against every other token forever, long after the launch window is a memory —
 * which is why it settles at 1% rather than staying wherever the launch left it.
 * Meteora's default schedule (50% opening, decaying to 0.25% over two hours)
 * makes the same bet: monetise the launch, then compete on being cheap.
 */
export const MERD_FEE_SCHEDULE = {
  buyLaunchBps: 1000, // 10.00%
  buyPlateauBps: 300, // 3.00%
  buyFloorBps: 100, // 1.00%
  sellLaunchBps: 1000,
  sellPlateauBps: 300,
  sellFloorBps: 100,
  rampSeconds: 600n, // 10 minutes
  plateauUntil: 86_400n, // 24 hours from the first swap
  taperSeconds: 86_400n, // and 24 hours more to reach the floor

  // Shares OF THE FEE, not of the trade. Neither changes what a trader pays;
  // they only decide where our slice lands, which is why they are safe to have
  // in the swap path at all.
  referralShareBps: 1000, // 10% to whoever routed the swap, named in hookData
  lpShareBps: 1000, // 10% donated to whoever is LPing in range
  buybackShareBps: 500, // 5% buys PONS and INDEX on the open market and burns both
  // treasury keeps the remaining 75%
} as const;

export const MERD: TokenDeployment = {
  name: "Meridian",
  symbol: "MERD",
  supply: 1_000_000_000n, // whole tokens; deployToken applies 18 decimals
  treasury: MERD_TREASURY,
  salt: MERD_SALT,
};

/**
 * Holds the hook's one and only authority: disableFeesForever(), which zeroes
 * the fee permanently and can never raise it.
 *
 * Under the split-wallet design this was the cold treasury precisely so a
 * compromised hot key could not zero the fee forever. Since the 2026-07-27
 * single-wallet decision the treasury IS the hot key, so that protection is
 * gone by choice and the switch rides the same key that signs unattended.
 * transferOwnership() exists if the operator ever wants the switch on a cold
 * key again without re-mining anything.
 */
export const MERD_HOOK_OWNER: Address = MERD_TREASURY;

/**
 * The two tokens 5% of every fee is spent buying and burning, and the pools it
 * buys them in. Both verified live before being written down:
 *
 *   PONS   ETH/PONS  2%, spacing 400, no hook     liquidity 2.63e21
 *   INDEX  ETH/INDEX 1%, spacing 200, hook 0x2cD9 liquidity 5.79e22
 *
 * INDEX has NO usable hookless pool — every standard tier is initialized and
 * empty — so its route runs through a third party's hook, which takes its own
 * 3%. That dependency is the whole reason the buying happens in a separate
 * contract instead of inside afterSwap: if their pool drains or their hook
 * reverts, a buyback fails and is retried, rather than every MERD trade
 * reverting forever.
 */
export const BUYBACK_TARGETS = {
  pons: "0x39dBED3a2bd333467115dE45665cC57F813C4571" as Address,
  ponsFee: 20_000,
  ponsSpacing: 400,
  ponsHook: NATIVE_ETH, // hookless
  index: "0x56910D4409F3a0C78C64DD8D0545FF0705389870" as Address,
  indexFee: 10_000,
  indexSpacing: 200,
  indexHook: "0x2cD91bD228ff4c537031d6b8204782090c84c0cC" as Address,
  /** Half the ETH to each. */
  ponsShareBps: 5000,
} as const;

/** Where the buyback lands. Deterministic, and an input to the hook's address. */
export const MERD_BUYBACK_ADDRESS: Address = "0xCC8fA606De11785dbFea8aAE61d3aB98104D5AFC";

/**
 * The hook, fully specified. Every field is in the init code, so this object IS
 * the address — change one basis point and the hook lands somewhere else.
 */
export const MERD_HOOK: HookDeployment = {
  poolManager: V4_POOL_MANAGER,
  treasury: MERD_TREASURY,
  owner: MERD_HOOK_OWNER,
  buyback: MERD_BUYBACK_ADDRESS,
  schedule: MERD_FEE_SCHEDULE,
};

/**
 * Where MERD_HOOK lands, recorded from a mine against the current build.
 *
 * The last four hex digits are not a vanity: 0x0044 is AFTER_SWAP |
 * AFTER_SWAP_RETURNS_DELTA, the exact permissions this hook implements. v4 reads
 * them straight out of the address, which is why the salt had to be mined at all.
 *
 * Not used AS the deploy target — the salt is re-mined at deploy time, because a
 * stored salt goes stale silently when the contract or the compiler settings
 * change. This is the tripwire for that: deployHook refuses to broadcast if the
 * fresh mine disagrees with this line, and a test asserts it on every run.
 */
export const MERD_HOOK_ADDRESS: Address = "0xdF88487623f3613f0a73572f32D72C28557E0044";

/**
 * The lock that will hold MERD's position, fully specified.
 *
 * Both beneficiaries are the treasury, with A taking the whole share: creator
 * and platform are the same party here. The two-address shape stays because it
 * is immutable — a future launch that wants to split fees with its creator uses
 * the same contract, and this one simply points both ends at itself.
 */
export const MERD_LOCK: LockDeployment = {
  positionManager: V4_POSITION_MANAGER,
  currency0: NATIVE_ETH,
  currency1: MERD_ADDRESS,
  beneficiaryA: MERD_TREASURY,
  beneficiaryB: MERD_TREASURY,
  shareABps: 10_000,
};

/**
 * Where MERD_LOCK lands. Deterministic, and needed as a VALUE before the launch
 * transaction can be built at all, because that transaction names it as the
 * position's owner. A test asserts it still reproduces from the current build.
 */
export const MERD_LOCK_ADDRESS: Address = "0xAD12379483FEed042042560e3b1F3C7A5042A92C";

/**
 * What goes into the pool on day one.
 *
 * THE WHOLE SUPPLY, against one ETH. Nothing is held back — no treasury
 * allocation, no team tranche, no vesting cliff, because there is nothing left
 * to allocate. That is the entire argument for this shape: the most common
 * reason a launch dies is the 90% sitting in a treasury that everyone can see
 * and nobody can predict, and this structure does not have one.
 *
 * The price that follows is arithmetic, not a target: with every token in the
 * pool and a full-range position worth the same on both sides, the opening FDV
 * is exactly the ETH seeded. One ETH in means an FDV of one ETH. Price
 * discovery starts at the floor and goes wherever buyers take it.
 *
 * THE COST, stated plainly: at this depth a $500 buy moves the price about 60%.
 * That is not a flaw to be fixed, it is the deal — early buyers are paid for
 * being early, which is what a fair launch is. It is also exactly what a sniper
 * would farm, which is what the 10% opening tax is in the hook to prevent.
 *
 * WHAT THIS MAKES TRUE OF THE LP POSITION: it holds the entire supply. The NFT
 * minted by the launch transaction is, for practical purposes, all of MERD. An
 * unlocked position here is not a risk, it is a rug with extra steps — locking
 * it is not optional, and MeridianPositionLock is what it exists for.
 *
 * SO THE POSITION IS MINTED STRAIGHT INTO THE LOCK. The recipient below is the
 * lock's address, not a wallet, and the supply is never held by a key at any
 * point. The alternative — mint to the treasury, then safeTransferFrom into the
 * lock — leaves a window where a cold wallet holds an NFT worth every token in
 * existence, and closing that window needs a second cold signature that can be
 * delayed, forgotten, or lost. Minting direct has no such window.
 *
 * The cost is one loose end rather than one window: v4's PositionManager mints
 * with _mint and never calls onERC721Received, so the lock will not know its own
 * tokenId until lockExisting() is called with it. That is a fee-collection
 * detail, not a custody one. The NFT is already inside a contract with no
 * transfer function from the moment it is minted, so it cannot go anywhere while
 * we sort it out, and anyone may make the call.
 */
export const MERD_SEED = {
  ethWei: 1_000_000_000_000_000_000n, // 1 ETH
  merdWei: 1_000_000_000n * 10n ** 18n, // the entire supply
  /** The lock, not a wallet. No key ever holds the position. */
  recipient: MERD_LOCK_ADDRESS,
  hook: MERD_HOOK_ADDRESS,
} as const;

/**
 * The pool MERD will trade in. `hooks` is part of the pool's IDENTITY — a pool
 * created with the wrong hook, or with none, is a different pool that can never
 * be given one later, so this defaults to the mined address rather than making
 * the caller remember it.
 *
 * Native ETH is address(0) and always sorts to currency0, which makes MERD
 * currency1 and the price read as MERD per ETH.
 */
export function merdPoolKey(hooks: Address = MERD_HOOK_ADDRESS): PoolKey {
  return {
    currency0: NATIVE_ETH,
    currency1: MERD_ADDRESS,
    fee: MERD_POOL_FEE,
    tickSpacing: MERD_POOL_TICK_SPACING,
    hooks,
  };
}

/**
 * The configured MERD token address, or null when MERD is not live here.
 *
 * This lived in the access gate until that gate was removed. It is token
 * IDENTITY rather than access control, and the only caller left is credit
 * pricing, so it belongs next to MERD_ADDRESS.
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
  // closed and say why. MERD_ADDRESS above is the one place to change.
  if (raw.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    console.error("[merd] MERD_TOKEN_ADDRESS is the zero address, ignoring it and staying dormant");
    return null;
  }
  if (raw.toLowerCase() !== MERD_ADDRESS.toLowerCase()) {
    console.error(
      `[merd] MERD_TOKEN_ADDRESS is ${raw}, which is not MERD (${MERD_ADDRESS}). Staying dormant rather than ` +
        "pricing credits in an unknown token. Update MERD_ADDRESS above if MERD really moved.",
    );
    return null;
  }
  return raw as Address;
}
