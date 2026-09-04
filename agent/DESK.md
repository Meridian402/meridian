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

**Seat width (2026-09-01).** The pilot guard's re-band width was hardcoded
at 20 (±10%), so whatever width an operator opened, the first re-center
pulled it back to ±10%. Replaying the guard's actual rule (30/12-minute
waits, settle test, 45-minute break exit, 80% floor) on the real BONER and
MICRODUCK Swap logs, 14h from entry with $485 seats: ±10% sat in range
9-34% of the time; width 50 (about -20%/+25%) sat in range 64-89% with
later and fewer floor events, for about the same net (+$204 vs +$202 across
the two pools). The width change buys uptime and fewer forced exits, not
more dollars. `MERIDIAN_REBAND_WIDTH_PCT` (default 50) replaces the
constant; operator opens at width 50.
Same day, corrected within the hour: below-band re-centers were switched
off on a first replay that skipped the settle test and the break exit. With
both modeled, every below-band event on those tapes was worth +$10 to +$32
per seat (sell half early, earn on the bounce, realize at the band edge
instead of the floor), and the day's real loss was an ABOVE re-center that
re-bought BONER at +25.6% before a 17% drop. The below clock is back on by
default; `MERIDIAN_PILOT_RECENTER_BELOW=off` holds instead (floor and dump
exit only). Also that day: the wallet-ops runaway cap sat at 39/40 and
refused an operator open, so `MERIDIAN_MAX_DAILY_WALLET_OPS` went 40 to 100.
(The collect threshold was raised to $10 at the same time on the wrong
belief that collects count toward the cap. They never did: only buys, sells,
mints, skims and rotations are recorded in the wallet ledger. Corrected the
same afternoon.)

**Collects on a clock (2026-09-01, operator).** The dollar threshold is
gone. An in-range seat collects on the first tick at or past
`MERIDIAN_COLLECT_EVERY_MIN` (5) minutes since its last collect, and the
guard tick is 150s so the cadence lands on the interval. Gas guard:
`MERIDIAN_COLLECT_MIN_USD` (1); a collect is ~145k gas, about $0.19 at ETH
$2,433, so a seat holding pennies waits for the next tick instead of paying
gas to move them (0 disables the guard). The clock is stamped before the
send, so a failed collect waits a full cadence rather than retrying every
tick. Gas math: two busy seats at this cadence can spend $50+ a day, which
is why the guard exists on quiet tape.

**Never re-buy the top (2026-09-01, from the give-back post-mortem).** The
day's two big losses both started as ABOVE re-centers minting balanced bands
at a pump's pause (BONER re-bought at +25.6%, MICRODUCK two ticks off the
high; ~$208 of a -$168 day). Above re-centers now re-arm as an all-USDG BID
whose top price edge sits at spot, spanning what the balanced band's lower
half would have covered, full budget on one side (2x the retrace-side fee
density). The retrace fills us at chosen prices; a continued run costs only
missed fees; the mint buys no token at all. Below re-centers stay balanced.
Plumbing: mintRange bidOnly -> bidBelowBounds(depth 0, width/2) with the
dump bid's 2x maxUsd convention; openInPool passes {bidOnly}; the pilot
sets it for every above re-center. Post-mortem artifact: "The Give-Back".

**The volume-fade exit (2026-09-01, operator: "exit at the tops once volume
dies down").** Every other exit is price-driven; this one leaves a venue when
the flow that justified the seat leaves. The dump watcher's bleed samples now
carry each scan window's USD volume; two consecutive fading hours (each down
`MERIDIAN_FADE_DROP_PCT` (30%) vs the prior, from a base hour above
`MERIDIAN_FADE_MIN_WINDOW_USD` ($2k/window)) close the venue's seats to cash
(mech fade-exit) and lock re-entry until the latest hour recovers to 70% of
the pre-fade base or `MERIDIAN_FADE_LOCKOUT_MIN` (240m) ages out. Seats
younger than `MERIDIAN_FADE_MIN_SEAT_AGE_H` (2h) are exempt, so a fresh
pullback bid is never closed by the fade that preceded it. Thin or
volume-less tape never judges. `MERIDIAN_VOLUME_FADE=off` disables. The
floor and dump exits still bound everything underneath.

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

