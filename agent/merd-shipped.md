# What shipped: Merd's operator feed

His voice doc tells him to talk about what shipped and what it took. His inputs
were market numbers only, because the raw git-log feed was removed after he
started narrating internal engineering in public ("our new EOA classification
logic", and a commit he turned into a false claim about a display bug). So he
was instructed to be an operator and fed nothing to be an operator about.

This is the safe version of that feed: **engineering writes the line, Merd
decides whether it is worth saying.** Same split as everywhere else in this repo.

## The rule for writing a line here

Say what is **now true for someone using Meridian**. Never how it works, never
what it replaced, never that anything was wrong.

| Write this | Not this |
| --- | --- |
| "The desk now prices a pool move against the capital actually at risk." | "Fixed a hardcoded $160 in the allocator." |
| "Pool rankings ignore pools too thin for our size to mean anything." | "Dead pools were ranking first at 930%/day." |
| "Paying for a tool now proves the payment is yours." | "The x402 proof was a bearer token anyone could steal." |

A line that cannot be written without revealing what was broken underneath does
not go here. If in doubt, leave it out: silence costs nothing, a leaked weakness
is permanent.

Format: one line per entry, newest at the top, `YYYY-MM-DD - statement.`
Merd sees only the most recent handful.

## Entries

2026-08-28 - Every position card on the live book now shows the market's pull and the fees earned as two separate numbers, so a red day and a working strategy stop looking like the same thing.
2026-08-27 - The Meridians have their own page: 1,000 seats, the artwork, the mint ladder, and the twenty engine seats, all public on the site.
2026-08-26 - MERD in full is public on the site: supply, burns, and where every coin sits, read from chain by your own browser, every row linked to the explorer.
2026-08-25 - Engine access has a front door: connect a wallet on the Access page and it answers where you stand, live.
2026-08-01 - Anyone's agent can pay Meridian per call for a market read, and settle it on-chain without an account.
2026-08-01 - Platform revenue now collects to the agent's own wallet. No Meridian server holds a key that can spend it.
2026-08-01 - Custody of the money and authority to sign are now two different keys, held in two different places, on purpose.
2026-07-28 - The desk makes markets in a tokenized-equity pool once it is deep enough to be worth it, and steps back when it is not.
2026-07-25 - Pool rankings now ignore pools too thin for our size to be meaningful, so the ranking reflects what we could actually earn.
2026-07-25 - The desk prices a move between pools against the capital actually at risk, not a fixed assumed size.
2026-07-25 - Paying for a Meridian tool now proves the payment is yours, so nobody else can spend it.
2026-07-25 - Reads run on a dedicated endpoint, so the public numbers hold up under load.
2026-07-24 - The public track record separates market-making from the retired directional experiment, so the number reflects the business it names.
- 2026-08-04: the lp engine is live with real money. first positions are on, in two 24/7 memecoin pools that passed the same toxicity measurement everything else has to pass, with the tokenized-equity legs armed behind them. fees are accruing on-chain right now.
- 2026-08-04: the landing page shows the whole book live: net profit across both wallets, every open position as a clickable on-chain card, and the undeployed float, all read from the chain by the visitor's own browser.
- 2026-08-04: a standing token analyst now indexes every eth-quoted pool on the chain (87 thousand and counting) and measures which ones actually pay LPs after informed flow takes its cut. new pools surface on their own, nobody hand-picks them.
- 2026-08-04: when the market walks away from a resting quote, the desk now moves the quote to the market instead of waiting to get lucky. one band just got re-laddered to sit a single tick-spacing off spot, and the only cost was gas measured in cents. every move verifiable from the position NFTs on-chain.
- 2026-08-04: the book is now two-sided. buy rungs under the market, a sell band over it, so a move in either direction fills a quote and pays the desk the pool fee. exiting inventory through our own quotes means we earn the fee a swap would have paid. the landing page badges each band live from chain state: earning, waiting, or filled.
- 2026-08-04: the desk now re-quotes on its own. when the market walks away from a band for half an hour, the guard pulls it and re-places it at the current price, around the clock, rate-limited and journaled, with every move verifiable on-chain. the same judgment that was hand-run this morning, now on a 5-minute clock that never sleeps.
- 2026-08-04: you can now watch the desk earn in real time. every band on the landing page shows the fees accruing inside it, in dollars, re-read from the chain every 30 seconds, plus the running total across the book. not a claim, a live counter anyone can verify against the position NFT.
- 2026-08-04: capital never gets stuck. the standing analyst measures every eth-quoted pool on the chain, a vetting gate refuses the toxic and the fake, and if a venue we quote stops paying for six hours the desk moves that capital into the best venue that cleared the bar, capped small on first entry, at most twice a day. the sell side also proved itself today: the whole token inventory exited through our own quotes into a rally, earning fees on the way out instead of paying them.
- 2026-08-04: profit banks itself the moment it is real. when a quote's accrued fees clear the floor, the desk sweeps them without disturbing the position, sends half straight to the treasury on-chain, and puts the other half back to work. the treasury only ever receives; watching its balance grow IS the profit statement.
- 2026-08-04: the desk widened its map. two new measured venues joined the book from the analyst's vetted sweep, one of them a pool where the flow itself favors market makers, and idle capital now enters the best unquoted venue on its own instead of waiting for something to fail. quotes also got denser where the math said they were spread thin.
- 2026-08-04: capital now follows the scoreboard. every venue's earnings are tracked live, the float compounds into whichever one is measurably printing, new venues start small until they prove it, and anything that goes half a day without clearing the earning floor gets cut and its capital moved to a winner. concentrated where the money is, capped so no single token ever becomes the whole desk.
- 2026-08-04: the desk got faster and smarter about direction. it now measures each pool's price velocity and re-quotes a stale book in minutes instead of an hour, with one deliberate exception: when a token is dumping hard it refuses to chase, and places its bids deeper instead. speed where speed pays, patience where speed bleeds.
- 2026-08-05: the desk hears every swap in its pools within about a second now. when a quote fills all the way through, the inventory is back on the market as a sell order in under a minute, confirmed against chain state before a single wei moves. asks move at machine speed; bids keep their patience, because those are the ones a crash can punish.
- 2026-08-04: merd's supply got permanently smaller and provably committed: 199,418,747 merd burned (~19.9% of supply, twelve on-chain receipts, buyback proceeds included) and 67,745,887 merd locked in a locker whose source we read before trusting it: 57.7M for a month, 10M for a full year, no early exit, no admin override, for anyone including us. about 26.7% of the supply removed or locked, every transaction public.
- 2026-08-05: the desk can never be stuck. every token position has a two-stage exit: first a sell quote that earns the fee, and if the market keeps falling, a hard stop that pays the fee once and gets flat, thirty minutes or four percent, whichever comes first. bounded cost, no open-ended bags, proven on-chain before it was trusted with the book.
- 2026-08-06: merd's memory story went public: MERD-MEMORY.md explains the once-a-day self-commit of his inner journal, decision ledger and action history to his own private repo, no human in the loop. the mechanism and the commit receipts are public, the diary stays his, because an inner journal that knows it has an audience stops being inner.
