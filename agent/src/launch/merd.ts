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
import { V4_POOL_MANAGER, NATIVE_ETH, MERD_POOL_FEE, MERD_POOL_TICK_SPACING, type PoolKey } from "./v4Pool.js";

/**
 * The address was mined to begin 0x4663 — Robinhood Chain's chain id — so the
 * token's own address says which chain it is native to. Chosen over the usual
 * dead/beef/cafe patterns because it means something.
 *
 * Note "MERD" itself is unspellable in an address: hex is 0-9 and a-f, and
 * neither M nor R exists in that alphabet at any mining cost. The symbol is
 * what wallets display; the address only ever carries the chain id.
 */
export const MERD_SALT: Hex = "0x0000000000000000000000000000000000000000000000000000000000051c4d"; // 334925

/** Where MERD lands. Deterministic, and verified before any broadcast. */
export const MERD_ADDRESS: Address = "0x4663b8F879484A671B98320808142a722FC7e703";

/**
 * Receives the entire supply, and separately receives x402 revenue. One
 * treasury doing both jobs, by design.
 *
 * Deliberately NOT a wallet whose key we hold. Merd's key is hot — he signs
 * unattended — and a compromise of it must not also be a compromise of the
 * supply or the revenue. deployToken() refuses outright if the treasury is ever
 * the deploying key.
 */
export const MERD_TREASURY: Address = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";

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
  // treasury keeps the remaining 80%
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
 * The cold treasury rather than Merd's hot key, and the asymmetry is the reason.
 * Needing to pull this switch within minutes is a remote scenario — it exists
 * for a bug that makes the pool too expensive to trade, and the pool keeps
 * trading either way. A compromised hot key permanently zeroing our revenue is
 * the ordinary one. Between a slow remedy and a fast catastrophe, take the slow
 * remedy; transferOwnership() is there if that trade ever stops making sense.
 */
export const MERD_HOOK_OWNER: Address = MERD_TREASURY;

/**
 * The hook, fully specified. Every field is in the init code, so this object IS
 * the address — change one basis point and the hook lands somewhere else.
 */
export const MERD_HOOK: HookDeployment = {
  poolManager: V4_POOL_MANAGER,
  treasury: MERD_TREASURY,
  owner: MERD_HOOK_OWNER,
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
export const MERD_HOOK_ADDRESS: Address = "0x9f67875975D518AD71864A7164A1a788411F0044";

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
