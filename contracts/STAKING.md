# MERD staking, in plain language

**Status: draft, unaudited, not deployed.** `MeridianStaking.sol` has unit tests
and no external audit. Nothing described here is live, and no MERD should be
staked into it until it has been reviewed by someone who is not us.

This document is the thing you read before you decide whether to stake. It is
written to survive a sceptical reading, which means it spends more words on what
the contract cannot do than on what it can.

---

## The short version

You send MERD to the vault. The vault records your slice of it. When the
protocol earns money and that money is turned into MERD and sent to the vault,
your slice is now a slice of a bigger pot. You did not have to claim anything,
nothing was printed, and you can withdraw at any moment.

That is the whole mechanism. There is no second token, no lock, no schedule, and
no rate.

**And the part most staking pages leave out: if no revenue arrives, staking pays
you exactly zero.** Not a smaller number. Zero. Today Meridian's revenue is
close to nothing, so the honest expectation for the near term is close to
nothing. The section on where the money comes from gives the actual figures.

---

## What a staker gets

One thing: a proportional claim on a pot of MERD, and that claim grows whenever
the pot grows.

Concretely. Suppose the vault holds 1,000 MERD and you own 10% of it, so your
claim is 100 MERD. Somebody sends 200 MERD of protocol revenue into the vault.
The pot is now 1,200 MERD. You still own 10%. Your claim is now 120 MERD. You
did not sign a transaction, you did not pay gas, and nothing was minted to pay
you. Your 20 MERD came out of the 200 MERD that arrived, in proportion to how
much of the pot was yours.

Two consequences worth stating explicitly, because they are the fair-versus-
unfair questions people actually have:

- **Your share depends on how much you staked, not how long you have been
  staked.** Somebody who staked the same amount as you yesterday earns the same
  as you from revenue that arrives tomorrow, even if you have been in for a
  year. There is no tenure bonus. This is a deliberate simplification: tracking
  time-weighted balances is the part of a staking contract where the bugs live,
  and this vault is small enough to verify because it does not do it.
- **Somebody who stakes after revenue arrives does not get any of it.** They buy
  in at the new, higher price per share, so they are paying for the growth
  rather than receiving it. Your earnings cannot be diluted by anybody joining
  later.

## Where the money comes from

Only from revenue Meridian actually collects, converted to MERD and sent to the
vault. There is no other source, because there cannot be one. The candidate
sources are:

- **Swap fees from MERD's own pool**, collected by `MeridianTreasuryHook`.
- **x402 tool-call payments**, paid in USDG by anyone calling a Meridian tool.
- **Credit-pack purchases**, also USDG.
- **Launch commissions** from tokens launched through the platform.

Now the honest part. **As of today the x402 revenue ledger totals about nine
cents across three payments, and the house trading book is deeply negative.**
The MERD pool is not seeded yet, so swap fees are zero. **And the hook does not
currently route anything at all to this vault**: it splits fees between a
referrer, the in-range liquidity providers, the buyback and the treasury, and
the vault is not one of those destinations. Wiring it in is a separate, future
change to a contract that is not being modified here.

So the correct way to read the current state is: the plumbing that lets revenue
compound exists and is tested. The revenue does not exist yet, and neither does
the pipe that would carry it in. Anybody staking today should assume they are
staking into an empty-handed vault and would be doing it for reasons other than
yield.

## What compounding means here

It means your earnings start earning immediately and by themselves, because they
were never separated from your principal in the first place.

In most staking contracts, rewards accumulate in a second bucket and you have to
call `claim()` and then `stake()` again to put them back to work. Compounding is
something you do, on a schedule, paying gas each time.

Here there is no second bucket and there is no `claim()` function, because there
is nothing to claim. Revenue lands in the same pot your principal is in. The
moment it lands it is part of the pot your percentage applies to, so it is
already working. Compounding is not a feature that was added, it is a
consequence of there being only one pot.

The practical difference: your position grows even if you lose your keys for two
years, and there is no gas cost or optimal-frequency question to think about.

## What the contract cannot do

These are checkable by reading `MeridianStaking.sol`, which is short on purpose.
It has no owner, so none of the following can be done by us, by a multisig, by a
governance vote, or by an upgrade.

- **It cannot stop you withdrawing.** There is no lock, no cooldown, no
  unbonding period, no exit fee and no pause. You can withdraw in the same block
  you deposited. A vault that can trap funds is a vault you have to trust, and
  the point of this design is that you do not.
- **It cannot send your MERD anywhere except back to you.** There is no
  recipient argument on any function. The only token transfer out of the
  contract sends to `msg.sender`, in exchange for burning that caller's own
  shares. There is no sweep, no rescue and no emergency withdraw.
- **It cannot be changed.** No owner, no admin, no proxy, no upgrade path, no
  setter for any parameter. The token address is fixed at deployment. Nothing
  about it can be different tomorrow.
