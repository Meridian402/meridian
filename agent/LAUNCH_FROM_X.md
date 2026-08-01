# Launch a token from X (custodial)

Someone tweets `@Meridian402 launch $TICKER Your Token Name 0xYourWallet`, and
Merd deploys that token on PONS for them. Meridian signs and pays; the requester
owns the token's fees. This is the **custodial** model, chosen deliberately over
the non-custodial one.

## Status: BUILT, TESTED, DORMANT. Not armed.

It does nothing until you set `MERD_LAUNCH_WALLET_KEY`. Off by default, and a
malformed key leaves it off rather than crashing. `custodialLaunchEnabled()` is
the switch, and `handleLaunchMention` returns a "not open yet" reply while
dormant.

## Read this before you arm it

This spends **your money on a public trigger**. Anyone on X can cause a launch,
so the wallet behind it must be one you can afford to see drained, and the caps
must be set with that in mind.

- **Use a DEDICATED wallet, never the treasury.** `MERD_LAUNCH_WALLET_KEY` is a
  separate key from `AGENT_SIGNER_PRIVATE_KEY` on purpose. The treasury holds
  revenue and trading capital and signs nothing on a public trigger. Fund the
  launch wallet with a bounded amount: enough for a day of launches at the PONS
  fee plus gas, and no more. Its balance is the last line of defense.
- **You are the on-chain creator of every token launched.** That is what
  custodial means and it was flagged before the choice. `feeWallet` is set to
  the requester, so they receive the trading fees and Meridian keeps nothing,
  but the deployer of record is still Meridian's wallet. Nothing in the code
  changes that; it is inherent to the model.
- **The caps are the drain protection, so set them low.**
  - `LAUNCH_MAX_PER_DAY` (default 25): total launches Meridian will pay for in a
    rolling 24h, across everyone.
  - `LAUNCH_MAX_PER_REQUESTER_PER_DAY` (default 1): how many one X account may
    trigger. One is right: launching is not a thing anyone does repeatedly, and
    it blunts a spam-drain.
  Both fold from an append-only ledger (`custodial-launches.jsonl`), so a
  restart cannot reset the day's count.
- **Every launch is simulated first.** A request that would revert costs
  nothing; money only moves once the deploy is proven to land.

## Arming it

1. Create a fresh wallet. Fund it with a small, bounded amount of ETH (gas +
   the PONS launch fee times your daily cap, roughly).
2. Set on the box that runs the engage job (this is a LOCAL launchd job, so the
   key lives in the local `.env`, next to the X keys):
   ```
   MERD_LAUNCH_WALLET_KEY=<the fresh wallet's key, 64 hex>
   LAUNCH_MAX_PER_DAY=25
   LAUNCH_MAX_PER_REQUESTER_PER_DAY=1
   ```
3. The engage job (`_merd-engage.mts`, every 2 min) picks up launch requests
   automatically on its next run. Nothing else to deploy.

## Turning it off

Unset `MERD_LAUNCH_WALLET_KEY`. It goes dormant immediately, and requests get a
"not open yet" reply. Draining the wallet to zero also stops it (simulate fails,
nothing is sent), but unsetting the key is the clean switch.

## What it never does

- It never posts the MERD address. `launchDoneReply` refuses to format it, so a
  request that somehow named MERD could not turn into a reply about MERD.
- It never charges the requester or takes their fees. `feeWallet` is theirs.
- It never deploys without a wallet in the tweet. A request missing its wallet
  gets told what to add, so a token whose fees would go nowhere is never made.
- It never spends on a request that would revert, or one past the caps.
