# The Launch-Hour Desk (spec v0.1, 2026-09-01)

Status: D1 WATCHER LIVE (09-01), D1.5 CANDIDATE FEED LIVE (09-02), D2 NOT ARMED,
NO CAPITAL AUTOMATED. The live desk (DESK.md) is untouched by this document.

## Thesis, measured on 2026-08-31 / 09-01 tapes

A hookless USDG side pool at a fat fee tier (0.9% to 3%) next to a fresh
launch curve collects the arbitrage toll between curve and pool. The toll is
paid by a fixed fleet of arb bots plus the UniversalRouter, it arrives within
seconds of the pool existing, and each trade is sized to whatever depth we
offer, so income scales with OUR liquidity x price total-variation x tier.

| pool | age at read | LP fees | where the money was | price path |
|---|---|---|---|---|
| GPRO/USDG 3% (PONS v2 launch) | 6.4h | $68k | $55k in hours 0-3; pool depth only $1-4k for 2h | +160% then -82% |
| RAM/USDG 3% (OFT token) | 13.5h | $152k | $96k in hours 3-6; decaying ~30%/h after | +300% then -50% |
| BONER/USDG 0.9% (Doppler launch) | ours | $100 to us on $250 in <3h | first 2h | +19% then -25% |
| WYFI/USDG 1.54% (stock token) | 4.9h | $15k in ONE hour | pre-crowded ($200k+ depth) | flat |

Pro-rata simulation, $2,000 seat, +/-50% band, in at first swap, out at 3h:
GPRO ~$9.3k of fees (8-31% share), RAM ~$1.8k, WYFI $27. The exit at 3h is
not optional: both tokens lost 50-80% afterwards.

## Scope

In: PONS v2 launches (launcher 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e,
TokenLaunched, already parsed in src/launch/ponsV2.ts) and Doppler launches
(PoolManager Initialize with hook 0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544).
Out: tokenized-stock pools (deep, pre-crowded, Nasdaq-print adverse selection),
majors, anything hooked, anything unverified.

## Mechanics

1. SIGNAL. Event feed on the launch itself, never on side-pool appearance.
   Alchemy wss eth_subscribe(logs) on the desk's endpoint, or 1s polling of
   getLogs on new blocks (chain does ~10 blocks/s). Not the 3-minute guard tick.
2. GATE, mechanical, at minute one: runtime bytecode equals a verified standard
   (PONS v2 launcher token = GPRO 0x82fe7e669c0ce263436cf74b8ec7335654aa902d
   modulo immutables; Doppler ERC20 = BONER 0x98096d17e191b3da1d5f99a6d7b3584351b11e18
   implementation); creatorTaxBps <= 100 from getLaunchedToken; pair token on
   an allowlist (USDG, NVDA, GLD, PONS); decimals 18; a $5 buy-and-sell round
   trip lands (mint-proven rule) before any scaling.
3. ENTRY. Create the side pool ourselves at the curve's current price (curve
   slot0 via StateView) at the chosen tier, and mint in the same PositionManager
   multicall (initializePool + modifyLiquidities). Join instead if a pool at our
   tier already exists. PROBE THEN SCALE: a small wide probe at minute one on
   every gated launch; scale to full size at IGNITION, defined on the curve
   inside the first 10 minutes (volume and distinct buyers over thresholds
   calibrated by the watcher week). Most launches die; the probe's token half is
   the bounded cost of being early on the ones that do not.
4. EXIT on volume, not price: hourly volume down >30% for two consecutive
   hours, or active liquidity up >3x from entry, or age > 6h, or floor breach.
   Withdraw, then sell the token leg into the DEEPEST market for it (the curve
   or hooked pool, via the router), chunked (sellInChunks), never into our own
   pool. Attribution mechs: launch-probe, launch-scale, launch-exit.
5. BUDGET AND BRAKES: own daily budget and op counter (under the 150/day
   house-wallet cap in risk.ts), max concurrent seats, one full seat at a time
   at today's cash, portfolio breaker underneath (portfolioBreaker.ts), and a
   kill switch env. Never the whole float.

## Initial parameters (all env-tunable, to be calibrated by the watcher)

