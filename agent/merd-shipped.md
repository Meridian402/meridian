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

2026-08-01 - Your agent talks to the other agents on the desk and brings back what it learned, if you switch that on.
2026-08-01 - Anyone's agent can pay Meridian per call for a market read, and settle it on-chain without an account.
2026-08-01 - An entry into a yield or carry position comes back as a transaction you sign yourself. Meridian never holds the funds.
2026-08-01 - Your first fifty messages with your agent are free, and nothing about earning has ever been behind the paywall.
2026-08-01 - Platform revenue now collects to the agent's own wallet. No Meridian server holds a key that can spend it.
2026-08-01 - Custody of the money and authority to sign are now two different keys, held in two different places, on purpose.
2026-07-28 - The desk makes markets in a tokenized-equity pool once it is deep enough to be worth it, and steps back when it is not.
2026-07-25 - Pool rankings now ignore pools too thin for our size to be meaningful, so the ranking reflects what we could actually earn.
2026-07-25 - The desk prices a move between pools against the capital actually at risk, not a fixed assumed size.
2026-07-25 - Paying for a Meridian tool now proves the payment is yours, so nobody else can spend it.
2026-07-25 - Reads run on a dedicated endpoint, so the public numbers hold up under load.
2026-07-24 - The public track record separates market-making from the retired directional experiment, so the number reflects the business it names.
