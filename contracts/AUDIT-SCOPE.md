# Meridian — external audit scope

Prepared 2026-08-26. This brief is for an independent third-party audit of the
Meridian seat/agent and launch-router contracts. An internal adversarial review
was run first and its findings are already fixed (see below); that pass sharpens
the code but **does not replace** this external audit, which remains a hard
invariant before any public mint, any router arming, or any user capital sitting
in these contracts.

## Chain and toolchain

- **Robinhood Chain**, chainId `4663`. Sequencer-ordered L2 (relevant to the
  raffle entropy assumption below).
- Foundry, `solc 0.8.26`. `forge test` currently: **244 passing**.
- All contracts are **UNAUDITED and UNDEPLOYED**. Nothing here touches the live
  LP desk, which runs in a separate process with a separate key.

## Contracts in scope

| Contract | Lines | Role |
|---|---|---|
| `MerdSeat.sol` | 521 | ERC-721 "The Meridians" (1,000 seats): mint ladder, holder rung, commit-arm-reveal raffle for 20 engine seats, ERC-2981, an on-chain registry entry per seat. |
| `SeatAccount.sol` | 146 | ERC-6551 token-bound account per seat; `owner()` reads through to `ownerOf`, gates `execute()`. |
| `AgentTreasury.sol` | 331 | Per-seat bounded treasury the seat's account controls; agent role, withdraw limits. |
| `MeridianLaunchSplitter.sol` | 220 | Immutable per-launch 80/20 fee splitter + CREATE2 factory with `isSplitter` provenance. Set as a PONS v2 launch's `creatorFeeRecipient`. |

Backend context (not Solidity, but part of the trust boundary): the launch
registry (`agent/src/launch/registry.ts`) and the engine access gate
(`agent/src/engine/access.ts`) read these contracts. The gate fails closed; the
registry establishes splitter identity by on-chain provenance, not self-report.

## External addresses these contracts depend on

- MERD token (live): `0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8`.
  **OPEN OPERATOR ITEM:** an older reference (`0x4663…Ccef`) exists in one
  backend file; all live evidence points to `0x12f8…`, and deploy scripts pin
  `0x12f8…`. Confirm before baking into constructor args.
- Treasury (receives upper mint tiers, royalties, router share):
  `0x475C1fe4d1e7A703eaca6141978b04010e410Bf4`.
- PONS v2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`; FeeEscrow
  `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` (verified via Blockscout).

## Trust model / assumptions to weigh

- **Owner (operator) is trusted but bounded.** Owner can set mint prices, open/
  close mint, lower (never raise) max supply above the free-tranche floor,
  commit the raffle salt, set royalty bps under an immutable ceiling, and hand-
  mint seats. Owner hand-mints are recorded for supply but are **not** raffle-
  eligible.
- **Raffle entropy trusts the sequencer, not the operator.** The seed is
  `keccak(salt, blockhash(armedBlock), poolSize)` where `armedBlock` is a future
  block fixed at arm time, before the salt is revealed. The operator cannot
  grind it; only the producer of `armedBlock` (the chain sequencer) could bias
  its hash. Whether that residual is acceptable is a judgment call we want the
  auditor to weigh; a VRF alternative was considered and rejected for lack of a
  trustworthy oracle on this chain.
- **MERD has no transfer hook** (verified) and is immutable in `MerdSeat`. Some
  defense-in-depth (CEI ordering in `mintPaid`) assumes this could change.

## Invariants we assert (please try to break)

1. Free holder-rung mints are globally capped at `FREE_TRANCHE` (250) and can
   never starve the paid ladder; `maxSupply` can never drop below it.
2. The paid ladder charges strictly by prior count per wallet (3 burn, 1 tier-2,
   rest tier-3) and routes burns to `0xdEaD`, tiers to the treasury.
3. The raffle draws exactly `ENGINE_SEATS` (20) unique seats over **public
   mints only**; the winning set is unknowable during mint and un-grindable at
   reveal.
4. `hasEngineSeat(addr)` is true iff the address holds a drawn seat; the trait
   moves with the seat on transfer and never duplicates or lapses.
5. A launch's fee recipient is accepted by the registry **iff** our factory
   deployed it (`isSplitter`), never on the recipient's self-reported getters.
6. The splitter always pays the treasury its `ROUTER_BPS` (20%) share and cannot
   be bricked by a hostile team or a non-standard quote token.
7. Selling a seat sells everything under it (account, treasury, engine trait);
   no path detaches an account from its NFT except the documented self-freeze.

## Internal findings — all fixed before this audit

17 findings from the internal adversarial pass, all addressed (commits
`04bfea6`, `c4c4f92`, `10ea4c7`):

- **High** — raffle pool-stuffing + forced sellout (draw now public-only,
  arm-then-reveal with future-block entropy); router splitter forgery (factory
  `isSplitter` provenance, registry verifies on-chain).
- **Medium** — reveal-block grinding (fixed with the arm step); reverting-team
  bricking the native split (independent legs + `owedNative` pull); no-bool
  ERC20 bricking the split (SafeERC20-style calls).
- **Low** — fee-on-transfer over-draw (balance re-read); logo route `nosniff`;
  stake-bar env validation; mint `amountMax` slippage cap.
- **Note** — `lowerMaxSupply` free-tranche floor; `mintPaid` CEI ordering;
  `getApproved` ERC-721 conformance; factory escrow-zero guard; native/USDG
  position visibility.

## Accepted limitations (documented, not fixed)

- **Self-freeze:** a holder can `transferFrom` a seat into its own token-bound
  account and permanently freeze it. Self-inflicted, no third-party impact,
  acknowledged in `SeatAccount`. UI should route transfers through
  `safeTransferFrom`.
- **Deployment-config:** the SIWE session/nonce HMAC assumes a single replica
  with `MERIDIAN_SESSION_SECRET` set (both true in production). Not a contract
  concern.

## What the internal pass did NOT cover (please prioritize)

`SeatAccount.sol` and `AgentTreasury.sol` were only lightly reviewed internally
(mostly via the self-freeze path). The 6551 account's execution surface, the
treasury's withdraw bounds and agent-role model, and the composition of the two
under a live, fee-accruing seat are the areas we most want independent eyes on.
