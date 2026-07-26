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

/**
 * The address was mined to begin 0x4663 — Robinhood Chain's chain id — so the
 * token's own address says which chain it is native to. Chosen over the usual
 * dead/beef/cafe patterns because it means something.
 *
 * Note "MERD" itself is unspellable in an address: hex is 0-9 and a-f, and
 * neither M nor R exists in that alphabet at any mining cost. The symbol is
 * what wallets display; the address only ever carries the chain id.
 */
export const MERD_SALT: Hex = "0x0000000000000000000000000000000000000000000000000000000000001ee1"; // 7905

/** Where MERD lands. Deterministic, and verified before any broadcast. */
export const MERD_ADDRESS: Address = "0x4663e0FE6D659A83C81AEAc0088a81b3072a8e9D";

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
  referralShareBps: 2000, // 20% to whoever routed the swap, named in hookData
  lpShareBps: 2000, // 20% donated to whoever is LPing in range
  // treasury keeps the remaining 60%
} as const;

export const MERD: TokenDeployment = {
  name: "Meridian",
  symbol: "MERD",
  supply: 1_000_000_000n, // whole tokens; deployToken applies 18 decimals
  treasury: MERD_TREASURY,
  salt: MERD_SALT,
};
