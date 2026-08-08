# The Desk: Merd's autonomous 24/7 market-making book

Reference for the meme-family LP desk that went fully autonomous 2026-08-04/05.
This is the system of record: if chat logs, memories and this file disagree,
fix this file. Code of record: `src/memeGuard.ts`, `src/venues/ethPools.ts`,
`src/venues/ethSwap.ts`, `src/signals/tokenAnalyst.ts`.

## What it is

Merd makes two-sided markets in ETH-quoted, hookless Uniswap v4 pools on
Robinhood Chain (chain id 4663): single-sided bands of concentrated liquidity
placed around spot. Buy rungs (pure ETH, ticks above spot) fill as a token
cheapens; sell bands (pure token, ticks below spot) fill as it climbs. Every
fill earns the pool fee; a full round trip earns it twice and returns to ETH.
Capital in as of 2026-08-04: $997. Everything below runs unattended.

## Where it runs

One process holds the signer: the Railway service (`meridian402-api`).
`startLpGuard()` ticks every 5 minutes inside `withHouseWalletLock`;
`memeRotorTick()` runs FIRST in that tick (before the equity engine's
market-hours early-returns, because this book trades around the clock).
`startMemeFastWatch()` runs alongside it. Every write is eth_call simulated
before sending. The signer account uses viem's `nonceManager` (back-to-back
sends once raced a nonce and lost a treasury skim).

Switches: `MERIDIAN_LP_ENGINE=on` arms everything; `MERIDIAN_MEME_ROTATOR=off`
and `MERIDIAN_MEME_FAST=off` are kill switches for the slow and fast loops.

**One-process rule:** while the Railway rotor is live, no hand-run
mint/withdraw/swap scripts. Set the kill switch first or you have two signers.

**Deploy churn rule:** every deploy resets the rotor's in-memory clocks
(persistence timers, earn windows, stop references, candidate seasoning).
Four deploys in two hours once starved rotations through a 5% dump. Batch
changes; deploy rarely; let the machine breathe.

## The venue registry

- Pinned venues live in `ETH_POOLS` (`src/venues/ethPools.ts`) with their
  census pool ids; `assertRegistryIds()` derives and checks them at boot, so a
  wrong parameter is a loud failure, never a silent empty-pool mint.
- Per-pool geometry: `offsetAbove` (spacings between spot and a fresh band's
  edge; coarse-spacing pools use 1, fine use 2) and `widthSpacings` (band
  width; coarse pools 4 because the same capital across 16% of price earns
  half of what it earns across 8%).
- Venues the desk adopts autonomously persist at `dataPath("meme-venues.json")`
  and are managed like pinned ones after a restart.
- KNOWN GAP (accepted 2026-08-05): entry gates below apply to analyst
  candidates, not to pinned venues; expansion will re-probe a pinned venue
  even right after a stop-loss cut it. Bounded by probation sizing.

## Entry gates (the UNIFROG lesson)

A venue the desk may enter on its own must clear ALL of:
- `vetRow`: fees beat 30-min markout (toxicity), fee tier 0.25% to 3%
  (predator tiers are wash flow), 500+ swaps/24h, $100k+ volume/24h, $500+
  fees/24h, recent move within -5% to +15% (no knives, no fresh pumps).
- Pool age 72h+ (Initialize-event timestamp; day-one wonders lie).
- Two consecutive analyst sweeps clearing the full gate, 6h apart. First
  sweep after any boot adopts nothing, deliberately.
- First entry is probation-capped ($250) until the venue proves it.

Candidate ranking: `poolYardstick` = NET (fees minus markout) per unit of
at-spot liquidity value. Gross-fee ranking flatters pools with informed flow.

## The moving parts, each with its rails

**Rotation (slow loop, 5-min tick).** A band out of range 10+ minutes whose
fresh-quote target differs from its current range gets withdrawn (sweeping
accrued fees home) and re-quoted at the current tick. 7-min global cooldown,
24 moves/day, $25 minimum band, 1h error backoff per band. Skip when target
equals current range (the identical-range no-op lesson).

**Velocity gate (the knife rule).** Per-pool tick history yields drift %/hr
(positive = token dumping). Above 1.5%/hr, ETH-side re-quotes keep a slow
30-min clock AND place 2 spacings deeper: never ladder bids into a knife.
Sell-side flips always run fast; asks cannot be run over.

