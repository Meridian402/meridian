# MERD staking, in plain language

**Status: draft, unaudited, not deployed.** `MeridianStakingRewards.sol` has
unit tests and no external audit. Nothing described here is live, and no MERD
should be staked into it until it has been reviewed by someone who is not us.

This document is the thing you read before you decide whether to stake. It is
written to survive a sceptical reading, which means it spends more words on what
the contract cannot do than on what it can.

**Which contract this describes.** `MeridianStakingRewards.sol`, the live
design. There is a second, superseded contract in this repo,
`MeridianStaking.sol`, which auto-compounds MERD into MERD and has no claim
step. It is kept for reference and is not the one being deployed. If you are
comparing the two: the one you want pays USDG.

---

## The short version

You stake MERD. Your staked amount does not change. When the platform earns
revenue, 20% of it is sent to this contract in USDG and split across everyone
staked at that moment, in proportion to their stake. That USDG sits waiting
until you call `claim()`, and claiming does not unstake you.

That is the whole mechanism. There is no second token, no lock, no schedule, and
no rate.

**And the part most staking pages leave out: if no revenue arrives, staking pays
you exactly zero.** Not a smaller number. Zero. Today Meridian's revenue is
close to nothing, so the honest expectation for the near term is close to
nothing. The section on where the money comes from gives the actual figures.

---

## What a staker gets

Two separate balances, and keeping them separate is the point.

- **Your stake**, in MERD. It is exactly what you put in. It does not grow, it
  does not shrink, and nothing in this contract can send it anywhere but back
  to you.
- **Your rewards**, in USDG. This is what accrues, and it is what you claim.

Concretely. Suppose 1,000 MERD is staked in total and you staked 100 of it, so
you hold 10% of the pool. The treasury funds 200 USDG of revenue. You can now
claim 20 USDG. Your stake is still 100 MERD, unchanged. Claim the 20 USDG and
you are still staked, still holding 10%, and still earning on the next funding.

The difference from a compounding vault: your earnings do not go back to work by
themselves. They arrive in a different token and wait for you. If you want them
compounding you have to convert and stake again yourself, which is a decision
this contract deliberately does not make for you.

## Where the money comes from

Only from revenue Meridian actually collects, sent to this contract as USDG.
There is no other source, because there cannot be one. The candidate sources
are:

- **x402 tool-call payments**, paid in USDG by anyone calling a Meridian tool.
- **Credit-pack purchases**, also USDG.
- **Swap fees from MERD's own pool**, collected by `MeridianTreasuryHook`.
- **Launch commissions** from tokens launched through the platform.

Now the honest part. **As of today the x402 revenue ledger totals about ten
dollars across two payments, and the house trading book is deeply negative.**
The MERD pool is not seeded, so swap fees are zero.

**And nothing routes revenue here automatically.** There is no code in this repo
that calls `fund()`. The 20% figure is the operator's stated intent, not
something the contract enforces or a schedule anything executes: today it would
be a person deciding to send USDG. Until that is automated, treat the share as a
policy that can change rather than a property of the code.

So the correct way to read the current state is: the plumbing that distributes
revenue exists and is tested. The revenue barely exists, and the pipe that would
carry it in automatically does not exist at all. Anybody staking today should
assume they are staking into an empty pot and would be doing it for reasons
other than yield.

## What the contract cannot do

These are checkable by reading `MeridianStakingRewards.sol`, which is 174 lines
on purpose. It has no owner, so none of the following can be done by us, by a
multisig, by a governance vote, or by an upgrade.

- **It cannot stop you withdrawing.** There is no lock, no cooldown, no
  unbonding period, no exit fee and no pause. You can unstake in the same block
  you staked. A contract that can trap funds is one you have to trust, and the
  point of this design is that you do not.
- **It cannot send your MERD anywhere except back to you.** There is no
  recipient argument on any function. Every transfer out goes to `msg.sender`.
  There is no sweep, no rescue and no emergency withdraw.
- **It cannot be changed.** No owner, no admin, no proxy, no upgrade path, no
  setter for any parameter. Both token addresses are fixed at deployment.