tier 3% (RAM's 3% out-earned its 0.95% sibling), tickSpacing 600, band +/-50%,
probe $150, full seat $1,500, max 3 concurrent, 10 probes/day, ignition =
curve volume >= $10k AND >= 20 distinct buyers within 10 min of launch, floor
60% of scaled deposit (a +/-50% band marks -25% before leaving range, the 80%
pilot floor would fire on noise), time stop 6h.

## Deliverables

D1. WATCHER, read-only, no signer, no deploy. src/launch/watch.ts run with tsx
    locally under launchd (like the X autopilot) against the public RPC at
    ~1 req/s with a browser User-Agent (Cloudflare blocks default UAs and 429s
    bursts), or an Alchemy key. Logs to launch-watch.jsonl: every launch, gate
    result, time to first swap, ignition time, hourly volume/fees/depth of the
    curve and any side pools, and the SIMULATED probe-then-scale P&L using the
    real tape and the pro-rata model above. Runs 3-5 days.
    Arming criterion: >= 3 launches/week where the simulation nets > $500
    after exit costs, and the exit rule leaves before the drawdown in >= 80%
    of them.
D2. PROBES armed (create-or-join + probe only, capped at 10/day), rails and
    attribution live, watcher keeps scoring what scaling would have done.
D3. SCALING armed once D2 shows probes and ignition agree with the watcher.

## D1.5, the candidate feed (2026-09-02, built, read-only)

One day of D1 tape (979 side pools with swaps, 294 gate-PASS launches) re-scored
for the D2 shape: a $150 probe at minute one on every gated launch nets about
-$7,200/day (hit 34%, floor on 98 of 274); the D1 probe-then-scale plan nets
about -$38,700/day; a USDG-only bid probe nets about -$7,400. No minute-one
signal (ignition, early swaps, senders, volume, tier, source, pair, latency)
selects a profitable subset. The arming criterion above is not met, so D2 is
NOT armed.

What did net positive on the same tape is joining AFTER proof: at hour 1 with
the prior hour >= $100k and the price moved < 50%, a $500 seat with the
watcher's exits netted roughly +$230 to +$380/day over 22-28 entries at a 50-55%
hit rate (worst -$416). That is how BONER and MICRODUCK were actually found.

So the watcher now emits a CANDIDATE line (ledger kind "candidate") when a side
pool clears that bar at hour 1, 2 or 3 after its first swap, and the report
scores every candidate as a $500 seat from the mark so the rule keeps its own
record. Knobs: LAUNCH_WATCH_CAND_HOURS (1,2,3), LAUNCH_WATCH_CAND_MIN_USD
(100000), LAUNCH_WATCH_CAND_MAX_MOVE_PCT (50), LAUNCH_WATCH_CAND_MIN_SENDERS (10),
LAUNCH_WATCH_CAND_SEAT_USD (500). The operator decides; the desk's rails hold
the seat. Capital is still not automated.

## Reuse

src/launch/ponsV2.ts (launch ABIs, isGraduated), src/signals/flowScan.ts
(pool index, fees-minus-markout scorer), src/dumpWatch.ts crowding sampler
(needs minute cadence here), src/venues/lpPositions.ts (computeMintPlan,
collectFees, withdrawPosition), src/pilotGuard.ts floor and lineage,
src/risk.ts guardWalletOp, src/attribution.ts.

## Risks and unknowns, stated plainly

Launch frequency and hit rate are unmeasured (the watcher's job). A share of
every pool's flow is bot arbitrage that can stop. Creators and snipers dump
into the window. Our own pool at the wrong price is an instant gift to arbs
(initialize from curve slot0, re-read at mint). Exit slippage is real when we
are the depth. JIT LPs dilute within the hour regardless. The chain's public
RPC throttles; the live loop must use the Alchemy feed. None of the simulated
numbers count gas, exit costs, or our depth changing bot behaviour.

## Non-goals

No changes to the live USDG sleeve, pilotGuard, or lpGuard. No new knobs on
the running desk. No capital until D2 is explicitly armed by the operator.

Background: memory notes pool-hunt-method and launch-hour-edge; DESK.md for
the rails this sits on.