**Fast desk (1.5s).** The public RPC has no WebSocket but sustains sub-second
polls; `watchEvent` streams Swap logs for exactly our pool ids (the event
carries the post-swap tick, zero extra reads). One trigger only: a band
FILLED through its top flips its inventory to a sell band, 45s confirmation
against noise, 90s per-pool cooldown, re-verified on fresh chain reads inside
the house lock.

**Earn tracking + concentration.** Accrued-fee deltas per pool accumulate in
a ~24h window (halved on age-out; collects never erase credit). Float
compounds into the best earner FIRST (before any probe), until the venue
holds 75% of the band book. Waiting (out-of-range 10min+) ETH bands in a
venue the leader out-earns 3x get moved to the leader, uncapped, 2/day.
In-range bands never move: they are earning where they stand.

**Migration (dead weight).** A pool earning nothing for 6h despite fresh
quotes, or with a mature window below the $1 printing floor, has its ETH
bands moved: to the best earner uncapped, else to the best seasoned candidate
at probation size. 2/day.

**Collect + skim.** A band with $10+ accrued gets a zero-liquidity decrease:
fees sweep home WITHOUT touching the quote, then HALF the ETH side transfers
to the treasury immediately (min 0.0005 ETH, `FEE_SKIM_RATIO` is the knob),
6 collects/day. The skim is its own failure domain: a failed bank never
voids a successful collect. First autonomous full cycle: 2026-08-05 16:58,
0.00255 ETH collected, 0.001275 ETH banked.

