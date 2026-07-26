// The project's wallets, and why there are three rather than one.
//
// Each role has a different exposure, so they get different keys. Collapsing
// any two of them means a single compromise costs more than it has to.
//
//   MERD (agent)   HOT. Signs unattended, market-makes, holds working capital.
//                  We hold this key because the agent cannot ask permission at
//                  three in the morning. Blast radius is bounded by the spend
//                  caps and the per-wallet op limits, not by trust.
//
//   TREASURY       COLD. Receives x402 revenue AND holds the entire MERD supply.
//                  We deliberately do NOT hold this key. It signs nothing, so it
//                  needs no key on any machine that runs the agent.
//
//   DEPLOYER       ONE-SHOT. Pays gas for the token deployment and nothing else.
//                  Worth separating even though it is nearly powerless, so the
//                  autonomous key is not the one that performs a permanent,
//                  once-ever action.
//
// The deployer is nearly powerless on purpose, and it is worth being precise
// about why: the token goes out through the CREATE2 proxy, so the deploying
// wallet is NOT an input to the resulting address — any wallet produces the
// same MERD address — and the token has no owner, so nothing accrues to the
// deployer afterwards. It buys gas and separation of duties, nothing more.
import type { Address } from "viem";

/** Merd's own wallet. The only one whose key the running agent needs. */
export const MERD_AGENT_WALLET: Address = "0xB849aa20b21C015e8F5118Dcf4b631366C2e87bB";

/** x402 revenue in, 1,000,000,000 MERD held. Signs nothing, ever. */
export const TREASURY_WALLET: Address = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";

/** Generated for the deployment; key lives only in agent/.env at mode 600. */
export const DEPLOYER_WALLET: Address = "0x336e91AE16AC31b4DF4AecA51ba8A0c2B5C82b8a";

/**
 * Retired. Rotated out on 2026-07-23 and still holding ~0.0101 ETH, with its
 * key in agent/.env.bak-prerotate-202607231416 on disk. Recorded so it is not
 * mistaken for live infrastructure — it is the only wallet in the project with
 * any transaction history, which makes it easy to misread as the active one.
 */
export const RETIRED_WALLET: Address = "0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c";

/** Roles that must never collapse onto one address. */
export const WALLET_ROLES = {
  agent: MERD_AGENT_WALLET,
  treasury: TREASURY_WALLET,
  deployer: DEPLOYER_WALLET,
} as const;
