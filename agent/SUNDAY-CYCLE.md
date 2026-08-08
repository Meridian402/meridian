# Merd's Sunday cycle

Every Sunday, Merd pays his marketing team and buys back and burns MERD, on
the same day, from the same revenue. One date, two promises kept, both
checkable by anyone.

This is the runbook. It is written for Merd to follow.

## The policy

Of the revenue that has landed in the treasury:

- **25%** to the marketing team.
- **25%** to buy MERD on the open market, then burn it.
- **The rest stays** in the treasury: desk capital and gas.

The remainder is not idle money, it is the earning base. Growing it is what
makes every future Sunday bigger.

## The addresses

| What | Address |
| --- | --- |
| Treasury (pays) | `0x475C1fe4d1e7A703eaca6141978b04010e410Bf4` |
| Marketing team | `0x4a938d9EBe462097f1466D5267c3FF643EA363Ad` |
| MERD token | `0x12f8Cca1875B6CdfaF00f7Efde52A40C275Ab8d8` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| MERD/WETH pool (1%) | `0xBFaC28D6B6A258f442639CF20864f655116D57a6` |
| Swap router | `0xD089eBB5609Dd1FE604E1f8ecd9B88Bd5d128713` |
| Burn address | `0x000000000000000000000000000000000000dEaD` |

## The steps

Run `_merd-cycle.mts` first. It reads the treasury, computes the 25% slice,
reads the live pool price, and prints every transaction with a slippage
floor already calculated. Never hand-write these amounts.

1. **Unwrap** the marketing slice of WETH into native ETH.
2. **Pay the marketing team** in native ETH, not WETH. Their wallet holds no
   gas, so WETH would arrive unusable.
3. **Approve** the router for the buyback slice.
4. **Buy MERD in three chunks**, each with its own minimum-out floor. Our own
   buying moves this market; three smaller buys cost less than one large one.
5. **Burn** every MERD bought this cycle by transferring it to the dead
   address. Read the exact amount received from the swap receipts. Do not
   round, do not estimate, do not burn tokens the treasury already held.

## After the transactions land

6. **Verify on-chain.** Read each transaction back and confirm: the marketing
   amount, the MERD received, the burn amount, and the new dead-address
   balance. If a number in the announcement does not match a receipt, the
   announcement is wrong and does not go out.
7. **Publish the cycle** on the site, next to the revenue chart, with the
   transaction links.
8. **Then announce it.** Never before. The post is short, states what was
   paid and what was burned, and links all of it. No projections, no yield
   language, no promises about future cycles.

## The rules that do not bend

- **Nothing is announced before it has landed.** A promise costs credibility
  that a receipt earns.
- **No market order without a floor.** A minimum-out of zero in a thin pool
  is an invitation, and Merd's desk learned that lesson with its own money.
- **Never pre-announce a specific buy.** Saying what will be bought before
  buying it is how a market front-runs you.
- **If revenue was small this week, the cycle is small.** Do not skip it, do
  not top it up from the desk's capital, do not make it look bigger than it
  was. A small honest cycle beats a big invented one.
- **If a transaction fails,** stop, say so plainly, and fix it before
  continuing. A half-finished cycle is announced as a half-finished cycle.

## What to say, roughly

Merd writes it in his own voice, but the shape is always: what came in, what
went out, what was burned, and the links. Something like:

> sunday. paid the marketing team their 25%, bought merd with another 25%
> and burned all of it. total burned is now X. receipts below.

That is the whole job. The numbers do the talking.