- **It cannot print MERD.** MERD itself has no mint function and no owner, so
  emissions are not a design we rejected, they are unavailable. Every wei this
  vault ever pays out is a wei somebody sent in.
- **It cannot promise you a return.** There is no rate field, no reward-per-
  second, no APR, no APY and no projection anywhere in the code or in this
  document. What the contract exposes is `sharePrice()`, which is the historical
  fact of what one share is worth right now, plus an event on every deposit,
  withdrawal and funding so anyone can reconstruct what the vault actually paid
  over any past window. Backward-looking and checkable, instead of
  forward-looking and asserted.
- **It cannot depend on anything else breaking.** It holds one token and calls
  no other contract. Your ability to withdraw does not depend on a pool having
  liquidity, an oracle being live, a router being funded, or any part of
  Meridian still running.

## The known hazard, and how it is handled

Because the pot is measured as the vault's plain token balance, anybody can
increase it by sending MERD to the address. That is what makes funding trivial,
and it is also the classic attack on this kind of vault: be the first depositor
with 1 wei, then transfer in a large amount so that one share costs more than
the next person's entire deposit, and their share count rounds down to zero
while their MERD stays in the pot.

The defence is virtual shares. The vault does its arithmetic as though it always
contains one extra wei backing a trillion shares that nobody holds. An attacker
who deposits 1 wei therefore owns about half of the pot instead of all of it, so
half of anything they donate is permanently unrecoverable, held by shares that
belong to no one.

Two numbers fall out of that, and both are in the tests:

- To round a victim's deposit down to zero, the attacker must donate roughly a
  trillion times that deposit. For any deposit worth caring about, that exceeds
  the entire supply of MERD. It is not affordable.
- Short of that, the most an attacker can shave off a victim is one share's
  worth of rounding, and doing so costs the attacker about a trillion times what
  the victim loses. In the test where an attacker donates 10,000 MERD, the
  victim recovers their deposit to within a millionth of a percent and the
  attacker is down roughly 5,000 MERD.

The price of this defence, paid by everybody: because the vault behaves as
though it holds one extra wei that nobody can withdraw, a withdrawal can round
down by at most 1 wei of MERD, which is 0.000000000000000001 MERD. That wei
stays in the pot and belongs to whoever is still staked. It is not a fee and
nobody receives it.

## There is a minimum stake, and why

The smallest position the vault accepts is one whole MERD.

This is not a tier or a gate on who gets to participate, it closes a specific
hole. The vault behaves as though it holds a tiny amount that nobody owns, which
is what stops a large donation from rounding a later depositor down to nothing.
The side effect is that a position of one wei, staked while the vault is empty,
would have owned about half of it, and the next payment of revenue would have
handed half of itself to someone who risked a wei. A floor makes the position
cost something real, and at that point the holder is simply a staker earning
their proportional share, which is the whole idea.

## Rounding, stated once

Every division in the contract rounds down, and down always means in favour of
the pot and against whoever is transacting. Depositing gives you the floor of
the shares you are owed. Withdrawing gives you the floor of the assets you are
owed. The property this buys is that a sequence of deposits and withdrawals
cannot take out more than was put in, because every step leaves any remainder
behind for the other stakers. The fuzz test covers this over randomised amounts
through a fixed sequence of two stakers and one funding, not over randomised
orderings, so read it as evidence rather than as proof of every possible path.

## Two ways revenue arrives

- A plain ERC-20 transfer of MERD to the vault address.
- Calling `fund(amount)`, which pulls the MERD and emits a `Funded` event.

While anyone is staked the two do the same thing: both raise the value of every
existing share by the same amount and neither mints a share. `fund()` exists so
that funding is a named, attributable, indexable event instead of an anonymous
transfer an auditor has to infer. Use it for anything routing real revenue.

They differ in exactly one case, and it is the case where money is destroyed.
`fund()` refuses to run when nobody is staked, because there would be nobody for
the money to belong to. A plain transfer into that same empty vault does NOT
revert: it succeeds, and the MERD is stranded behind the virtual shares where no
one can ever withdraw it. So a plain transfer is convenient and `fund()` is
safe, and revenue routing should use `fund()` for that reason alone.

## The one function other Meridian code depends on

`stakedBalanceOf(address)` returns that wallet's MERD claim, including everything
compounded into it so far. The agent access gate in
`agent/src/deploy/tokenGate.ts` calls exactly that signature and compares the
result against a basis-point threshold of MERD's live supply. It must return the
compounded claim rather than the original deposit, otherwise a staker whose
position grew past the threshold would still be locked out of their own agent.
There is a test that pins the selector for exactly this reason.

## What is not built yet

- Nothing routes protocol revenue into this vault. `MeridianTreasuryHook` has no
  staking share, and there is no contract that converts USDG revenue into MERD
  and funds the vault. Until one of those exists, the vault's pot only grows if
  somebody funds it by hand.
- No audit.
- No deployment.
