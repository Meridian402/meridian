# MERD staking v2: the ladder vault

Drafted 2026-08-26 from the operator's redesign decisions. Status: SPEC ONLY.
No contract exists yet. This supersedes the revenue-share design
(`MeridianStakingRewards.sol`), which itself superseded the compounding vault
(`MeridianStaking.sol`); both stay in the repo for reference.

## The decisions this encodes (operator, 2026-08-26)

1. **The stake is a worker, not a claim ticket.** Staked MERD is deployed as
   one-sided ask liquidity above spot in MERD's own pool (MERD/WETH 1%). The
   pool earns from MERD's own trading volume. No dependence on the desk.
2. **Fully separate books.** The 20% platform revenue share is dropped.
   Merd's treasury keeps 100% of desk and router earnings. Stakers earn what
   their liquidity earns.
3. **Payouts as earned: WETH and MERD.** No swaps inside the contract, ever.

## Mechanism

- `stake(amount)`: MERD in. The vault adds it to the ask ladder: a range
  entirely above current spot in the MERD/WETH pool.
- Buys that trade up through the ladder pay the 1% fee tier and convert some
  ladder MERD into WETH at those higher prices.
- `harvest()`: permissionless crank. Collects position fees (WETH + MERD) and
  sweeps any WETH the ladder realized from conversions. Everything harvested
  distributes to stakers via per-share accumulators (accWethPerShare,
  accMerdPerShare), MasterChef-debt style, exactly like the v1 accumulator.
- `claim()`: pays accrued WETH + MERD without unstaking.
- `unstake(amount)`: returns principal MERD (see the scale rule below).

## The one hard problem, and the chosen solve

Mixed-asset pools normally need a price to mint fair shares (NAV), and any
price read from a thin pool is a manipulation vector. This design removes the
problem instead of solving it:

- **Principal stays denominated in MERD only.** No NAV, no oracle, no TWAP,
  no swap. WETH never counts as principal.
- **Conversions are realized yield, not principal.** When the ladder sells
  MERD into a rising market, the WETH proceeds go to the distributor like
  fees do, and principal shrinks pro-rata via a global `principalScale`
  (a downward-only rebase). `withdrawable(account) = stakedOf * scale`.
- The staker's deal, stated honestly: your MERD principal can only shrink by
  being SOLD ABOVE the price it was staked at, and the sale proceeds arrive
  in your claimable WETH the moment they are realized. Total value is
  preserved at the instant of conversion; what changes is composition.
- Entry fairness falls out for free: a new staker adds MERD at the current
  scale, has zero accumulator debt, and can never claim conversions or fees
  from before their entry.

## The manager, bounded like AgentTreasury

Someone must place and re-place the ladder as price moves. The manager role
(the engine, eventually) is bounded in bytecode:

- CAN: mint/burn the vault's position within the ONE immutable pool key;
  choose tick bounds subject to `lower >= current tick` (ask-side only, so
  the manager can never convert principal by repositioning below spot);
  call harvest.
- CANNOT: withdraw anything to any address, add other pools, touch claims.
  All value exits go through `claim`/`unstake` by the owner of the funds.
- Owner (operator multisig/timelock later): set manager, pause staking
  entries (never exits), nothing else.

## Invariants (audit checklist)

- No function moves assets to any address except: pool (liquidity ops),
  staker claim/unstake, permissionless harvest into the distributor.
- `principalScale` only decreases, and only inside harvest accounting of a
  realized conversion, matched 1:1 by WETH credited to the distributor.
- Manager cannot place liquidity at or below spot (no principal conversion
  by repositioning).
- Unstake is never pausable.
- Contract holds no swap code and reads no prices.

## Knock-on changes when this ships

- Engine gate: `$250-of-MERD` stake path reads this vault's
  `withdrawable(account)` instead of v1 `stakedOf` (env swap + one line).
- Site copy: Access card and STAKING.md rewrite ("your stake works MERD's
  own market") and the revenue-share language comes out everywhere.
- STAKING.md v2 with the same skeptic-proof tone, including: zero volume
  means zero yield; principal can convert to WETH only via sales above your
  entry price; the ladder is not a stable deposit.

## Open items before code

- Ladder placement policy (band width, distance above spot, single band vs
  laddered rungs) and how much idle MERD buffers unstakes without burning
  the position every time.
- Whether `principalScale` floors (e.g. stake pauses when scale < X) or runs
  unbounded.
- Manager cadence and its own anti-churn gates (the desk's payback logic
  applies here too).