**Meme sleeve attribution is complete as of 2026-09-01.** Until then the
rotor's breaker-withdraw, stale-withdraw and migrate paths wrote no attribution
row at all, and a stop-exit recorded only the token sale, not the ETH side the
withdraws returned. So the sleeve's ledger read as cash that went in and never
came back: the "-$15.9k" the 08-05 to 09-01 window showed was mostly that hole,
not a measured loss (the book reconciliation puts the sleeve's real cost near
$1-1.5k). Every meme cash boundary now writes an exact row with gas stamped from
the receipt, and `/api/attribution` splits `exact` (live rows) from `approx`
(backfilled history with known holes) so the two are never summed as one.
Run the meme rotor again only against `exact`.

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

## Standing order: be where the volume is (2026-08-08)

The operator's rule, stated plainly: the desk should hold quotes only where
volume actually is, at all times. Loyalty to a venue is worth nothing; the
tape decides.

What already serves this:
- `volumeRotated`: an unquoted venue whose live pulse is hot (200+/hr) and
  doubles the earn-window leader's preempts the compound and gets first
  claim on the next capital.
- `maybeMigrate`: a venue with bands, none in range, that has earned nothing
  for 6h (or never reached the printing floor in a mature window) has its
  ETH-side bands moved to a live candidate.
- Liveness gate: no entry into a pool without a real 5-swap pulse.

The measured gap (2026-08-08 evening): CASHCAT fell from 548 swaps/hr to 35
and the desk kept all four bands there, earning ~0 bps/hr for three hours,
because migrate needs SIX HOURS of zero earnings and the bands were still
trickling fees. Volume died long before earnings did. The rule that is
missing is a VOLUME floor for holding, not just an earnings floor: when a
pool's pulse collapses well below the level that justified entry and a
better-pulsed venue exists, the ETH-side bands should leave on a clock
measured in tens of minutes, not hours.

Not built yet, deliberately: shipped after a clean measurement day, not on
the same night as three other engine changes.

STILL NOT BUILT as of 2026-08-09, and for the same reason. Six changes shipped
or landed that day, so a new migration trigger would be the seventh. The rule
above is a decision to LEAVE a working position on a volume signal, which is
the most dangerous shape of change on this desk: it sells things. Everything
shipped on 08-09 either unblocked the desk or stopped it doing something
measurably dumb, and none of it decided to exit. This does.

What it needs before it is written: one clean day where nothing else changes,
so the pulse-collapse threshold can be read off real behaviour rather than
guessed. The half of the rule that only ever DELAYS a cut did ship that day
(makerExitPatienceMs, patience from the tape rather than the clock), which is
the safe half and can be observed on its own first.

## The weekend, measured (2026-08-05 to 08-09)

The first five-day record with a full daily series. Fees are the sleeve's, DD
is intraday max drawdown, and the last column is the one that matters.

    day   fees      d book    max DD   stops  collects   DD per $1 fee
    Wed   $108.77   +127.24   107.09     7      5           0.98
    Thu   $115.20    +70.80    55.02     4      2           0.48
    Fri   $103.30   +258.67    71.63     5      4           0.69
    Sat    $41.10   +257.96    50.18     2      0           1.22
    Sun    $23.12    -35.65    73.06     5      0           3.16

The weekend does not change our risk, only our pay. Fees fell 79% against the
weekday average and drawdown did not fall at all, so Sunday risked $3.16 for
every $1 earned where no weekday exceeded $0.98. Saturday's +$258 on $41 of
fees was meme inventory going up, not making; Sunday gave it back. When the fee
is that small it is not the reason we are there, and the book is just long beta
with extra steps.

Collects were ZERO on both weekend days, cross-checked against on-chain skims,
which matched the daily record exactly every day of the week. Cause was a flat
$10-per-band collect floor calibrated to weekday velocity; $23 across four
bands never reaches it. Fixed 08-09: size is one route to collecting and age is
the other.

The open half is sizing. Deployed capital should track measured pulse, so a
weekend book is a weekend-sized book. That is the same missing volume floor
described above and it is the single biggest remaining leak.

## Auto-entry (2026-09-03)

