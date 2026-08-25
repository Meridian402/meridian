# The Meridians — locked specification

## AMENDMENT v2 (operator, 2026-08-26) — supersedes the mint ladder and activation sections below

- **The mint ladder is repriced and extended** (v2.1 adds the holder rung,
  operator 2026-08-26):
  - **Free rung: 1 per wallet, holder-gated, globally capped at 250 seats.**
    Requires holding at least ~$30 of MERD at mint, enforced as an
    owner-repegged MERD amount (`freeMintHoldMerd`), never a price read.
    The 250 cap bounds the wallet-splitting farm (the hold check is
    point-in-time and MERD is movable; per-wallet limits alone are weak).
  - Paid rungs per wallet: mints 1-3 cost $10 each, mint 4 costs $30,
    mint 5 and EVERY mint after costs $100. The free seat does not consume
    a paid slot. No per-wallet cap beyond pricing; 1,000 is the ceiling.
- **Where payments go.** The free rung pays nothing (the hold requirement
  drives MERD demand instead). The $10 tier BURNS MERD to the dead address
  (entry is deflationary). The $30 and $100 tiers PAY THE TREASURY as mint
  revenue.
  Denomination: MERD for all tiers (one asset, one repeg cadence); prices
  remain owner-set MERD amounts re-pegged to dollar targets off-chain, no
  oracle. (ETH for the upper tiers stays an amendable alternative.)
- **v2.2 (operator, 2026-08-26): EXECUTION FOR 20, THE MIND FOR ALL.**
  The operator judged all-seats-execution too many engine keys. The split:
  - **20 EXECUTION SEATS**, raffle-drawn after mint-out (count changes from
    30 to 20). These alone carry the engine's hands: the execution surface
    (open/collect/close), the vault path, and the future bounded autonomous
    executor. On-chain trait assigned by the raffle module; the execution
    gate reads a per-owner view (`hasEngineSeat(address)`) and NOTHING
    weaker. This resolves the raffle-edge open item: the edge IS the engine.
  - **THE OTHER 980 (v2.3): the LP ENGINE SKILL, exclusively.** Every seat
    grants its holder the engine's planning endpoints (plan / positions /
    collect / close, the same one-brain builders the desk runs) for
    integration into their OWN agent: the API computes, their agent signs
    with its own wallet. Implemented as a second gate tier
    (`hasEngineSkill`: any seat, or any execution-tier wallet whose tier
    supersets it). The standalone skill is reachable ONLY through seats.
    Plus the intelligence feed (flow scans, scores, rankings; seat-gated
    MCP data tools). What stays execution-only: everything MERIDIAN runs
    (the engine vault, future bounded autonomy).
  - The activation mechanic stays REMOVED (v2 stands); the mint burn is the
    price of the seat and its intelligence access, not an execution key.
  - Engine execution population: ~230 stake keys + 20 seats + graduated
    launch teams. Exclusivity is arithmetic on every path.
- Everything else below (6551 accounts, AgentTreasury custody, audit-before-
  mint, deployer-key isolation) stands unchanged.


Locked by the operator on 2026-08-15. Changes to this spec are deliberate,
versioned decisions, not drift. Contract state as of this writing: drafted and
tested (102 seat-surface tests green), UNAUDITED, UNDEPLOYED.

## The collection

- **Name**: The Meridians. Symbol `MERIDIAN`. Supply **1,000**, hard cap,
  shrink-only (`lowerMaxSupply`; no raise path exists in bytecode).
- **The product frame**: each Meridian IS its own agent. The NFT owns a real
  on-chain wallet and treasury (ERC-6551 token-bound account + AgentTreasury).
  No accounts at Meridian, no provisioning: selling the NFT sells the whole
  agent, treasury and all.

## The mint ladder

Three per wallet, strict order, enforced on-chain, routes not interchangeable:

1. **Free.** Every wallet's first Meridian.
2. **Discounted, in $MERD, burned** to `0xdEaD`. The discount is the reason to
   hold the token; the burn shrinks supply on every discounted seat.
3. **Outright, in ETH**, to the immutable payout address (the treasury).

Prices are owner-set amounts re-pegged to dollar targets off-chain (no
hardened oracle exists on this chain; reading a thin pool's spot at mint
invites flash-priced payment). Paying out of order or for the free seat is
refused, never repriced or pocketed.

## The thirty engine seats

- Assigned by **raffle after mint-out**: commit hash published before mint
  opens; salt revealed after the 1,000th mint; the 30 derive verifiably from
  salt + a post-sellout blockhash. Nobody, including the operator, can know or
  snipe winners while the mint runs.
- **"Carries Merd's engine" means, at mint** (locked):
  - **Depth 1, the engine's mind**: the live intelligence Merd itself trades
    on (flow scans, markout scores, allocator rankings), gated by a wallet
    signature proving seat ownership plus the on-chain trait.
  - **Depth 2, the engine's hands with the holder signing**: the Meridian
    page renders the engine's live recommendation for that seat's treasury as
    one-click transactions executed through the token-bound account and
    signed by the HOLDER. The engine drives; the human authorizes every move.
  - Both are self-custodial. Meridian holds no keys, runs nothing per-holder,
    and takes no custody at any point.
- **Depth 3, bounded autonomous execution, is the documented UPGRADE PATH,
  not the mint-day promise**: opt-in only, post-audit, the holder names a
  Meridian-operated executor as their AgentTreasury `agent` under per-epoch
  caps, payee allowlists, fireable by the owner at any time, owner withdrawal
  never blocked. Hard requirements before it ships: its own process and its
  own signer (NEVER the desk's, in either direction), caps defaulted small,
  a kill switch, and sober review of the managed-money implications. Because
  the engine discovers active seats from chain state, shipping Depth 3 later
  requires no change to the NFTs.

## Activation and the burn loop

- `activate(id)` burns $MERD to switch a seat's engine access on;
  **activation clears on every transfer**, so each secondary sale burns again.
- Composition with the raffle (REQUIRES a small contract addition before
  deploy): the 30 raffle seats activate **free, forever**. The other 970 may
  buy Depth 1 access by burning the activation fee. The raffle trait stays
  scarce (it alone carries Depth 2 and the Depth 3 path); the other 970 are
  never dead weight; trading feeds the burn.

## Invariants (non-negotiable)

- Deploys sign with the one-shot DEPLOYER key, never the engine signer.
  Contract work runs through forge only, never inside the desk process.
- **External audit before mint.** Token-bound accounts custody real assets
  from day one; the mint does not open on unaudited contracts.
- The live desk's isolation from all of this is proven and stays proven: the
  desk process references these contracts nowhere.

## Build order

1. Raffle module (commit-reveal) + free-activation-for-winners contract change + tests
2. On-chain art/metadata for the 1,000 (three sample works exist: stone, fire, earth)
3. External audit
4. Deploy via DEPLOYER; mint page (wallet connect = mint + manage, nothing else)
5. Mint → sellout → reveal + raffle draw
6. Depth 1 signals feed, then Depth 2 copilot on the Meridian page
7. Depth 3 only after its own review, opt-in
