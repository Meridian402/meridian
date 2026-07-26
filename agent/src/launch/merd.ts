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
 * The pool's launch tax, fixed at hook construction and unchangeable after.
 *
 * Opens at 10% each way and reaches 3% fifteen seconds after the FIRST trade.
 * Fifteen seconds is deliberate: block.timestamp moves in whole seconds, so the
 * curve gets fifteen discrete steps of 0.47%, covering roughly 149 blocks at
 * this chain's ~0.101s block time.
 *
 * Be clear-eyed about what that buys. It taxes the opening block and the
 * seconds either side of it, which is exactly where snipers operate and where
 * no ordinary buyer is. It is NOT sustained protection — anyone arriving a
 * minute late pays the 3% floor like everybody else. That is the intended
 * trade: punish the bots, then get out of the way.
 */
export const MERD_FEE_SCHEDULE = {
  buyStartBps: 1000, // 10.00%
  buyEndBps: 300, // 3.00%
  sellStartBps: 1000,
  sellEndBps: 300,
  decaySeconds: 15n,
} as const;

export const MERD: TokenDeployment = {
  name: "Meridian",
  symbol: "MERD",
  supply: 1_000_000_000n, // whole tokens; deployToken applies 18 decimals
  treasury: MERD_TREASURY,
  salt: MERD_SALT,
};