- **It cannot print MERD.** MERD itself has no mint function and no owner, so
  emissions are not a design we rejected, they are unavailable. Every unit this
  contract pays out is a unit somebody sent in.
- **It cannot promise you a return.** There is no rate field, no reward-per-
  second, no APR, no APY, and no view that annualises anything. What it exposes
  is `earned(address)`, which is the historical fact of what you have already
  accrued, plus an event on every stake, unstake, claim and funding so anyone
  can reconstruct what was actually paid over any past window. Backward-looking
  and checkable, instead of forward-looking and asserted.
- **It cannot take your rewards away.** Once a funding is distributed, your
  share of it is settled into a stored balance that only you can move.

## Why staking after a funding does not steal from it

The accounting is the standard cumulative-per-share pattern. A running total,
`accUsdgPerShare`, rises on every funding by the amount divided across
everything staked at that instant. Each account remembers the value of that
total when it last touched the contract.

Every path that changes anything settles first: it banks what you earned at your
OLD stake, then changes the stake. That gives two properties worth stating
plainly. Staking one second after a funding earns you nothing from it, because
the running total already moved before you arrived. And an existing staker
cannot lose a past distribution by staking more, because theirs was banked
before the change.

## Funding with nobody staked reverts

`fund()` refuses to run when `totalStaked` is zero, rather than accepting USDG
that no one could ever claim. The treasury simply funds once there is somebody
to pay.

`fund()` is also permissionless: anyone may add to the pot. That is deliberate,
and it costs nothing, because the only thing you can do with it is give money
away to stakers.

Note the asymmetry with the superseded vault: because rewards here are tracked
by an internal counter rather than by the contract's token balance, sending USDG
to this address with a plain transfer does **not** distribute it. It sits there,
credited to nobody, and no one can claim it. Use `fund()`.

## There is a minimum stake, and why

The smallest position the contract accepts is one whole MERD, and you cannot
leave a remainder below that: either exit fully or stay at or above the floor.

The floor keeps positions economically real. The no-dust rule closes a smaller
hole: a remainder below the minimum would be a stuck position, unable to top up
without tripping the same rule that created it.

## Rounding, stated once

Division rounds down. A funding raises the per-share total by
`amount * 1e30 / totalStaked`, and the truncated remainder stays in the contract
credited to nobody. The `1e30` scaling exists because the reward token has 6
decimals while the stake has 18, so without it a small funding over a large pool
would round to zero per share.

**Being straight about the consequence:** that truncated remainder is
unrecoverable. There is no sweep, so it is stranded. At realistic sizes it is a
sub-cent amount and it is the price of not having an owner who could rescue it.
It is not a fee and nobody receives it.

## Known limitations, unresolved

Stated rather than buried, because this contract is unaudited and you should
know where to look hardest.

- **`fund()` moves the tokens before it updates the counter.** The file's header
  claims checks-effects-interactions on every path; on that one path the order
  is reversed. It is not exploitable with a plain ERC-20 like USDG, which has no
  transfer callback, but the stated invariant is not true as written and an
  audit should decide whether to reorder it.
- **Transfers are assumed to return a boolean.** `_pull` and `_send` revert if a
  transfer returns false, which also means they revert against any token that
  returns nothing at all. That is fine if USDG behaves like a standard ERC-20
  and bricks claiming if it does not. Confirm the token's actual return
  convention before deploying against it.
- **No external audit.** Unit tests are not an audit.
- **Not deployed**, and no address is pinned anywhere.

## What other Meridian code depends on

The backend reads `stakedOf(address)` and `earned(address)`, and calls `stake`,
`unstake`, `claim` and `exit` through `agent/src/earn/staking.ts`. That surface
is dormant until a deployed address is configured.

Note for anyone reading the superseded contract: `MeridianStaking.sol` carries a
comment calling `stakedBalanceOf(address)` load-bearing for an agent access
gate. That gate has since been removed, and this contract has no such function.
The comment describes a world that no longer exists.
