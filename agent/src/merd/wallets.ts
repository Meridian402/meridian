// The project's wallets. The roles split again on 2026-08-01, by explicit
// operator decision: custody of the house funds sits with the Meridian agent
// itself, and the engine signs with a separate operator-held key.
//
//   TREASURY       AGENT-CUSTODIED. Receives x402 revenue. The Merd agent's
//                  own runtime holds the key; no server in this repo and no
//                  deployment env ever does. From the backend's point of view
//                  the treasury is receive-only: PaymentGate quotes it as
//                  payTo and verifies transfers into it, and nothing here can
//                  spend from it. What that buys: a host compromise of the
//                  backend cannot reach the revenue. What it costs: the
//                  backend cannot pay FROM the treasury either, so payouts
//                  and gas come from the signer wallet below, which needs its
//                  own float.
//
//   ENGINE SIGNER  HOT. Signs unattended engine operations (market-making,
//                  payouts). The operator holds the key and places it in
//                  Railway themselves; it never transits chat or the repo.
//                  The spend caps and the wallet-op breaker in risk.ts bound
//                  the blast radius, so do not loosen them casually.
//
//   DEPLOYER       ONE-SHOT. Pays gas for contract deployment and nothing
//                  else. The once-ever permanent action does not ride an
//                  always-on key.
import type { Address } from "viem";

/**
 * x402 revenue in. Custody sits with the Meridian agent (its hosted runtime
 * holds the key), restored on 2026-08-01 after a month as an operator-held
 * single wallet. This address was previously the treasury from 2026-07-23 to
 * 2026-07-26, so history shows it in both eras. Receive-only for the backend:
 * nothing in this repo can sign for it.
 */
export const TREASURY_WALLET: Address = "0x475C1fe4d1e7A703eaca6141978b04010e410Bf4";
/**
 * RETIRED 2026-09-04 (operator: "remove the treasury wallet info from the
 * website and never use that wallet again"). Nothing in the engine reads,
 * pays, or displays TREASURY_WALLET any more: the execution wallet holds
 * everything it earns, is the x402 payTo, funds payouts, and is the only
 * wallet the site shows. The constant stays for history and the config
 * guard, which now refuses it as retired. The PONS locker still pays MERD
 * creator fees to it at the contract level; sweeping those is the
 * operator's hand action.
 */
export const RETIRED_TREASURY_WALLET_2026_09_04: Address = TREASURY_WALLET;
/** The house wallet since 2026-09-04: the execution wallet holds, earns, pays, and is shown. */
export const HOUSE_WALLET: Address = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe";

/**
 * The engine's signing wallet, rotated 2026-08-03. venues/signer.ts refuses to
 * boot if AGENT_SIGNER_PRIVATE_KEY derives to anything else.
 *
 * This is the treasury's EXECUTION wallet: the treasury itself sits behind
 * Privy and can only transfer, as a safeguard, so this wallet does the
 * signing the engine needs (LP mints, re-centers, collects, payouts) and
 * holds only the float the treasury pushes to it. A compromise of this key
 * loses the float, never the treasury.
 */
export const ENGINE_SIGNER_WALLET: Address = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe";

/**
 * Engine signer 2026-08-01 to 2026-08-03, and treasury 2026-07-27 to
 * 2026-08-01 before that (the single-wallet era). Superseded by the execution
 * wallet above; retired holding ~$0.90 of gas ETH. Recorded so its appearance
 * in executions and the published track record reads as history.
 */
export const PREVIOUS_ENGINE_SIGNER_WALLET: Address = "0x7037b347B21D5e72452dA1445FB1f01D652d40CC";

/**
 * Treasury from 2026-07-26 to 2026-07-27, superseded in the single-wallet
 * rotation. STILL HELD 0.45 ETH at retirement; those funds move only by the
 * operator's hand (only they hold this key).
 */
export const PREVIOUS_TREASURY_WALLET_2: Address = "0x759DD0DF4dcd3DE442F544c35f3296F5eB5dFF81";

/**
 * The hot agent wallet used 2026-07-23 to 2026-07-27: generated locally, key
 * lived only in Railway, retired empty the day the roles collapsed into one
 * wallet. Recorded so its appearance in old executions reads as history, not
 * as live infrastructure.
 */
export const PREVIOUS_AGENT_WALLET: Address = "0xB849aa20b21C015e8F5118Dcf4b631366C2e87bB";

/** Generated for the deployment; key lives only in agent/.env at mode 600. */
export const DEPLOYER_WALLET: Address = "0x336e91AE16AC31b4DF4AecA51ba8A0c2B5C82b8a";

/**
 * Retired. Rotated out on 2026-07-23 and still holding ~0.0101 ETH, with its
 * key in agent/.env.bak-prerotate-202607231416 on disk. Recorded so it is not
 * mistaken for live infrastructure.
 */
export const RETIRED_WALLET: Address = "0x76a4fF023Faa6Ea3E378d9e6d74Eb6B2676FB38c";

/**
 * Live roles. Treasury, signer and deployer are deliberately three distinct
 * addresses since 2026-08-01; funds custody and signing authority do not
 * share a key.
 */
export const WALLET_ROLES = {
  signer: ENGINE_SIGNER_WALLET,
  treasury: TREASURY_WALLET,
  deployer: DEPLOYER_WALLET,
} as const;
