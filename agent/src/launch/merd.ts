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
export const MERD_SALT: Hex = "0x0000000000000000000000000000000000000000000000000000000000030df3"; // 200179

/** Where MERD lands. Deterministic, and verified before any broadcast. */
export const MERD_ADDRESS: Address = "0x4663E66B70D1de12D8A18BCA44895598096Ddc71";

/**
 * Receives the entire supply at deployment. Deliberately NOT the agent signer:
 * that key is hot and has rotated, and a single compromise of it must not also
 * be a compromise of the whole supply. deployToken() refuses to proceed if the
 * two are ever the same.
 */
export const MERD_TREASURY: Address = "0x759DD0DF4dcd3DE442F544c35f3296F5eB5dFF81";

export const MERD: TokenDeployment = {
  name: "Meridian",
  symbol: "MERD",
  supply: 1_000_000_000n, // whole tokens; deployToken applies 18 decimals
  treasury: MERD_TREASURY,
  salt: MERD_SALT,
};
