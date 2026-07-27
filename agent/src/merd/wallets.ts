// The project's wallets. There were three roles with three keys; as of
// 2026-07-27, by explicit operator decision, the agent and treasury roles
// share ONE address so that all money moves in and out of a single wallet.
//
//   AGENT+TREASURY  HOT. One wallet signs unattended market-making AND
//                   receives x402 revenue AND holds the MERD supply's fee
//                   switch and seed authority. The operator holds the key and
//                   places it in Railway themselves; it never transits chat or
//                   the repo. What the collapse bought: one address to fund
//                   and watch. What it cost: a host compromise now reaches
//                   the treasury, not just working capital. The spend caps
//                   and the wallet-op breaker in risk.ts are the remaining
//                   blast-radius bound, so do not loosen them casually.
//
//   DEPLOYER       ONE-SHOT. Pays gas for the token deployment and nothing
//                  else. Still separate on purpose: the once-ever permanent
//                  action does not ride the always-on key.
//
// The deployer is nearly powerless by design: the token goes out through the
// CREATE2 proxy, so the deploying wallet is NOT an input to the resulting
// address (any wallet produces the same MERD address), and the token has no
// owner, so nothing accrues to the deployer afterwards.
//
// Restoring the split design later means: generate a fresh hot key, point
// MERD_AGENT_WALLET at its address, move working capital there, and swap
// AGENT_SIGNER_PRIVATE_KEY. The boot assert in venues/signer.ts follows this
// file either way.
import type { Address } from "viem";

/**
 * x402 revenue in, 1,000,000,000 MERD held, and the hook's one-way fee switch.
 *
 * Changed on 2026-07-26 from 0x475C1f to this address, so custody of the funds
 * sits directly with a key the operator holds rather than one generated here.
 * Every contract address in the launch is a function of this value — it is a
 * constructor argument to the token, the hook and the lock — so the change
 * re-mined all four addresses, including MERD's 0x4663 prefix.
 */
export const TREASURY_WALLET: Address = "0x7037b347B21D5e72452dA1445FB1f01D652d40CC";

/**
 * Treasury from 2026-07-26 to 2026-07-27, superseded when the operator chose
 * a fresh wallet for the single-wallet model. STILL HELD 0.45 ETH at
 * retirement; those funds must be moved to the live treasury by the operator
 * (only they hold this key).
 */
export const PREVIOUS_TREASURY_WALLET_2: Address = "0x759DD0DF4dcd3DE442F544c35f3296F5eB5dFF81";

/**
 * One wallet for the agent and the treasury alike: the 2026-07-27 single
 * wallet decision. The engine's signer key must derive to this address, and
 * venues/signer.ts refuses to boot otherwise.
 */
export const MERD_AGENT_WALLET: Address = TREASURY_WALLET;

/**
 * The hot agent wallet this replaced (2026-07-23 to 2026-07-27): generated
 * locally, key lived only in Railway, retired empty the day the roles
 * collapsed. Recorded so its appearance in old executions reads as history,
 * not as live infrastructure.
 */
export const PREVIOUS_AGENT_WALLET: Address = "0xB849aa20b21C015e8F5118Dcf4b631366C2e87bB";

/**
 * The treasury this project used until 2026-07-26, superseded by the address
 * above. Holds 0.01 ETH and has never signed anything. Kept here, and in
 * config.ts's retired list, so a stale MERIDIAN_TREASURY_ADDRESS is caught at
 * startup rather than quietly collecting revenue into it.
 */
export const PREVIOUS_TREASURY_WALLET: Address = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";

/** Generated for the deployment; key lives only in agent/.env at mode 600. */
export const DEPLOYER_WALLET: Address = "0x336e91AE16AC31b4DF4AecA51ba8A0c2B5C82b8a";

/**
 * Retired. Rotated out on 2026-07-23 and still holding ~0.0101 ETH, with its
 * key in agent/.env.bak-prerotate-202607231416 on disk. Recorded so it is not
 * mistaken for live infrastructure — it is the only wallet in the project with
 * any transaction history, which makes it easy to misread as the active one.
 */
export const RETIRED_WALLET: Address = "0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c";

/**
 * Live roles. Agent and treasury deliberately share one address since
 * 2026-07-27; the deployer must stay distinct from both.
 */
export const WALLET_ROLES = {
  agent: MERD_AGENT_WALLET,
  treasury: TREASURY_WALLET,
  deployer: DEPLOYER_WALLET,
} as const;