**Never-stuck exit ladder.** (1) Maker exit: filled inventory re-quotes as a
sell band near spot, fee-EARNING. (2) Hard stop: out-of-range token inventory
held 30+ minutes, or down 4% from where the holding began, is withdrawn and
sold at market through the UniversalRouter in $200 chunks (3/pass, slippage
floor from the pool's own price). (3) Wallet sweep: loose tokens above $15
sell to ETH every tick. In-range mixed bands are working inventory, exempt.
Worst case per position: the 4% line plus one exit fee on a probation-sized
entry. A desk that can never take an inventory loss is a desk that never
quotes; the design goal is small, rare, bounded, journaled.

Taker exits route through UniversalRouter
`0x8876789976dEcBfCbBbe364623C63652db8C0904` (the 5M-transaction deployment;
a second verified UR exists at 0x06AfBA43 with 36k). V4_SWAP command 0x10;
Permit2 needs a UR spender approval separate from the PositionManager's.

## Custody and money flow

- Execution wallet `0xDFF0Cf4f...` (hot, key in Railway env + gitignored
  agent/.env): quotes, rotates, collects. Working capital only.
- Treasury `0x475C1fe4...` (Privy-custodied, transfer-only, no server key):
  receives platform revenue (WETH) and fee skims (native ETH). It only ever
  receives; its balance chart IS the profit statement. The skims incidentally
  fund its future gas.
- Addresses are public by design (disclosed on X with Blockscout links).
  Private keys exist only in gitignored env files; verified never committed.

## The truth layer (hard-won)

Display incidents, all display-only, zero money incidents. Each bought a
structural guard:

1. Hand-carried constants went stale on every rotation (fake -$238, -$79).
   Guard: the backend prices every band live; `/api/proof` serves `memeBands`
   marked to each pool's current tick with accrued fees; no hand constants.
2. An RPC failure served as an empty book ("Flat" over $900 working, fake
   -$870 sparkline). Guard: `memeBands: null` means read failure, `[]` means
   flat; the site keeps its last good picture on null; the tracker skips the
   sample; the sparkline despikes single-sample cliffs.
3. An RPC soft-failed the log scan (answered [] without erroring), repainting
   fake flat (-$796). Guard: `balanceOf` on the PositionManager arbitrates;
   "no positions" while the wallet holds position NFTs throws into the null
   path. Honest flatness still discovers its zero-liquidity shells, so no
   false positive.

Frontend contract: the profit headline decomposes into BANKED (wallets +
treasury, ratchets) and WORKING (quotes marked live, breathes). Band badges
(earning / waiting / filled) compare served ranges to a pool tick the
visitor's own browser reads from the chain.

## Public narration

- `GET /api/desk-journal`: the last 100 journal entries, public. Kinds:
  `rotate`, `collect`, `expand`, `migrate`, `concentrate`, `stop-loss`,
  `wallet-sweep`. Each carries reasons, amounts, tick context, tx hashes.
  The journal file (`dataPath("meme-rotations.jsonl")`) survives deploys.
- Merd's autopilot has a DESK content type: it narrates journaled decisions
  first person on the timeline, max 2/day, cuts told straight, never an
  invented trade.
- X reply wall: since Feb 2026, API replies and formal quotes to accounts
  that have not mentioned us are blocked on every self-serve tier; a tier
  upgrade does NOT lift it, and X's official MCP server rides the same
  policy. What works: quote-reposts via URL-in-text (`postQuoteViaUrl`,
  2/day budget in the outreach loop), replying once summoned (the engage
  loop), mention posts, or the operator's own hands in the app. The
  copywriter's `**REPLY**` protocol marker is stripped in `cleanReply`
  (it leaked into two live posts once). `merd-watchlist.json` carries an
  `avoid` list of accounts Merd never interacts with, even their mentions.

## Revenue allocation (operator policy, 2026-08-08)

Every cycle is ONE event with two public transactions on the same day: the
marketing payout and the buyback-and-burn. Pairing them means a reader
checks one date and sees both sides of the promise kept.

- **25%** marketing team.
- **25%** buyback and burn, executed the same day as the marketing payout.
- **~40%** retained: desk capital and treasury growth. Venue count before
  position size (the v3 adapter unlocks MERD's own pool and every PONS
  pool, which beats another $500 into the same thin venue).
- **~10%** operating reserve: gas, LLM, infrastructure.

Mechanism: buyback and burn, NOT a staking claim. It reaches every holder
without staking, locking or a claim contract; it is a treasury operation
rather than a proportional payout of profits (a materially cleaner legal
shape); and it is verifiable on-chain. The dormant staking-claim contract
in the repo stays dormant.

Honest math, so nobody oversells the loop: a $100 buyback in the 1% MERD
pool generates ~$1 of pool fees, of which our creator share returns ~$0.20.
The flywheel is a 0.2% rebate, not a machine.

Execution discipline: buy in bounded chunks (our own buying moves a thin
market, the same lesson the desk's exits learned), publish every cycle
next to the revenue chart, never pre-announce a specific buy, and announce
a cycle only after both transactions have landed.

## Incident log (selected)

- 2026-08-05 late, the CASHCAT round trip (~$320 off the book peak). A
  +100%+ blow-off top collapsed 88% in hours. Position-level rails all
  worked (fast stop cut fills at 4%, nothing ended stuck), but three
  systemic holes stacked bounded losses: (1) the wallet sweep sold whole
  balances in one swap and wedged on the slippage floor while $428 sat
  exposed, fixed with sellInChunks (halve on revert); (2) expansion had no
  knife gate, so the earn window kept ranking the collapsing pool as
  leader and fed it fresh probes, fixed by refusing entries into a pool
  dumping past the drift threshold; (3) deploys reset the daily budgets,
  so 18 expansions ran on a 6-per-day budget, fixed by persisting the
  counters with the risk state. The honest residual: a desk that quotes
  memecoins through an 88% collapse pays many small bounded costs; the
  rails bound each one and now also bound how many can stack.

- 2026-08-05, the $30 STONKBROKER stop. STONK dumped ~6% in minutes; the
  drawdown stop fired at 6.1% instead of 4 (slow-rotor evaluation latency)
  and the book was 96% STONK when it hit, because two concentration moves
  had walked past the venue cap (bestEarner checked the leader's share
  BEFORE adding the migrated float). Fixes shipped the same hour: the 4%
  line is now checked at swap speed with a 15s confirm (`maybeFastStop`),
  the cap is enforced post-move, and rotor risk state (tick history, hold
  clocks, reference prices, earn windows) persists across deploys in
  `meme-rotor-state.json` (30min staleness ceiling). The residual truth,
  told to the operator plainly: a desk that quotes memecoins cannot have
  zero drawdowns; the rails bound each one, they do not abolish them.

## Reading the desk

- Live: meridian402.xyz (positions, fees accruing, profit split).
- Merd's own memory architecture and self-commit loop: MERD-MEMORY.md.
- Decisions: `/api/desk-journal`, or `railway logs` for `[memeRotor]` /
  `[memeFast]` lines.
- Positions: Blockscout, PositionManager `0x58daec31...`, wallet
  `0xDFF0Cf4f...`.
- Tests: `npm test` in `agent/` (468 as of 2026-08-05); the pure decision
  logic (placement, drift, gates, concentration) is covered offline.