Until 2026-09-03 every fee-earning seat was opened by the operator (or on the operator's go) and the pilot only managed it; the desk sat flat 14 of 24 hours while its own venues carried $200k-800k/hour. `MERIDIAN_PILOT_AUTO_ENTRY=on` lets the pilot open a seat itself, once per tick at most, inside the tick's house lock, under the hand rules: a hands-off venue (MERIDIAN_GUARD_HANDS_OFF), admitted by its own 7d record (venueEarnsAdmission), last-hour flow at or above MERIDIAN_PILOT_AUTO_MIN_FLOW_USD_H (from the dump-watch samples), no seat there, no dump or fade lockout, not on MERIDIAN_MEME_VENUE_DENYLIST, cash at or above seat + MERIDIAN_PILOT_AUTO_RESERVE_USD, gas at or above MERIDIAN_PILOT_AUTO_MIN_GAS_ETH, fewer than MERIDIAN_PILOT_AUTO_MAX_SEATS open, fewer than MERIDIAN_PILOT_AUTO_PER_DAY entries in 24h, and no guard exit in that venue inside MERIDIAN_PILOT_AUTO_COOLDOWN_MIN. Among the venues that pass, the one where OUR seat would earn the most per hour wins: flow x fee tier x the share a $MERIDIAN_PILOT_AUTO_ENTRY_USD bid would hold of the pool's active liquidity (bidShareOfPool on the dump-watch crowding sample, which now keeps the tick). A venue with no depth sample ranks by flow, below every measured one. This is why a $1M/h pool with $700k of professional liquidity in range loses to a $300k/h pool with $50k. The shape is the proven one: a bid-only seat of MERIDIAN_PILOT_AUTO_ENTRY_USD at the re-band width, top edge at spot; every rail applies from the first second. Rows land in pilot-guard.jsonl as `auto-entry`; the boot line prints the live settings. Ships OFF.

**Fee-rate bar (2026-09-03 evening).** Operator: "our pons position is earning nearly nothing." Flow alone let PONS take a slot at ~$3-5/h for a $700 seat (0.09% of a deep pool), then the bid chased the price up for $27 of churn and $3 of fees. A venue must now also clear MERIDIAN_PILOT_AUTO_MIN_FEE_USD_H (6): the density estimate for OUR seat in dollars an hour; a venue with no depth reading cannot clear it. The idle-bid window is 120 minutes.

## The launch lane (2026-09-04)

Operator: "can we maybe find some microduck type positions in the 30-70k LP range", then "we need to breakout". The only pools on this chain with MICRODUCK-type fee density (real flow through $15k-80k of active liquidity) are launch pools a few hours old, and the launch watcher on the operator's Mac already scores them hourly. Paper record as $500 seats from the mark: all 49 marks +$319 at 37%; the subset whose token passes the standard gate (verified launch bytecode, creator tax <= 1%, allowed pair) +$1,683 at 64% over 14 marks; hour-1 entries and sub-3% tiers lost. The lane: the watcher POSTs a gate-passing SIDE pool (hooks=0, USDG-quoted) at hour LAUNCH_WATCH_PUSH_MIN_HOUR+ with tier >= 3% and prior-hour flow >= $300k to the desk's bearer-gated /api/launch-venues with the pool key and its measurements (flow, hourly moves, senders, poolL, sqrtP). The desk (launchLane.ts) verifies the pool id is the hooks-free USDG pool it would mint into, names the venue registry-safe, registers it as a launch pool (a third map in stockPools, apart from the qualifier's set), and the dump watch starts a tape on it. The pilot manages launch seats like any other and the auto-entry treats each live launch venue as a candidate with lane limits: MERIDIAN_LAUNCH_SEAT_USD (500), MERIDIAN_LAUNCH_MAX_SEATS (1), tier >= MERIDIAN_LAUNCH_MIN_TIER_PCT, hour >= MERIDIAN_LAUNCH_MIN_HOUR, flow >= MERIDIAN_LAUNCH_MIN_FLOW_USD_H, depth within MERIDIAN_LAUNCH_DEPTH_MIN_USD..MAX, plus every ordinary bar (fee rate, yield/move, no-spike, admission, cooldown). Until the desk's own tape exists, the pushed stats stand in for up to MERIDIAN_LAUNCH_STATS_MAX_AGE_MIN. A venue expires after MERIDIAN_LAUNCH_VENUE_TTL_H unless a seat is open in it. Verdict reasons carry the "launch lane:" prefix; the armed line prints the lane's limits.

## The volatility term and the no-spike rule (2026-09-04)

Operator, after the night of 09-03: "it seems we are still getting caught in tokens falling, there is something wrong with our logic", then "we need to breakout". The 48h MICRODUCK tape showed the shape: the fee bar was a yield test with no volatility term (MICRODUCK at $6/h while swinging 8% an hour passed it after the pool got five times deeper), above-band re-arms fired 12 quiet minutes after +32% and +18% hours and the bid filled into the reversal, and below-band re-centers sold half the tokens at the low before the bounce. Three changes: (1) `MERIDIAN_PILOT_AUTO_MIN_YIELD_TO_MOVE` (0.25): a venue must earn per hour, as a percent of the seat, at least this fraction of its median absolute hourly move over the last 6h (dumpWatch.moveStats on the bleed samples); no move reading, no entry. (2) `MERIDIAN_PILOT_SPIKE_PCT` (10) over `MERIDIAN_PILOT_SPIKE_WINDOW_MIN` (60): no auto-entry and no above-band re-arm while the price is up more than that over the trailing window (spikeVerdict on the pilot's tick history). (3) `MERIDIAN_PILOT_RECENTER_BELOW=off` in production: a seat that falls below its band holds for the bounce or the 70% floor instead of re-banding at the low. The armed line prints all three.

## Idle-bid exit and gas refill (2026-09-03)

Operator: "merd should be managing the whole engine and making calculated decisions based on his data; we are simply putting guards so he doesn't get liquidated." Two things still needed a human after auto-entry shipped. (1) A bid-only seat on a venue that only rises never fills; the pilot re-arms it every settle and pays a little churn each time (PONS: four re-arms in three hours for $3 of fees), and nothing ended it. `idleBidExits` closes a venue whose seats have all held only USDG out of range for MERIDIAN_PILOT_IDLE_BID_MAX_MIN (180) across re-centers, journals `idle-exit` (a guard exit, so the auto-entry cooldown applies), and the picker moves on. Dump bids keep their own clock. (2) Gas: the treasury key is off the server by design, so the signer could run dry holding $1,000 of USDG. `maybeGasRefill` buys MERIDIAN_GAS_REFILL_USD of native ETH with USDG over the 0.05% bridge tier when the balance is under MERIDIAN_GAS_MIN_ETH, keeps MERIDIAN_GAS_REFILL_MIN_CASH_AFTER_USD in cash, waits MERIDIAN_GAS_REFILL_COOLDOWN_MIN between buys (a failed buy also waits), journals `gas-refill`. Both run inside the pilot tick's house lock; both print on the armed boot line.

## Payback gate on fresh venues (2026-09-03)

The re-center payback gate judged a venue's earn rate by fees banked there in 24h plus the seat's accrual. A venue the desk had just entered had neither, so a bid left behind by a rising price was refused forever (PONS #1622201, 12:30-15:30 UTC: "$2.75 churn vs $0.17 expected fees"). `paybackFeePerHour` now takes the density estimate (flow x tier x the share the seat's budget would hold, from the dump-watch depth sample) as the floor of the estimate, the same number the auto-entry picker opened the seat on. Banked fees still win when higher; a missing depth reading changes nothing.

## Floor percent (2026-09-03)

The deposit-scaled floor is a knob: floor = max(MERIDIAN_PILOT_FLOOR_USD, MERIDIAN_PILOT_FLOOR_PCT% of the seat's deposit lineage). Code default 80. Production runs 70 since 2026-09-03 on the operator's call ("stop leaving money on the table"): the 08-29..09-02 real-tape replay scored all ten 80% floor exits as bottom sells (holding was +$169 / +$461 / +$586 at 1h / 4h / 8h), the week of 08-27..09-02 gave $690 of $1,121 in fees back through 17 floors, and the median below-band excursion was ~7% with the deepest 19-26%. At 70% the worst case on a $700 seat is $210 instead of $140; the dump exit remains the collapse bound. The dump-bid fill check uses the same percent.

## Liveness (2026-09-01)

Every autonomous loop stamps a heartbeat when a tick completes, never when it
starts, so a hung await starves its own beat (`src/liveness.ts`). Money loops:
lpGuard, memeRotor, pilotGuard, dumpWatch, lpAllocator, treasurySkim,
dailyReconcile. Report-only: memeFast, bookSnapshot, backups. `/health` lists
every loop with its age against a stale threshold (3x its period, 10-minute
floor) and answers 503 naming the culprit when a money loop is stale; `/api/ops`
carries the same table. Railway does not poll the healthcheck after a deploy, so
the recovery is in-process: a money loop stale past 4x its period (30-minute
floor, `MERIDIAN_LOOP_EXIT_MIN`, 0 disables) exits the process for a supervised
restart, the same doctrine as the house-lock ceiling and deliberately above it
so the lock watchdog fires first when the lock is the cause. Born from the
31.6-hour dark window of 2026-08-21/22: a live process, a dead desk.

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
