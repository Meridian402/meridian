// The 24/7 side of the desk: ETH-quoted meme bands, read and rotated.
//
// Two exports, one truth:
//   memeBandsLive()  - every native-quoted position the wallet holds, marked to
//                      the pool's CURRENT tick: side, holdings, USD value. This
//                      feeds /api/proof so the site stops carrying hand-edited
//                      constants that go stale on every rotation.
//   memeRotorTick()  - the rotation guard. When the market walks away from a
//                      band, withdraw it and re-quote at the current tick;
//                      whatever comes back re-deploys on its own side (ETH into
//                      a buy band, tokens into a sell band). This is the same
//                      cycle proven by hand on 2026-08-04, now on the guard's
//                      clock. Runs INSIDE lpGuard's tick, so it already holds
//                      the house-wallet lock and the one-process guarantee.
//
// Every write is eth_call simulated before sending, and every rail is cheap to
// reason about: single-sided bands have no spread-crossing churn cost, so the
// only real risks are thrash (rate-limited) and encoding (simulated).
import { appendFileSync } from "node:fs";
import {
  formatEther,
  maxUint160,
  maxUint256,
  parseAbiItem,
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  parseAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  ETH_POOLS,
  PERMIT2,
  type EthPool,
  poolId,
  ethPoolSlot0,
  buildNativeOnlyMint,
  buildTokenOnlyMint,
  buildNativeWithdraw,
} from "./venues/ethPools.js";
import { getPublicClient, getWalletClient, getAgentSigner, getAgentAddress } from "./venues/signer.js";
import { TREASURY_WALLET } from "./merd/wallets.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { discoverOwnedPositions } from "./venues/lpPositions.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { candidateVenues, analyzeEthPools, vetRow, type CandidateVenue } from "./signals/tokenAnalyst.js";
import { sellTokenForEth } from "./venues/ethSwap.js";
import { dataPath } from "./dataDir.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NATIVE = "0x0000000000000000000000000000000000000000";
const POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROTATION_JOURNAL = dataPath("meme-rotations.jsonl");
// Every swap the fast watcher already sees, persisted: size, direction, tick.
// Pure recording, no behavior change. This is the dataset that turns
// hand-tuned knobs (patience windows, knife thresholds, band widths, side
// skew) into measured per-pool curves: hourly liquidity profiles, realized
// volatility, flow imbalance, fill-probability by distance-from-spot.
const FLOW_LOG = dataPath("pool-flow.jsonl");

// Rails. Out-of-range must PERSIST before a move (filters oscillation), moves
// are globally rate-limited and day-capped, and legs below the dust floor stay
// in the wallet for the allocator to count instead of paying gas to park.
// Clocks tuned 2026-08-04 after a 5% dump left a filled book waiting ~90min:
// 10min persistence + 7min gaps re-quote a whole 5-band book inside ~40min.
// The exception is deliberate: ETH buy bands during a measured dump keep the
// SLOW clock and place DEEPER, because fast re-quoting into a falling market
// is how a desk ladders its whole float into a knife.
const OUT_OF_RANGE_MIN_MS = 10 * 60 * 1000;
const KNIFE_PERSIST_MS = 30 * 60 * 1000;
const GLOBAL_COOLDOWN_MS = 7 * 60 * 1000;
// A bid the price ran away from UPWARD is a different animal than a bid in a
// falling market: re-quoting up behind a rising price is knife-free (the new
// bid only fills on a pullback, which is the trade this desk wants), so it
// moves on a fast clock with a per-pool cooldown instead of contending with
// every other band globally. Tuned 2026-08-05: CASHCAT trended +5%/hr and
// chop-tuned clocks left every bid 1.7-7% stale, earning nothing.
const PUMP_CHASE_MIN_MS = 3 * 60 * 1000;
// 5min -> 90s on 2026-08-09. The cooldown existed to stop a price wiggle
// thrashing every band in a pool, but a re-quote must now be worth two
// spacings to spend anything, so churn is already blocked at the source.
// What the cooldown was actually buying was delay: four stranded bids in one
// pool recovered one at a time, leaving the whole venue earning nothing for
// fifteen minutes or more while the market traded without us.
const PUMP_CHASE_POOL_COOLDOWN_MS = 90 * 1000;
// 24 -> 36 with the pump-chase clock (2026-08-05): the cap is a runaway
// brake, not a pacing tool, and at 24 a trending day would freeze the desk
// out of range by evening, which is the exact failure the chase clock fixes.
// 36 -> 60 on 2026-08-06: a whipsaw night under the chase and volume clocks
// legitimately spends ~30 moves; at 36 the desk stalls by morning. The cap
// is a runaway brake, and the breaker now bounds the money, not the moves.
const DAILY_MOVE_CAP = 60;
/** A re-quote must shift the band at least this many spacings to be worth a
 *  move (an out-of-range band only needs one: it earns nothing where it is). */
const MIN_REQUOTE_SPACINGS = 2;
/** Chase re-quotes beyond the daily cap: a stranded bid always gets to follow
 *  the price, capped so this can never become an unbounded second budget.
 *  15 -> 40 on 2026-08-08: the reserve was sized before the min-improvement
 *  gate existed, and it ran dry with three bands stranded 5-7% under a rising
 *  market and 70 minutes left in the day. A chase now has to be worth two
 *  spacings to spend anything, so a larger reserve cannot be burned on
 *  micro-churn, only on genuinely following the price. */
const CHASE_RESERVE_MOVES = 40;
/** Overnight pacing. The budget resets at UTC midnight, straight into the
 *  thinnest hours of the day, and on 2026-08-08 the desk spent all 60 moves
 *  on overnight chop by 08:00 UTC and was benched through the entire active
 *  session that followed. Thin hours (00-08 UTC) may spend at most this share
 *  of the day's moves, so the budget is still there when the volume is.
 *  Chase re-quotes and every exit path are exempt: this paces new quoting,
 *  never following price and never getting out. */
const THIN_HOURS_MOVE_SHARE = 0.4;
const MIN_BAND_USD = 25;
const MIN_LEG_USD = 20;
const ERROR_BACKOFF_MS = 60 * 60 * 1000;
/** Tick drift above this (percent per hour, positive = token dumping) counts
 *  as a knife for the ETH side. Raised 1.5 -> 8 on 2026-08-05: a night of
 *  journaled rotations showed NORMAL chop in these pools runs 2-6%/hr and the
 *  real knives print 25-44%/hr, so 1.5 kept ordinary re-quotes in slow-deep
 *  knife mode and starved the book of near-spot bids. */
const DUMP_DRIFT_PCT_PER_HR = 8;

// --- Price velocity: the data behind positioning ahead of the market --------
// Every rotor tick records each pool's tick; drift over the trailing hour is
// the measured direction. It cannot front-run flow (nothing on a 5min public
// clock can), but it decides WHERE fresh quotes go: dumps get deeper bids
// instead of chased ones, and everything is journaled for tuning.
const poolTickHistory = new Map<string, { t: number; tick: number }[]>();

function recordTicks(bands: MemeBand[]): void {
  const now = Date.now();
  const seen = new Set<string>();
  for (const b of bands) {
    if (seen.has(b.poolId)) continue;
    seen.add(b.poolId);
    const h = poolTickHistory.get(b.poolId) ?? [];
    h.push({ t: now, tick: b.currentTick });
    while (h.length && now - h[0].t > 2 * 60 * 60 * 1000) h.shift();
    poolTickHistory.set(b.poolId, h);
  }
}

/** Trailing-hour tick drift as percent per hour; positive = tick rising =
 *  token getting cheaper (a dump). Null until enough history exists. */
export function tickDriftPctPerHour(history: { t: number; tick: number }[], now: number): number | null {
  const win = history.filter((s) => now - s.t <= 60 * 60 * 1000);
  if (win.length < 3) return null;
  const hrs = (win[win.length - 1].t - win[0].t) / 3_600_000;
  if (hrs < 0.15) return null;
  return (1.0001 ** ((win[win.length - 1].tick - win[0].tick) / hrs) - 1) * 100;
}

export interface MemeBand {
  tokenId: string;
  symbol: string;
  token: Address;
  feePct: number;
  poolId: string;
  side: "eth" | "token" | "mixed";
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  ethAmount: number;
  tokenAmount: number;
  /** Token's price in ETH at the pool's current tick. */
  tokenPriceEth: number;
  valueUsd: number;
  /** Fees accrued inside the position and not yet collected, straight from
   *  feeGrowthInside: the "watch Merd earn" numbers, ticking on every read. */
  feesEth: number;
  feesToken: number;
  feesUsd: number;
}

const sqrtAt = (tick: number) => Math.sqrt(1.0001 ** tick);

/** What a range holds at a given pool state: pure Uniswap geometry, exported
 *  for tests. sqrtP is the pool's sqrtPriceX96 already divided by 2^96. */
export function bandAmounts(liquidity: number, tickLower: number, tickUpper: number, sqrtP: number): { eth: number; token: number } {
  const sA = sqrtAt(tickLower);
  const sB = sqrtAt(tickUpper);
  const sC = Math.min(Math.max(sqrtP, sA), sB);
  return {
    eth: (liquidity * (sB - sC)) / (sC * sB) / 1e18,
    token: (liquidity * (sC - sA)) / 1e18,
  };
}

/** Where a fresh band would sit for this pool at this tick. Comparing the
 *  result to a live band's range IS the rotation decision: equal means the
 *  quote is already where the desk would place it (the 08-04 STONK no-op). */
export function targetRange(p: EthPool, tick: number, side: "eth" | "token", offsetAbove = p.offsetAbove): { tickLower: number; tickUpper: number } {
  const ts = p.tickSpacing;
  const width = p.widthSpacings ?? 8;
  if (side === "eth") {
    const tickLower = (Math.floor(tick / ts) + Math.max(1, offsetAbove)) * ts;
    return { tickLower, tickUpper: tickLower + width * ts };
  }
  const tickUpper = (Math.floor(tick / ts) - 1) * ts;
  return { tickLower: tickUpper - width * ts, tickUpper };
}

/** High two-way volume with calm drift is when tight quoting pays: every
 *  fill-flip round trip earns the fee twice, and a narrower band takes a
 *  larger share of each swap. Trend or knife conditions keep the standard
 *  conservative placement (the chase and knife clocks own those). Pure, for
 *  tests. Thresholds from 2026-08-05: the best fee bursts printed at 50+
 *  swaps/hr with drift under 4%/hr. */
export function volumeMode(pulseSwapsPerHour: number, driftPctPerHr: number | null): boolean {
  return pulseSwapsPerHour >= 50 && driftPctPerHr != null && Math.abs(driftPctPerHr) < 4;
}
/** Volume ROTATION: the earn window crowns yesterday's winner, but liquidity
 *  moves venues in minutes (2026-08-07: STONK at 551 swaps/hr while the desk
 *  kept compounding into CASHCAT's fading window). A live pulse this dominant
 *  over the current leader's preempts the compound and sends the next probe
 *  where the volume actually IS. Pure, for tests. */
export function volumeRotated(candidatePulse: number, leaderPulse: number): boolean {
  return candidatePulse >= 200 && candidatePulse >= 2 * Math.max(leaderPulse, 1);
}

/** Where the capitulation wick lives, in spacings above spot-in-ticks (price
 *  falls = tick rises): deep enough that only a climax spike fills it. Pure,
 *  for tests. */
export function capitulationDepthSpacings(tickSpacing: number, depthPct = 9): number {
  const ticks = Math.log(1 / (1 - depthPct / 100)) / Math.log(1.0001);
  return Math.max(2, Math.ceil(ticks / tickSpacing));
}

/** Is moving this quote worth spending a move? A re-quote that shifts the
 *  band by less than a couple of spacings buys almost no fill probability and
 *  costs two transactions plus a slot in the daily budget: 28 CASHCAT
 *  rotations in five hours (2026-08-08) ate the whole cap by breakfast and
 *  benched the desk for sixteen hours. Pure, for tests. */
export function worthRequoting(
  current: { tickLower: number; tickUpper: number },
  target: { tickLower: number; tickUpper: number },
  tickSpacing: number,
  minSpacings = 2,
): boolean {
  const shift = Math.max(Math.abs(target.tickLower - current.tickLower), Math.abs(target.tickUpper - current.tickUpper));
  return shift >= minSpacings * tickSpacing;
}

const tightened = (p: EthPool): EthPool => ({
  ...p,
  offsetAbove: 1,
  widthSpacings: Math.max(2, Math.floor((p.widthSpacings ?? 8) / 2)),
});

// The venue registry the desk trades: the pinned ETH_POOLS plus any venue the
// migration path has since entered, persisted so a restart keeps managing
// them. A venue in this map is one the rotor may quote; anything else is
// display-only.
const VENUES_PATH = dataPath("meme-venues.json");
const venueByToken = new Map(Object.values(ETH_POOLS).map((p) => [p.token.toLowerCase(), p]));
try {
  if (existsSync(VENUES_PATH)) {
    for (const p of JSON.parse(readFileSync(VENUES_PATH, "utf8")) as EthPool[]) {
      if (!venueByToken.has(p.token.toLowerCase())) venueByToken.set(p.token.toLowerCase(), p);
    }
  }
} catch { /* a bad file just means the pinned registry */ }

function persistDynamicVenues(): void {
  const dynamic = [...venueByToken.values()].filter((p) => !ETH_POOLS[p.symbol]);
  writeFileSync(VENUES_PATH, JSON.stringify(dynamic, null, 2));
}

/**
 * Every native-quoted LP position the wallet holds, valued at the pool's
 * current state. Unknown tokens still show up (short address as the name):
 * capital is never hidden because a registry entry is missing.
 */
/** Latest full band read, kept for the fast watcher's edge detection. */
let lastBandsSnapshot: MemeBand[] = [];

export async function memeBandsLive(): Promise<MemeBand[]> {
  const wallet = getAgentAddress();
  if (!wallet) return [];
  const [positions, ethUsd] = await Promise.all([discoverOwnedPositions(wallet), fetchEthUsd()]);
  const client = getPublicClient();
  // An RPC can soft-fail a log scan: answer [] without erroring, which reads
  // as "genuinely flat" and once painted the site -$796 while $876 worked
  // on-chain. The chain itself is the invariant: if discovery says the wallet
  // owns NOTHING but balanceOf says it holds position NFTs, the scan was
  // partial garbage and must THROW into the null path, never render as flat.
  // (A real fully-flat book still discovers its old zero-liquidity shells, so
  // this guard cannot false-positive on honest flatness.)
  if (positions.length === 0) {
    const owned = await client.readContract({
      address: POSITION_MANAGER,
      abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
      functionName: "balanceOf",
      args: [wallet],
    });
    if (owned > 0n) throw new Error(`position discovery returned none but the wallet holds ${owned} position NFTs: partial log response`);
  }
  const native = positions.filter((p) => p.currency0.toLowerCase() === NATIVE && p.liquidity > 0n);
  if (native.length === 0) return [];
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
  const out: MemeBand[] = [];
  const slots = new Map<string, { sqrtP: number; tick: number }>();
  // feeGrowthInside wraps deliberately; mask the subtraction like the pool does.
  const U256 = 1n << 256n;
  const growthDelta = (now: bigint, last: bigint) => (now - last + U256) % U256;

  for (const p of native) {
    const reg = venueByToken.get(p.currency1.toLowerCase());
    const id = reg
      ? poolId(reg)
      : keccak256(
          encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
            NATIVE,
            p.currency1,
            p.fee,
            p.tickSpacing,
            NATIVE,
          ]),
        );
    let slot = slots.get(id);
    if (!slot) {
      const [sqrtP, tick] = await client.readContract({ address: STATE_VIEW, abi: slot0Abi, functionName: "getSlot0", args: [id] });
      slot = { sqrtP: Number(sqrtP) / 2 ** 96, tick: Number(tick) };
      slots.set(id, slot);
    }
    const { eth, token } = bandAmounts(Number(p.liquidity), p.tickLower, p.tickUpper, slot.sqrtP);
    const tokenPriceEth = 1 / slot.sqrtP ** 2;
    const inRange = slot.tick >= p.tickLower && slot.tick < p.tickUpper;

    // Uncollected fees, the earning made visible: growth since the position's
    // last checkpoint times its liquidity. Best-effort per band; a failed read
    // shows zero rather than hiding the position.
    let feesEth = 0;
    let feesToken = 0;
    try {
      const salt = `0x${BigInt(p.tokenId).toString(16).padStart(64, "0")}` as Hex;
      const posKey = keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [POSITION_MANAGER, p.tickLower, p.tickUpper, salt]));
      const [posLiq, last0, last1] = await client.readContract({
        address: STATE_VIEW,
        abi: [parseAbiItem("function getPositionInfo(bytes32,bytes32) view returns (uint128,uint256,uint256)")],
        functionName: "getPositionInfo",
        args: [id, posKey],
      });
      const [now0, now1] = await client.readContract({
        address: STATE_VIEW,
        abi: [parseAbiItem("function getFeeGrowthInside(bytes32,int24,int24) view returns (uint256,uint256)")],
        functionName: "getFeeGrowthInside",
        args: [id, p.tickLower, p.tickUpper],
      });
      const L = Number(posLiq);
      feesEth = (Number(growthDelta(now0, last0)) * L) / 2 ** 128 / 1e18;
      feesToken = (Number(growthDelta(now1, last1)) * L) / 2 ** 128 / 1e18;
    } catch { /* fees read failed; the band still shows */ }

    out.push({
      tokenId: p.tokenId,
      symbol: reg?.symbol ?? `${p.currency1.slice(0, 6)}..${p.currency1.slice(-4)}`,
      token: p.currency1,
      feePct: p.fee / 10000,
      poolId: id,
      side: eth > 0 && token > 0 ? "mixed" : token > 0 ? "token" : "eth",
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      currentTick: slot.tick,
      inRange,
      ethAmount: eth,
      tokenAmount: token,
      tokenPriceEth,
      valueUsd: (eth + token * tokenPriceEth) * ethUsd,
      feesEth,
      feesToken,
      feesUsd: (feesEth + feesToken * tokenPriceEth) * ethUsd,
    });
  }
  lastBandsSnapshot = out;
  return out;
}

// --- The fast desk: seconds-scale detection ----------------------------------
// The public RPC has no WebSocket, but it sustains sub-second HTTP polls, and
// the Swap event carries the post-swap tick: a ~1.5s getLogs poll over exactly
// our pool ids gives second-scale detection with zero extra reads. The fast
// path acts on ONE condition only, a band FILLING through its top (its ETH
// fully converted to tokens): confirmed for 45s, that inventory flips to a
// sell band above the new spot, so bounces get sold in under a minute instead
// of after ten. Bid placement stays on the slow, velocity-gated clock on
// purpose: fast asks are safe, fast bids are how a knife takes the float.
const FAST_POLL_MS = 1500;
const FAST_CONFIRM_MS = 45 * 1000;
const FAST_POOL_COOLDOWN_MS = 90 * 1000;

const swapEventAbi = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

const hotTick = new Map<string, number>();
// Live pulse per watched pool: swap timestamps from the fast watcher, kept
// one hour. A pool with a great 24h resume can still be DEAD right now
// (BOURSE entered 2026-08-05 with zero swaps/hr; its band was 21% off spot
// within minutes because a dead pool's spot teleports). Entries require a
// pulse, not just a vetting pass.
const swapPulse = new Map<string, number[]>();
export function poolPulse(pid: string): number {
  const now = Date.now();
  const arr = (swapPulse.get(pid) ?? []).filter((t) => now - t < 3600_000);
  swapPulse.set(pid, arr);
  return arr.length;
}
const pendingFastFlip = new Map<string, number>();
const lastFastMove = new Map<string, number>();
let fastInFlight = false;

/** Pure trigger: a band whose ETH side has fully converted through the top.
 *  Exported for tests. */
export function fastFlipCondition(band: MemeBand, tick: number): boolean {
  return band.side !== "token" && tick >= band.tickUpper;
}

function onSwap(pid: string, tick: number): void {
  hotTick.set(pid, tick);
  (swapPulse.get(pid) ?? swapPulse.set(pid, []).get(pid)!).push(Date.now());
  // Fine-grained velocity: the same history the slow rotor's knife gate reads.
  const h = poolTickHistory.get(pid) ?? [];
  const now = Date.now();
  if (!h.length || now - h[h.length - 1].t > 5_000) {
    h.push({ t: now, tick });
    while (h.length && now - h[0].t > 2 * 60 * 60 * 1000) h.shift();
    poolTickHistory.set(pid, h);
  }
  maybeFastStop(pid, tick);
  maybeSummonRotor(pid, tick);

  const flip = lastBandsSnapshot.some((b) => b.poolId.toLowerCase() === pid && fastFlipCondition(b, tick));
  if (!flip) {
    pendingFastFlip.delete(pid);
    return;
  }
  const since = pendingFastFlip.get(pid) ?? (pendingFastFlip.set(pid, now), now);
  if (now - since < FAST_CONFIRM_MS) return;
  if (now - (lastFastMove.get(pid) ?? 0) < FAST_POOL_COOLDOWN_MS) return;
  if (fastInFlight) return;
  fastInFlight = true;
  pendingFastFlip.delete(pid);
  withHouseWalletLock("memeFast", () => fastFlipPass(pid))
    .catch((err) => console.error(`[memeFast] pass failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`))
    .finally(() => {
      lastFastMove.set(pid, Date.now());
      fastInFlight = false;
    });
}

async function fastFlipPass(pid: string): Promise<void> {
  const signer = getAgentSigner();
  if (!signer || deskHalted()) return;
  const [bands, ethUsd] = await Promise.all([memeBandsLive(), fetchEthUsd()]);
  for (const b of bands) {
    if (b.poolId.toLowerCase() !== pid) continue;
    if (b.inRange || b.side !== "token") continue; // must CONFIRM as filled on authoritative data
    if (b.valueUsd < MIN_BAND_USD) continue;
    if (movesToday >= DAILY_MOVE_CAP) return;
    const reg = venueByToken.get(b.token.toLowerCase());
    if (!reg) continue;
    const flipDrift = tickDriftPctPerHour(poolTickHistory.get(pid) ?? [], Date.now());
    const eff = volumeMode(poolPulse(pid), flipDrift) ? tightened(reg) : reg;
    const target = targetRange(eff, b.currentTick, "token");
    if (target.tickLower === b.tickLower && target.tickUpper === b.tickUpper) continue;
    await rotate(eff, b, ethUsd, eff.offsetAbove, flipDrift);
    movesToday += 1;
    lastMoveAt = Date.now();
    console.log(`[memeFast] flipped filled band #${b.tokenId} (${reg.symbol}) to the sell side, seconds after confirmation`);
  }
}

/**
 * Start the fast watcher. Runs alongside the 5-minute guard tick, which stays
 * the sweeper for collects, expansion and migration. Kill switch:
 * MERIDIAN_MEME_FAST=off. Re-subscribes when the venue set grows.
 */
export function startMemeFastWatch(): () => void {
  if (process.env.MERIDIAN_MEME_FAST === "off") return () => {};
  if (!getAgentSigner()) return () => {};
  const client = getPublicClient();
  void memeBandsLive().catch(() => {}); // prime the snapshot
  let watchedCount = venueByToken.size;
  const subscribe = () =>
    client.watchEvent({
      address: POOL_MANAGER,
      event: swapEventAbi,
      args: { id: [...venueByToken.values()].map((p) => poolId(p)) },
      pollingInterval: FAST_POLL_MS,
      onLogs: (logs) => {
        for (const l of logs) {
          const pid = String(l.args.id).toLowerCase();
          const tick = Number(l.args.tick);
          try {
            appendFileSync(
              FLOW_LOG,
              `${JSON.stringify({ t: Date.now(), p: pid.slice(0, 10), tick, a0: String(l.args.amount0), a1: String(l.args.amount1) })}\n`,
            );
          } catch { /* recording must never cost the watcher */ }
          onSwap(pid, tick);
        }
      },
      onError: () => { /* transient; the poller retries on its own */ },
    });
  let unwatch = subscribe();
  const resub = setInterval(() => {
    saveRotorState(); // the fast watcher accumulates tick history between rotor passes
    if (venueByToken.size !== watchedCount) {
      watchedCount = venueByToken.size;
      unwatch();
      unwatch = subscribe();
    }
  }, 60_000);
  console.log(`[memeFast] watching ${watchedCount} venue(s) at ${FAST_POLL_MS}ms`);
  return () => {
    clearInterval(resub);
    unwatch();
  };
}

// --- The rotor ---------------------------------------------------------------

const outOfRangeSince = new Map<string, number>();
const errorBackoffUntil = new Map<string, number>();
let lastPassLogAt = 0;
let lastExpandVerdictAt = 0;
let lastCapLogAt = 0;
let chaseExtraToday = 0;
let lastMoveAt = 0;
const poolMoveAt = new Map<string, number>();
let movesDay = "";
let movesToday = 0;

// --- Per-venue earn tracking: who is actually printing -----------------------
// Accrued-fee DELTAS observed across ticks, summed per pool in a ~24h sliding
// window (halved when the window ages out, a cheap decay). Collects and
// rotations drop a band's accrual to zero; only increases count, so sweeping
// fees home never erases the record that the venue earned them. This is the
// measurement behind concentration: float compounds into the best earner, and
// a venue whose window shows nothing gets cut.
const bandFeesPrev = new Map<string, number>();
const poolEarnWindow = new Map<string, { usd: number; start: number }>();
const EARN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A venue must have earned at least this in its window to count as printing. */
const MIN_PRINTING_USD = 1;
/** Concentration cap: the best earner takes the float until it holds this share
 *  of the band book. Concentrated, not all-in: one memecoin never becomes the
 *  whole desk. Raised 0.6 -> 0.75 on the operator's concentration order
 *  (2026-08-05): measured 7x per-dollar earn gaps deserve weight. */
const MAX_VENUE_SHARE = 0.75;

/** A leader must be genuinely printing AND out-earn the laggard 3x in the
 *  window before working capital moves venues. Pure, for tests. */
export function shouldConcentrate(leaderWindowUsd: number, laggardWindowUsd: number): boolean {
  return leaderWindowUsd >= MIN_PRINTING_USD && leaderWindowUsd >= 3 * laggardWindowUsd;
}

// COMPOUNDING NEEDS A PULSE, NOT A MEMORY.
//
// poolEarnWindow is a 24-HOUR cumulative, and MIN_PRINTING_USD is $1, so
// "genuinely printing" has meant "earned a dollar at some point since this time
// yesterday". A venue that stopped earning an hour ago still reads as the best
// earner in the book, and the compounder keeps feeding it.
//
// Measured 2026-08-09, live:
//
//   15:22Z  working $30   accruing $0.15   fees $393.01
//   15:30Z  working $92   accruing $0.15   fees $393.01
//   15:36Z  working $153  accruing $0.00   fees $393.01
//   15:44Z  working $214  accruing $0.00   fees $393.01
//
// Four expansions into STONKBROKER in twenty minutes while it fell 6.82%/hr.
// Accrual went to zero and the fee counter never moved again. The desk was
// buying a falling token with single-sided ETH bids that the price ran straight
// through, leaving every band out of range, and then reading its own 24-hour
// memory as proof the venue was still worth adding to.
//
// This is the same window illusion the probe path already names and guards
// against ("window remembers a move, tape is calm and heavy"). The compound path
// had no equivalent. So the last time a pool actually earned is now recorded,
// and compounding requires it to be RECENT. The 24-hour window keeps its other
// jobs (migration's "barely earned" test, the laggard comparison) where a long
// memory is the right instrument.
const COMPOUND_FRESH_MS = 45 * 60 * 1000;
const poolLastEarnedAt = new Map<string, number>();

/** True when a pool has earned recently enough to deserve more capital. */
export function earningNow(lastEarnedAt: number | undefined, now: number, freshMs = COMPOUND_FRESH_MS): boolean {
  if (lastEarnedAt == null) return false; // never seen earning: not a compound target
  return now - lastEarnedAt <= freshMs;
}

function updateEarnTracking(bands: MemeBand[]): void {
  const now = Date.now();
  for (const b of bands) {
    const prev = bandFeesPrev.get(b.tokenId) ?? 0;
    if (b.feesUsd > prev) {
      const w = poolEarnWindow.get(b.poolId) ?? { usd: 0, start: now };
      if (now - w.start > EARN_WINDOW_MS) {
        w.usd /= 2;
        w.start = now;
      }
      w.usd += b.feesUsd - prev;
      poolEarnWindow.set(b.poolId, w);
      // The moment of earning, kept separately from the cumulative. This is the
      // only place a pool is observed actually paying us.
      poolLastEarnedAt.set(b.poolId, now);
    }
    bandFeesPrev.set(b.tokenId, b.feesUsd);
  }
}

/** The quoted venue currently earning the most, if it is genuinely printing
 *  and not already at the concentration cap. */
function bestEarner(bands: MemeBand[], idleCapitalUsd = 0): { pool: EthPool; poolId: string } | null {
  // The share cap protects THE DESK, and the desk is bands plus bankroll:
  // measured against bands alone, a lone printing band reads as 100% and the
  // compounder blocks itself forever while capital idles (2026-08-06, $510
  // sat out a 548-swap/hr tape). Callers that move only band capital pass 0.
  const totalBook = bands.reduce((s, b) => s + b.valueUsd, 0) + idleCapitalUsd;
  let best: { pool: EthPool; poolId: string; usd: number } | null = null;
  const now = Date.now();
  for (const [pid, w] of poolEarnWindow) {
    if (w.usd < MIN_PRINTING_USD) continue;
    // Cumulative says it HAS earned; this says it IS earning. Both, or no
    // capital: a venue that stopped paying an hour ago is not a compound
    // target no matter what the 24-hour window remembers.
    if (!earningNow(poolLastEarnedAt.get(pid), now)) continue;
    const poolBands = bands.filter((b) => b.poolId === pid);
    if (poolBands.length === 0) continue;
    const share = poolBands.reduce((s, b) => s + b.valueUsd, 0) / (totalBook || 1);
    if (share >= MAX_VENUE_SHARE) continue;
    const reg = venueByToken.get(poolBands[0].token.toLowerCase());
    if (!reg) continue;
    if (!best || w.usd > best.usd) best = { pool: reg, poolId: pid, usd: w.usd };
  }
  return best;
}

async function ensureTokenApprovals(p: EthPool, amountWei: bigint): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const erc20 = await client.readContract({
    address: p.token,
    abi: [parseAbiItem("function allowance(address, address) view returns (uint256)")],
    functionName: "allowance",
    args: [signer.address, PERMIT2],
  });
  if (erc20 < amountWei) {
    const data = encodeFunctionData({ abi: [parseAbiItem("function approve(address, uint256) returns (bool)")], functionName: "approve", args: [PERMIT2, maxUint256] });
    const h = await wallet.sendTransaction({ to: p.token, data });
    await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
  }
  const [p2] = await client.readContract({
    address: PERMIT2,
    abi: [parseAbiItem("function allowance(address, address, address) view returns (uint160, uint48, uint48)")],
    functionName: "allowance",
    args: [signer.address, p.token, POSITION_MANAGER],
  });
  if (p2 < amountWei) {
    const data = encodeFunctionData({
      abi: [parseAbiItem("function approve(address, address, uint160, uint48)")],
      functionName: "approve",
      args: [p.token, POSITION_MANAGER, maxUint160, 2 ** 48 - 1],
    });
    const h = await wallet.sendTransaction({ to: PERMIT2, data });
    await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
  }
}

const mintedIdFrom = (logs: { address: string; topics: readonly (string | undefined)[] }[]): string | null => {
  const l = logs.find((x) => x.address.toLowerCase() === POSITION_MANAGER && x.topics[0] === TRANSFER_TOPIC && /^0x0+$/.test(x.topics[1] ?? "x"));
  return l?.topics[3] ? BigInt(l.topics[3]).toString() : null;
};

/**
 * One rotation pass. Called from lpGuard's tick, already inside the
 * house-wallet lock; must never throw (a meme error must not cost an equity
 * tick, and vice versa is handled by the caller's ordering).
 */
export async function memeRotorTick(): Promise<void> {
  if (process.env.MERIDIAN_MEME_ROTATOR === "off") return;
  const signer = getAgentSigner();
  if (!signer) return;

  let bands: MemeBand[];
  let ethUsd: number;
  try {
    [bands, ethUsd] = await Promise.all([memeBandsLive(), fetchEthUsd()]);
  } catch (err) {
    console.error(`[memeRotor] read failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== movesDay) {
    movesDay = today;
    movesToday = 0;
    chaseExtraToday = 0;
  }

  // Heartbeat, throttled: silence must be distinguishable from death.
  if (Date.now() - lastPassLogAt > 5 * 60 * 1000) {
    lastPassLogAt = Date.now();
    console.log(`[memeRotor] pass: ${bands.length} band(s), \$${bands.reduce((x, b) => x + b.valueUsd, 0).toFixed(0)} working`);
  }
  updateEarnTracking(bands);
  recordTicks(bands);
  trackFillsAndToxicity(bands, new Map(bands.map((b) => [b.poolId.toLowerCase(), b.feePct ?? 1])));

  // Halted by the circuit breaker: exits and sweeps stay armed (safety always
  // runs), everything that ADDS risk waits for tomorrow. Same principle as the
  // daily cap below: a limit on new quotes is never a limit on getting out.
  if (deskHalted()) {
    await inventoryStopLoss(bands, ethUsd);
    saveRotorState();
    return;
  }

  for (const b of bands) {
    if (b.inRange || b.side === "mixed") {
      outOfRangeSince.delete(b.tokenId);
      poolLastEarned.set(b.poolId, Date.now());
      continue;
    }
    if (!poolLastEarned.has(b.poolId)) poolLastEarned.set(b.poolId, Date.now());
    const reg = venueByToken.get(b.token.toLowerCase());
    if (!reg) continue; // unknown venue: display it, never trade it
    const now = Date.now();
    const since = outOfRangeSince.get(b.tokenId) ?? (outOfRangeSince.set(b.tokenId, now), now);
    // Measured direction decides the clock and the placement. A dumping token
    // gets slow, DEEP bids (never chase a knife); everything else, including
    // every sell-side flip of filled inventory, moves on the fast clock.
    const drift = tickDriftPctPerHour(poolTickHistory.get(b.poolId) ?? [], now);
    const knife = b.side === "eth" && drift != null && drift > DUMP_DRIFT_PCT_PER_HR;
    // currentTick BELOW the bid's range = the price rose past it (tick down =
    // pricier). That is the chase-up case: fast clock, pool-local cooldown.
    const pumpChase = !knife && b.side === "eth" && b.currentTick < b.tickLower;
    // Volume mode: hot pulse + calm drift quotes one spacing off spot at half
    // width, so fills cycle and each swap pays a bigger share. Mutually
    // exclusive with knife by construction (drift thresholds do not overlap).
    const vm = !knife && volumeMode(poolPulse(b.poolId), drift);
    const eff = vm ? tightened(reg) : reg;
    if (now - since < (knife ? KNIFE_PERSIST_MS : pumpChase ? PUMP_CHASE_MIN_MS : OUT_OF_RANGE_MIN_MS)) continue;
    if ((errorBackoffUntil.get(b.tokenId) ?? 0) > now) continue;
    if (b.valueUsd < MIN_BAND_USD) continue;
    if (pumpChase
      ? now - (poolMoveAt.get(b.poolId) ?? 0) < PUMP_CHASE_POOL_COOLDOWN_MS
      : now - lastMoveAt < GLOBAL_COOLDOWN_MS) continue;
    // The cap is a runaway brake, but a band the price walked away from must
    // always be able to follow it: chase re-quotes draw on a reserve beyond
    // the cap so a stranded bid is never stuck out of range all day.
    const chaseReserved = pumpChase && chaseExtraToday < CHASE_RESERVE_MOVES;
    // Overnight pacing: hold back most of the budget for the active session.
    const utcHour = new Date().getUTCHours(); // inline, not the thinHours() declared far below
    if (!chaseReserved && utcHour < 8 && movesToday >= Math.floor(DAILY_MOVE_CAP * THIN_HOURS_MOVE_SHARE)) {
      if (Date.now() - lastCapLogAt > 10 * 60 * 1000) {
        lastCapLogAt = Date.now();
        console.error(`[memeRotor] overnight pacing: ${movesToday}/${Math.floor(DAILY_MOVE_CAP * THIN_HOURS_MOVE_SHARE)} thin-hours moves spent, saving the rest for the session; chases and exits stay armed`);
      }
      break;
    }
    if (movesToday >= DAILY_MOVE_CAP && !chaseReserved) {
      if (Date.now() - lastCapLogAt > 10 * 60 * 1000) {
        lastCapLogAt = Date.now();
        console.error(`[memeRotor] daily cap ${DAILY_MOVE_CAP} reached (chase reserve ${chaseExtraToday}/${CHASE_RESERVE_MOVES}); holding new quotes until UTC midnight, exits stay armed`);
      }
      // BREAK, never return: the cap governs risk-ADDING moves only. The
      // stop ladder, the wallet sweep and the fee collect run below and must
      // never be skipped, or a capped desk would hold inventory overnight
      // with its exits switched off (found 2026-08-08).
      break;
    }
    const offsetAbove = knife ? reg.offsetAbove + 2 : eff.offsetAbove;
    const target = targetRange(eff, b.currentTick, b.side, offsetAbove);
    // Only spend a move when the quote is materially better, unless the band
    // is stranded OUT of range (then any improvement is worth having).
    const stranded = !b.inRange;
    if (!worthRequoting({ tickLower: b.tickLower, tickUpper: b.tickUpper }, target, reg.tickSpacing, stranded ? 1 : MIN_REQUOTE_SPACINGS)) continue;

    try {
      await rotate(eff, b, ethUsd, offsetAbove, drift);
      poolMoveAt.set(b.poolId, Date.now());
      // A chase-up rotation deliberately does NOT bump the global clock:
      // making other venues wait because one pool is trending would recreate
      // the contention the pool-local cooldown exists to remove.
      if (!pumpChase) lastMoveAt = Date.now();
      if (movesToday >= DAILY_MOVE_CAP) chaseExtraToday += 1;
      movesToday += 1;
      outOfRangeSince.delete(b.tokenId);
    } catch (err) {
      errorBackoffUntil.set(b.tokenId, Date.now() + ERROR_BACKOFF_MS);
      console.error(`[memeRotor] rotation of #${b.tokenId} failed (backing off 1h): ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }

  await inventoryStopLoss(bands, ethUsd);
  await collectAndSkim(bands, ethUsd);
  await maybeConcentrate(bands, ethUsd);
  await maybeExpand(bands, ethUsd);
  await maybeMigrate(bands, ethUsd);
  await maybeCatchCapitulation(bands, ethUsd);
  saveRotorState();
}

// --- Fill-markout surveillance: are we someone's exit liquidity? -------------
// A venue can pass every volume gate and still farm us: informed flow fills
// our bids right before the move continues, and our fills are systematically
// underwater beyond what fees repay. Every observed bid fill is marked out
// 10 minutes later against the pool tick; a venue whose recent fills average
// worse than fees-plus-a-buffer is FARMING us and is blocked from receiving
// entries for hours. Measurement first, accusation second: three fills
// minimum before any verdict.
const MARKOUT_EVAL_MS = 10 * 60 * 1000;
const MARKOUT_MIN_FILLS = 3;
const TOXIC_BLOCK_MS = 4 * 60 * 60 * 1000;
const prevSideByToken = new Map<string, string>();
const pendingFillEvals: { pid: string; symbol: string; fillTick: number; at: number }[] = [];
const fillMarkout = new Map<string, { n: number; sumPct: number }>();
const poolToxicUntil = new Map<string, number>();

export function poolBlockedForToxicity(pid: string): boolean {
  return (poolToxicUntil.get(pid) ?? 0) > Date.now();
}

function trackFillsAndToxicity(bands: MemeBand[], feePctByPid: Map<string, number>): void {
  const now = Date.now();
  for (const b of bands) {
    const prev = prevSideByToken.get(b.tokenId);
    // A bid that now holds tokens FILLED: record where, judge later.
    if (prev === "eth" && (b.side === "token" || b.side === "mixed")) {
      pendingFillEvals.push({ pid: b.poolId.toLowerCase(), symbol: b.token, fillTick: b.currentTick, at: now });
    }
    prevSideByToken.set(b.tokenId, b.side);
  }
  for (let i = pendingFillEvals.length - 1; i >= 0; i--) {
    const f = pendingFillEvals[i];
    if (now - f.at < MARKOUT_EVAL_MS) continue;
    pendingFillEvals.splice(i, 1);
    const hist = poolTickHistory.get(f.pid);
    const tickNow = hist?.length ? hist[hist.length - 1].tick : null;
    if (tickNow == null) continue;
    // Bought at fillTick; price change since = 1.0001^(fillTick - tickNow) - 1
    // (tick up = cheaper, so a further rise is a NEGATIVE markout on a buy).
    const pct = (Math.pow(1.0001, f.fillTick - tickNow) - 1) * 100;
    const m = fillMarkout.get(f.pid) ?? { n: 0, sumPct: 0 };
    m.n += 1;
    m.sumPct += pct;
    fillMarkout.set(f.pid, m);
    const avg = m.sumPct / m.n;
    const feePct = feePctByPid.get(f.pid) ?? 1;
    if (m.n >= MARKOUT_MIN_FILLS && avg < -(feePct * 2 + 1)) {
      poolToxicUntil.set(f.pid, now + TOXIC_BLOCK_MS);
      fillMarkout.set(f.pid, { n: 0, sumPct: 0 }); // fresh sample after the block
      appendFileSync(
        ROTATION_JOURNAL,
        `${JSON.stringify({ ts: now, kind: "toxicity-block", pool: f.symbol, avgMarkoutPct: Math.round(avg * 100) / 100, fills: MARKOUT_MIN_FILLS, blockedHours: TOXIC_BLOCK_MS / 3600e3 })}
`,
      );
      console.error(`[memeRotor] TOXICITY BLOCK: fills on ${f.pid.slice(0, 10)} average ${avg.toFixed(2)}% markout; no entries for ${TOXIC_BLOCK_MS / 3600e3}h`);
    }
  }
}

// --- The capitulation catcher ------------------------------------------------
// A flush used to only EXCUSE the desk (stand aside, dodge the knife). This
// makes it pay for showing up: when a watched pool is knifing hard and we are
// flat in it, place ONE deep, half-probation bid where the capitulation wick
// spikes, and let the existing machinery do the rest: the fast flip sells the
// rebound in minutes, the swap-speed stop bounds a knife that keeps going.
// Small by construction: one band, half size, three catches a day, and the
// breaker floor above it all. Kill switch: MERIDIAN_CATCHER=off.
const CATCH_MIN_DRIFT_PCT_PER_HR = 10;
const CATCH_MIN_PULSE = 30;
const CATCH_WIDTH_SPACINGS = 2;
const CATCHERS_PER_DAY = 3;
const CATCH_POOL_COOLDOWN_MS = 30 * 60 * 1000;
let catchDay = "";
let catchesToday = 0;
const lastCatchAt = new Map<string, number>();

async function maybeCatchCapitulation(bands: MemeBand[], ethUsd: number): Promise<void> {
  if (process.env.MERIDIAN_CATCHER === "off") return;
  const signer = getAgentSigner();
  if (!signer || deskHalted()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== catchDay) {
    catchDay = today;
    catchesToday = 0;
  }
  if (catchesToday >= CATCHERS_PER_DAY) return;
  if (movesToday >= DAILY_MOVE_CAP) return;

  for (const reg of venueByToken.values()) {
    const pid = poolId(reg).toLowerCase();
    if (bands.some((b) => b.poolId.toLowerCase() === pid)) continue; // only where we stand aside
    if (poolBlockedForToxicity(pid)) continue; // a farm's climax wick is bait
    const now = Date.now();
    if (now - (lastCatchAt.get(pid) ?? 0) < CATCH_POOL_COOLDOWN_MS) continue;
    const drift = tickDriftPctPerHour(poolTickHistory.get(pid) ?? [], now);
    if (drift == null || drift < CATCH_MIN_DRIFT_PCT_PER_HR) continue; // knives only
    if (poolPulse(pid) < CATCH_MIN_PULSE) continue; // a flush has volume; a dead slide does not

    try {
      const client = getPublicClient();
      const wallet = getWalletClient();
      const bal = await client.getBalance({ address: signer.address });
      const available = bal - EXPAND_GAS_FLOOR_WEI;
      if (available < EXPAND_MIN_ENTRY_WEI) return;
      const capWei = BigInt(Math.round((PROBATION_CAP_USD / 2 / ethUsd) * 1e18));
      const mintWei = available > capWei ? capWei : available;
      const depth = capitulationDepthSpacings(reg.tickSpacing);
      const deep: EthPool = { ...reg, offsetAbove: depth, widthSpacings: CATCH_WIDTH_SPACINGS };
      const { tick, sqrtP } = await ethPoolSlot0(deep);
      if (sqrtP === 0) return;
      const mint = buildNativeOnlyMint(deep, tick, mintWei, signer.address, depth);
      await client.call({ account: signer.address, to: mint.to, data: mint.data, value: mint.value });
      const h = await wallet.sendTransaction({ to: mint.to, data: mint.data, value: mint.value });
      const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
      if (r.status !== "success") throw new Error(`catcher mint reverted ${h}`);
      catchesToday += 1;
      movesToday += 1;
      lastCatchAt.set(pid, Date.now());
      poolMoveAt.set(pid, Date.now());
      appendFileSync(
        ROTATION_JOURNAL,
        `${JSON.stringify({ ts: Date.now(), kind: "capitulation-catch", venue: reg.symbol, driftPctPerHr: Math.round(drift * 100) / 100, depthSpacings: depth, ethIn: formatEther(mintWei), txs: [h] })}
`,
      );
      console.log(`[memeRotor] capitulation catcher set on ${reg.symbol}: knife ${drift.toFixed(1)}%/hr, bid ${depth} spacings deep`);
      return; // one catch per pass
    } catch (err) {
      console.error(`[memeRotor] catcher on ${reg.symbol} failed: ${err instanceof Error ? err.message.slice(0, 140) : err}`);
      return;
    }
  }
}

// --- Concentration: working capital follows the per-dollar leader ------------
// The operator's allocation order (2026-08-05): position size goes to the
// bands earning the most, not to being spread. Migration only moved DEAD
// venues; this moves WAITING capital out of measured laggards whenever the
// leader out-earns them 3x in the window. In-range bands never move (they are
// earning where they stand); only out-of-range, persistent waiters travel,
// and only their ETH side (tokens have their own exit ladder).
const CONCENTRATIONS_PER_DAY = 2;
let concDay = "";
let concToday = 0;

async function maybeConcentrate(bands: MemeBand[], ethUsd: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== concDay) {
    concDay = today;
    concToday = 0;
  }
  if (concToday >= CONCENTRATIONS_PER_DAY) return;
  if (Date.now() - lastMoveAt < GLOBAL_COOLDOWN_MS) return;
  const leader = bestEarner(bands);
  if (!leader) return;

  for (const b of bands) {
    if (b.poolId === leader.poolId) continue;
    if (b.inRange || b.side !== "eth") continue;
    const since = outOfRangeSince.get(b.tokenId);
    if (!since || Date.now() - since < OUT_OF_RANGE_MIN_MS) continue;
    if (b.valueUsd < MIN_BAND_USD) continue;
    const laggardEarn = poolEarnWindow.get(b.poolId)?.usd ?? 0;
    const leaderEarn = poolEarnWindow.get(leader.poolId)?.usd ?? 0;
    if (!shouldConcentrate(leaderEarn, laggardEarn)) continue;
    // The cap must hold AFTER the move: bestEarner checks the leader's share
    // before the migrated float is added, which is exactly how two
    // concentration moves walked one venue to 96% of the book on 2026-08-05
    // and a single token's dump became the whole desk's drawdown.
    const totalBook = bands.reduce((s, x) => s + x.valueUsd, 0);
    const leaderUsd = bands.filter((x) => x.poolId === leader.poolId).reduce((s, x) => s + x.valueUsd, 0);
    if (totalBook > 0 && (leaderUsd + b.valueUsd) / totalBook > MAX_VENUE_SHARE) continue;

    try {
      const srcReg = venueByToken.get(b.token.toLowerCase());
      if (!srcReg) continue;
      await migrate([b], leader.pool, ethUsd, {
        capped: false,
        adopt: false,
        reason: `concentrate: leader ${leader.pool.symbol} $${leaderEarn.toFixed(2)} vs $${laggardEarn.toFixed(2)} in window`,
      });
      concToday += 1;
      lastMoveAt = Date.now();
      outOfRangeSince.delete(b.tokenId);
      return; // one move per tick
    } catch (err) {
      console.error(`[memeRotor] concentration move of #${b.tokenId} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return;
    }
  }
}

// --- Never stuck: the inventory stop-loss ------------------------------------
// The operator's standing order is absolute: the desk never sits on token
// inventory. The exit ladder is (1) the maker exit, a sell band the rotor
// keeps re-quoting near spot, free and fee-EARNING, then (2) this: if the
// tokens are still held after MAX_HOLD, or the token has dropped
// STOP_DRAWDOWN below the price where the holding began, withdraw the bands
// and sell at market through the UniversalRouter in capped chunks. That pays
// the pool fee once and realizes the mark, and that bounded cost is the price
// of never being stuck. In-range mixed bands are WORKING inventory (an active
// two-sided quote) and are deliberately exempt; only out-of-range token bands
// and loose wallet balances count as stuck.
// Liquidity-aware patience: every timeout-stop in the journal fired between
// 02:50 and 06:15 UTC, when thin flow gives a maker exit little chance to
// fill in 30 minutes and the desk paid taker fees to leave positions the
// morning flow would have filled. Overnight gets triple the patience.
const TOKEN_MAX_HOLD_MS = 30 * 60 * 1000;
const TOKEN_MAX_HOLD_THIN_MS = 90 * 60 * 1000;

// PATIENCE SHOULD COME FROM THE TAPE, NOT THE CLOCK.
//
// The rule above proxies "thin" with UTC hours because every timeout-stop in
// the journal at the time had fired between 02:50 and 06:15. That is a fair
// read of a weekday and wrong on a weekend, when the tape can be dead at any
// hour.
//
// Measured 2026-08-09: both stops fired at 08:00Z, outside the overnight
// window, so they got the 30-minute patience. The tape was not busy. CASHCAT's
// pulse had collapsed from 548 swaps/hr to 35 the night before. A maker exit
// does not fill in a pool nobody is trading, so the desk waited out a clock it
// was never going to beat and then crossed the spread anyway, on a thin book,
// paying taker fees to leave. Sunday took five of those stops to earn $23.
//
// The bar is volumeMode's, deliberately: 50 swaps/hr is already this file's
// definition of enough flow to lean on, and having two different numbers for
// the same idea is how they drift apart.
//
// Two properties worth keeping when reading this. It is never LESS patient than
// the clock rule was, so it cannot cause a faster cut than today. And it only
// moves the TIME stop; the drawdown stop below is untouched and stays armed, so
// patience on a quiet tape never becomes patience with a loser.
const THIN_PULSE_SWAPS_PER_HR = 50;

export function makerExitPatienceMs(pulseSwapsPerHour: number | null, thinByClock: boolean): number {
  const thinByTape = pulseSwapsPerHour != null && pulseSwapsPerHour < THIN_PULSE_SWAPS_PER_HR;
  return thinByClock || thinByTape ? TOKEN_MAX_HOLD_THIN_MS : TOKEN_MAX_HOLD_MS;
}
const thinHours = () => { const h = new Date().getUTCHours(); return h >= 0 && h < 8; };
const TOKEN_STOP_DRAWDOWN_PCT = 4;
/** Realized hourly volatility proxy: summed absolute price moves between
 *  stored tick samples over the trailing hour, in percent. Pure, for tests. */
export function hourlyVolPct(history: { t: number; tick: number }[], now: number): number {
  const hour = history.filter((h) => now - h.t <= 60 * 60 * 1000);
  let vol = 0;
  for (let i = 1; i < hour.length; i++) {
    vol += Math.abs((Math.pow(1.0001, hour[i - 1].tick - hour[i].tick) - 1) * 100);
  }
  return Math.min(vol, 40);
}

/** The stop line a pool actually deserves: the jittered base floor, widened
 *  when the pool's own hourly chop exceeds it (a 4% tripwire inside 6%/hr
 *  chop is a churn tax, 4 of our first 5 drawdown stops), hard-capped at 7.
 *  Pure, for tests. */
export function effectiveStopPct(base: number, volPctPerHr: number): number {
  return Math.min(7, Math.max(base, 0.9 * volPctPerHr));
}
/** Stop hunting needs a KNOWN line; this removes it. The effective drawdown
 *  stop for a pool is 3.6-4.8%, deterministic per pool per UTC day (stable
 *  across passes and restarts, no flapping), so an adversary reverse-reading
 *  our journal history cannot aim at today's line. Pure, for tests. */
export function stopLinePct(poolId: string, day: string): number {
  let h = 0;
  const s = poolId + day;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 3.6 + (h % 121) / 100;
}
const STOP_CHUNK_USD = 200;
const STOP_MAX_CHUNKS_PER_PASS = 3;
const STOP_MIN_USD = 15;

// Serial stops in one pool are the same lesson repeating: each stop halves
// the next entry size there for the rest of the UTC day (floor 25%), and a
// third stop benches the pool until tomorrow. Persisted with the risk state.
const poolStopsToday = new Map<string, number>();
let poolStopsDay = "";
function rollStopDecayDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== poolStopsDay) {
    poolStopsDay = today;
    poolStopsToday.clear();
  }
}
export function entrySizeMultiplier(stops: number): number {
  return stops >= 3 ? 0 : Math.max(0.25, Math.pow(0.5, stops));
}

const tokenHeldSince = new Map<string, number>();
const tokenRefPriceEth = new Map<string, number>();

// --- Fast stop: the drawdown line checked at swap speed ----------------------
// The slow rotor evaluates the 4% inventory stop on its own cadence, which is
// how a 4% rule executed at 6.1% on 2026-08-05 (STONKBROKER dump; the extra
// 2.1% was pure evaluation latency). The fast watcher already hears every
// swap, and price is implied by the tick in the same convention the band read
// uses (1.0001^-tick), so the breach can be detected in seconds. A short
// confirm keeps a single wick from paying taker fees; the pass itself is the
// NORMAL stop (authoritative re-read, same chunked exit), just started early.
const FAST_STOP_CONFIRM_MS = 15 * 1000;
const FAST_STOP_COOLDOWN_MS = 5 * 60 * 1000;
const pendingFastStop = new Map<string, number>();
const lastFastStop = new Map<string, number>();

// A band the price just walked away from should not wait for a polling tick
// to be noticed: the swap that strands it SUMMONS a decision pass. 30s of
// confirmation (a wick is not a move), 2min per-pool cooldown, and the pass
// itself is the normal rotor under the normal lock, so every persistence
// clock and budget still applies: this collapses waiting, never discipline.
const SUMMON_CONFIRM_MS = 30 * 1000;
const SUMMON_COOLDOWN_MS = 2 * 60 * 1000;
const pendingSummon = new Map<string, number>();
const lastSummon = new Map<string, number>();

function maybeSummonRotor(pid: string, tick: number): void {
  const stranded = lastBandsSnapshot.some(
    (b) => b.poolId.toLowerCase() === pid && !(tick >= b.tickLower && tick <= b.tickUpper),
  );
  if (!stranded) {
    pendingSummon.delete(pid);
    return;
  }
  const now = Date.now();
  const since = pendingSummon.get(pid) ?? (pendingSummon.set(pid, now), now);
  if (now - since < SUMMON_CONFIRM_MS) return;
  if (now - (lastSummon.get(pid) ?? 0) < SUMMON_COOLDOWN_MS) return;
  pendingSummon.delete(pid);
  lastSummon.set(pid, now);
  void withHouseWalletLock("memeRotor.summoned", () => memeRotorTick()).catch((err) =>
    console.error(`[memeFast] summoned pass failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`),
  );
}

function maybeFastStop(pid: string, tick: number): void {
  const ref = tokenRefPriceEth.get(pid);
  if (!ref || !tokenHeldSince.has(pid)) {
    pendingFastStop.delete(pid);
    return;
  }
  const drawdownPct = (1 - Math.pow(1.0001, -tick) / ref) * 100;
  const fsLine = effectiveStopPct(stopLinePct(pid, new Date().toISOString().slice(0, 10)), hourlyVolPct(poolTickHistory.get(pid) ?? [], Date.now()));
  if (drawdownPct <= fsLine) {
    pendingFastStop.delete(pid);
    return;
  }
  const now = Date.now();
  const since = pendingFastStop.get(pid) ?? (pendingFastStop.set(pid, now), now);
  if (now - since < FAST_STOP_CONFIRM_MS) return;
  if (now - (lastFastStop.get(pid) ?? 0) < FAST_STOP_COOLDOWN_MS) return;
  if (fastInFlight) return;
  fastInFlight = true;
  pendingFastStop.delete(pid);
  lastFastStop.set(pid, now);
  withHouseWalletLock("memeFastStop", async () => {
    if (!getAgentSigner()) return;
    const [bands, ethUsd] = await Promise.all([memeBandsLive(), fetchEthUsd()]);
    await inventoryStopLoss(bands, ethUsd);
  })
    .catch((err) => console.error(`[memeFastStop] pass failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`))
    .finally(() => {
      fastInFlight = false;
    });
}

async function inventoryStopLoss(bands: MemeBand[], ethUsd: number): Promise<void> {
  const byPool = new Map<string, MemeBand[]>();
  for (const b of bands) (byPool.get(b.poolId) ?? byPool.set(b.poolId, []).get(b.poolId)!).push(b);

  for (const [pid, poolBands] of byPool) {
    const stuck = poolBands.filter((b) => !b.inRange && b.side === "token" && b.tokenAmount > 0);
    const stuckUsd = stuck.reduce((s, b) => s + b.valueUsd, 0);
    if (stuck.length === 0 || stuckUsd < STOP_MIN_USD) {
      tokenHeldSince.delete(pid);
      tokenRefPriceEth.delete(pid);
      continue;
    }
    const now = Date.now();
    const px = stuck[0].tokenPriceEth;
    if (!tokenHeldSince.has(pid)) {
      tokenHeldSince.set(pid, now);
      tokenRefPriceEth.set(pid, px);
      continue;
    }
    const age = now - (tokenHeldSince.get(pid) ?? now);
    const ref = tokenRefPriceEth.get(pid) ?? px;
    const drawdownPct = ref > 0 ? (1 - px / ref) * 100 : 0;
    const aged = age > makerExitPatienceMs(poolPulse(pid), thinHours());
    const vol = hourlyVolPct(poolTickHistory.get(pid) ?? [], now);
    const cut = drawdownPct > effectiveStopPct(stopLinePct(pid, new Date().toISOString().slice(0, 10)), vol);
    if (!aged && !cut) continue;

    const reg = venueByToken.get(stuck[0].token.toLowerCase());
    if (!reg) continue;
    try {
      await liquidateInventory(reg, stuck, ethUsd, aged ? `maker exit unfilled ${Math.round(age / 60000)}min` : `drawdown ${drawdownPct.toFixed(1)}%`);
      rollStopDecayDay();
      poolStopsToday.set(pid, (poolStopsToday.get(pid) ?? 0) + 1);
      tokenHeldSince.delete(pid);
      tokenRefPriceEth.delete(pid);
      lastMoveAt = Date.now();
      movesToday += 1;
    } catch (err) {
      console.error(`[memeRotor] stop-loss on ${reg.symbol} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }

  // Loose wallet tokens (a partial liquidation's remainder, token-side fee
  // collects) have no band and would escape the band tracking above: sweep
  // anything above the floor straight to ETH. The wallet holds ETH, period.
  const client = getPublicClient();
  for (const reg of venueByToken.values()) {
    try {
      const bal = await client.readContract({
        address: reg.token,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [getAgentSigner()!.address],
      });
      if (bal === 0n) continue;
      const { sqrtP } = await ethPoolSlot0(reg);
      if (sqrtP === 0) continue;
      const px = 1 / (sqrtP / 2 ** 96) ** 2;
      if ((Number(bal) / 1e18) * px * ethUsd < STOP_MIN_USD) continue;
      const sale = await sellInChunks(reg, bal, ethUsd, px);
      if (sale.sold === 0n) continue; // nothing cleared this pass; the loop retries next tick
      appendFileSync(
        ROTATION_JOURNAL,
        `${JSON.stringify({ ts: Date.now(), kind: "wallet-sweep", pool: reg.symbol, tokensSold: formatEther(sale.sold), tokensRemaining: formatEther(sale.remaining), ethRealized: formatEther(sale.ethRealized), txs: sale.txs })}\n`,
      );
      console.log(`[memeRotor] swept ${formatEther(sale.sold)} loose ${reg.symbol} to ${formatEther(sale.ethRealized)} ETH${sale.remaining > 0n ? ` (${formatEther(sale.remaining)} left for the next pass)` : ""}`);
    } catch (err) {
      console.error(`[memeRotor] wallet sweep of ${reg.symbol} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    }
  }
}

/** Sell a token balance for ETH in capped chunks, HALVING the chunk on a
 *  revert instead of giving up: the slippage floor rejects a sell the pool
 *  cannot absorb at once, and 2026-08-05 a whole-balance wallet sweep of a
 *  $428 remainder reverted on it every pass while the inventory sat exposed.
 *  Small enough always clears; what will not clear this pass waits for the
 *  next one. sellTokenForEth simulates before sending, so failed attempts
 *  cost no gas. */
async function sellInChunks(
  reg: EthPool,
  bal: bigint,
  ethUsd: number,
  px: number,
): Promise<{ sold: bigint; remaining: bigint; ethRealized: bigint; txs: string[] }> {
  const chunkWei = BigInt(Math.max(1, Math.floor((STOP_CHUNK_USD / ethUsd / px) * 1e18)));
  let remaining = bal;
  let sold = 0n;
  let ethRealized = 0n;
  const txs: string[] = [];
  let chunk = chunkWei;
  let attempts = 0;
  while (remaining > 0n && txs.length < STOP_MAX_CHUNKS_PER_PASS && attempts < 8) {
    attempts += 1;
    const amt = remaining > chunk ? chunk : remaining;
    try {
      const { hash, ethOut } = await sellTokenForEth(reg, amt);
      txs.push(hash);
      sold += amt;
      ethRealized += ethOut;
      remaining -= amt;
    } catch (err) {
      if (chunk <= chunkWei / 8n) {
        console.error(`[memeRotor] ${reg.symbol} sell rejected down to an eighth-chunk; leaving the rest for the next pass: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
        break;
      }
      chunk /= 2n;
    }
  }
  return { sold, remaining, ethRealized, txs };
}

/** Dollar value of loose venue tokens sitting in the wallet (inventory
 *  between sweep passes). The book is not allowed to forget them: on
 *  2026-08-05 a $428 remainder made the snapshot read $290 low and every
 *  hand-derived total after it wrong. */
export async function looseInventoryUsd(ethUsd: number): Promise<number> {
  const signer = getAgentSigner();
  if (!signer || !ethUsd) return 0;
  const client = getPublicClient();
  let usd = 0;
  for (const reg of venueByToken.values()) {
    try {
      const bal = await client.readContract({
        address: reg.token,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [signer.address],
      });
      if (bal === 0n) continue;
      const { sqrtP } = await ethPoolSlot0(reg);
      if (sqrtP === 0) continue;
      usd += (Number(bal) / 1e18) * (1 / (sqrtP / 2 ** 96) ** 2) * ethUsd;
    } catch {
      /* one unreadable token must not sink the mark */
    }
  }
  return usd;
}

// --- The daily loss circuit breaker ------------------------------------------
// The one honest implementation of "never again": a hard dollar line under
// the day's high-water mark. Two consecutive book marks below it and the desk
// flattens everything through the normal exit ladder and refuses to trade
// until the next UTC day. Entry logic bounds each loss; this bounds the day.
const DAILY_LOSS_LIMIT_USD = Number(process.env.MERIDIAN_DAILY_LOSS_LIMIT_USD ?? 75);
let bookHwm = 0;
let bookHwmDay = "";
let breachStreak = 0;
let haltDay = "";

export function deskHalted(): boolean {
  return haltDay !== "" && haltDay === new Date().toISOString().slice(0, 10);
}

/** Fed by the book snapshotter with every good mark. Marks only; a failed
 *  read never reaches here, so a phantom dip cannot trip the breaker, and the
 *  two-mark streak means even one bad-but-plausible sample cannot either. */
export function noteBookMark(book: number): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== bookHwmDay) {
    bookHwmDay = today;
    bookHwm = book;
    breachStreak = 0;
  }
  if (book > bookHwm) {
    bookHwm = book;
    breachStreak = 0;
    return;
  }
  if (bookHwm - book < DAILY_LOSS_LIMIT_USD) {
    breachStreak = 0;
    return;
  }
  breachStreak += 1;
  if (breachStreak < 2 || deskHalted()) return;
  haltDay = today;
  saveRotorState();
  const reason = `book $${book.toFixed(0)} is $${(bookHwm - book).toFixed(0)} below today's high $${bookHwm.toFixed(0)} (limit $${DAILY_LOSS_LIMIT_USD}); flattening, standing down until tomorrow`;
  appendFileSync(ROTATION_JOURNAL, `${JSON.stringify({ ts: Date.now(), kind: "circuit-breaker", reason })}\n`);
  console.error(`[memeRotor] CIRCUIT BREAKER: ${reason}`);
  void withHouseWalletLock("circuitBreaker", flattenAll).catch((err) =>
    console.error(`[memeRotor] circuit-breaker flatten failed (stop ladder still active): ${err instanceof Error ? err.message.slice(0, 160) : err}`),
  );
}

async function flattenAll(): Promise<void> {
  const signer = getAgentSigner();
  if (!signer) return;
  const [bands, ethUsd] = await Promise.all([memeBandsLive(), fetchEthUsd()]);
  const byToken = new Map<string, MemeBand[]>();
  for (const b of bands) (byToken.get(b.token.toLowerCase()) ?? byToken.set(b.token.toLowerCase(), []).get(b.token.toLowerCase())!).push(b);
  for (const [tok, group] of byToken) {
    const reg = venueByToken.get(tok);
    if (!reg) continue;
    try {
      await liquidateInventory(reg, group, ethUsd, "daily loss circuit breaker");
    } catch (err) {
      console.error(`[memeRotor] breaker liquidation of ${reg.symbol} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
}

async function liquidateInventory(reg: EthPool, stuck: MemeBand[], ethUsd: number, reason: string): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const txs: string[] = [];

  for (const b of stuck) {
    const liq = await client.readContract({
      address: POSITION_MANAGER,
      abi: [parseAbiItem("function getPositionLiquidity(uint256) view returns (uint128)")],
      functionName: "getPositionLiquidity",
      args: [BigInt(b.tokenId)],
    });
    if (liq === 0n) continue;
    const wd = buildNativeWithdraw(reg, BigInt(b.tokenId), liq, signer.address);
    await client.call({ account: signer.address, to: wd.to, data: wd.data });
    const h = await wallet.sendTransaction({ to: wd.to, data: wd.data });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`stop-loss withdraw reverted ${h}`);
    txs.push(h);
  }

  const bal = await client.readContract({
    address: reg.token,
    abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
    functionName: "balanceOf",
    args: [signer.address],
  });
  const { sqrtP } = await ethPoolSlot0(reg);
  const px = 1 / (sqrtP / 2 ** 96) ** 2;
  const sale = await sellInChunks(reg, bal, ethUsd, px);
  txs.push(...sale.txs);
  const ethRealized = sale.ethRealized;
  const remaining = sale.remaining;
  appendFileSync(
    ROTATION_JOURNAL,
    `${JSON.stringify({
      ts: Date.now(),
      kind: "stop-loss",
      pool: reg.symbol,
      reason,
      bandsClosed: stuck.map((b) => b.tokenId),
      tokensSold: formatEther(bal - remaining),
      tokensRemaining: formatEther(remaining),
      ethRealized: formatEther(ethRealized),
      txs,
    })}\n`,
  );
  console.log(
    `[memeRotor] STOP-LOSS ${reg.symbol} (${reason}): sold ${formatEther(bal - remaining)} tokens for ${formatEther(ethRealized)} ETH${remaining > 0n ? `, ${formatEther(remaining)} continues next pass` : ", flat"}`,
  );
}

// --- Expansion: breadth without waiting for failure --------------------------
// Migration reacts to a venue dying; expansion is proactive: idle float above
// the gas floor plus a vetted venue nobody is quoting = a probation-capped
// entry, on the rotor's own clock. Pinned registry venues (human-vetted) get
// entered first; analyst candidates need a fresh scan. Same journal, same
// rails posture: capped size, capped frequency, simulated before sending.
const EXPAND_MIN_ENTRY_WEI = 30_000_000_000_000_000n; // 0.03 ETH: below this an entry is dust
const EXPAND_GAS_FLOOR_WEI = 4_000_000_000_000_000n; // 0.004 ETH always stays for gas
// THERE IS NO DAILY CAP ON ENTRIES. DELETED 2026-08-09, ON PURPOSE.
//
// EXPANSIONS_PER_DAY was 3, then 6, then 12. Every raise followed the same
// incident: the desk spent the budget early, got stopped out, and then sat in
// cash for the rest of the UTC day while the tape paid other people. Each raise
// shipped with a comment claiming the new number made all-day paralysis
// impossible, and each time it happened again at the new number.
//
//   2026-08-05  budget gone by 03:00, flat through the morning rally
//   2026-08-09  12/12 spent, every band stopped at 08:00Z, then SIXTEEN HOURS
//               of `entries resume at UTC midnight` with $1,817 idle
//
// A reserve for a flat book fixed the worst symptom and not the disease: it
// bought exactly one band back, $31 of an $1,825 book, and then the counter
// bound again. Being 1.7% deployed is not meaningfully different from being
// flat.
//
// The mistake was the category. This counter bounded ACTIVITY. Nothing about
// the number of entries tells you whether the desk is taking too much risk, and
// every rail that actually bounds HARM was already in place and untouched:
//
//   · GLOBAL_COOLDOWN_MS  7 minutes between any two moves, so frequency is
//                         bounded whatever the count
//   · entrySizeMultiplier halves size per stop and BENCHES a pool at three,
//                         so a venue that keeps hurting us is retired for the
//                         day on evidence of harm rather than on a tally
//   · knife gate          no entry into a pool dumping past the drift bar
//   · liveness gate       no entry without a real 5-swap pulse, fail closed
//   · toxicity block      no entry into a venue measured fee-negative
//   · PROBATION_CAP_USD   every entry is size-capped before any of this
//   · circuit breaker     book high-water halt above all of it
//
// Those bound losses. The counter only ever bounded earnings, and a cap on how
// much money we leave on the table every day is not a risk control.

let expandDay = "";
let expandsToday = 0;

async function maybeExpand(bands: MemeBand[], ethUsd: number): Promise<void> {
  const signer = getAgentSigner();
  if (!signer) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== expandDay) {
    expandDay = today;
    expandsToday = 0;
  }
  if (Date.now() - lastMoveAt < GLOBAL_COOLDOWN_MS) return;

  // Priority order is the operator's allocation policy (flipped 2026-08-05,
  // concentration order):
  //   1. COMPOUND into the venue that is measurably printing
  //   2. only when no earner wants capital, PROBE an unquoted pinned venue
  //   3. only then a fresh analyst candidate
  // A venue that is not printing gets nothing here; its exit is maybeMigrate's.
  const quoted = new Set(bands.map((b) => b.poolId.toLowerCase()));
  // Liveness gate, FAIL CLOSED (both halves of the BOURSE lesson): an
  // unquoted pinned venue needs 5+ swaps in the trailing hour before it may
  // consume an entry slot, and "the watcher has not been up long enough to
  // know" now blocks instead of waving through; the 20 minute boot grace was
  // exactly how BOURSE re-entered while dead. The pulse map persists with the
  // rest of the risk state, so a warm restart loses nothing.
  const client = getPublicClient();
  const bal = await client.getBalance({ address: signer.address });
  const available = bal - EXPAND_GAS_FLOOR_WEI;
  if (available < EXPAND_MIN_ENTRY_WEI) return;
  const idleUsd = (Number(available) / 1e18) * ethUsd;
  const leader = bestEarner(bands, idleUsd);
  let target: EthPool | null = leader?.pool ?? null;
  // Rotation preemption: an unquoted venue whose LIVE pulse dominates the
  // leader's gets first claim on this pass's capital, through the same probe
  // vetting as everything else. The compound resumes next pass if the probe
  // is refused; attention follows the volume either way.
  const leaderPulse = leader ? poolPulse(leader.poolId.toLowerCase()) : 0;
  const rotated = [...venueByToken.values()].some((p) => {
    const pid = poolId(p).toLowerCase();
    return !quoted.has(pid) && volumeRotated(poolPulse(pid), leaderPulse);
  });
  if (rotated && target) {
    console.error(`[memeRotor] volume rotation detected: live pulse dominates the earn-window leader; probing the hot venue first`);
    target = null;
  }
  if (target && poolBlockedForToxicity(poolId(target).toLowerCase())) {
    console.error(`[memeRotor] compound into ${target.symbol} refused: venue under toxicity block`);
    target = null;
  }
  // The earn window ranks by fees RECENTLY EARNED, which peaks exactly when a
  // pump is topping: on 2026-08-05 CASHCAT collapsed 88% off its spike while
  // still ranked leader, and expansion kept feeding fresh probes into the
  // falling market. Entries obey the same knife rule as bids: a pool dumping
  // faster than the threshold gets no new capital, full stop.
  if (target) {
    const drift = tickDriftPctPerHour(poolTickHistory.get(poolId(target).toLowerCase()) ?? [], Date.now());
    if (drift != null && drift > DUMP_DRIFT_PCT_PER_HR) {
      console.error(`[memeRotor] expansion into ${target.symbol} refused: dumping ${drift.toFixed(1)}%/hr`);
      target = null;
    }
  }
  let adopted: CandidateVenue | null = null;
  let capUsd = PROBATION_CAP_USD;
  if (!target) {
    const probes = [...venueByToken.values()]
      .filter((p) => {
        const pid = poolId(p).toLowerCase();
        return !quoted.has(pid) && poolPulse(pid) >= 5 && !poolBlockedForToxicity(pid);
      })
      .sort((a, b) => poolPulse(poolId(b).toLowerCase()) - poolPulse(poolId(a).toLowerCase()));
    // Pinned means a human vetted it at pin time, not immunity forever: each
    // probe re-passes the analyst's entry gates on the spot, the same bar an
    // unknown candidate clears, and a refused venue must not block the next
    // one (2026-08-06: a freshly-pumped CASHCAT stood in front of a perfectly
    // entrable STONKBROKER all morning). A failed scan means no probe this
    // pass, not a free pass.
    if (probes.length) {
      try {
        const scan = await analyzeEthPools();
        for (const probe of probes) {
          const row = scan.rows.find((r) => r.poolId.toLowerCase() === poolId(probe).toLowerCase());
          const vet = row ? vetRow(row) : { ok: false, reason: "no analyst row (too quiet to scan)" };
          if (vet.ok) {
            target = probe;
            break;
          }
          // "Freshly pumped" measures the WINDOW, not the tape: after a big
          // recovery a pool can sit in settled two-way chop (the desk's best
          // regime) while the window still reads as a pump. 2026-08-06:
          // CASHCAT at 548 swaps/hr, drift 1.6%/hr, refused all morning.
          // When the live tape is calm and heavy, enter anyway, one offset
          // deeper and at half probation: the window's warning still prices
          // the entry, it just cannot veto the tape outright.
          const probeDrift = tickDriftPctPerHour(poolTickHistory.get(poolId(probe).toLowerCase()) ?? [], Date.now());
          // Both directions of the same illusion: the WINDOW remembers the
          // move ("freshly pumped" / "dumping on arrival") long after the
          // TAPE has settled into calm, heavy chop, the desk's best regime.
          // 2026-08-06 it kept us out of a 548-swap pump-side tape;
          // 2026-08-07 out of a 132-swap post-dip chop. Either refusal
          // yields to a live volume-mode tape, deep and at half size.
          const windowIllusion = vet.reason.startsWith("freshly pumped") || vet.reason.startsWith("dumping on arrival");
          if (windowIllusion && volumeMode(poolPulse(poolId(probe).toLowerCase()), probeDrift)) {
            target = { ...probe, offsetAbove: probe.offsetAbove + 1 };
            capUsd = PROBATION_CAP_USD / 2;
            console.error(`[memeRotor] ${probe.symbol} chop override: window remembers a move, tape is calm and heavy; entering deep at half probation`);
            break;
          }
          console.error(`[memeRotor] pinned probe ${probe.symbol} refused: ${vet.reason}`);
        }
      } catch (err) {
        console.error(`[memeRotor] pinned probe scan failed, no entry this pass: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
  }
  if (!target && Date.now() - candidates.at <= CANDIDATE_TTL_MS) {
    adopted = candidates.list.find((c) => !quoted.has(c.poolId.toLowerCase()) && !venueByToken.has(c.token.toLowerCase())) ?? null;
    if (adopted) {
      target = {
        symbol: adopted.symbol,
        token: adopted.token,
        fee: adopted.fee,
        tickSpacing: adopted.tickSpacing,
        expectedId: adopted.poolId as Hex,
        offsetAbove: adopted.tickSpacing >= 100 ? 1 : 2,
        widthSpacings: adopted.tickSpacing >= 100 ? 4 : 8,
      };
    }
  }
  if (!target) {
    if (Date.now() - lastExpandVerdictAt > 5 * 60 * 1000) {
      lastExpandVerdictAt = Date.now();
      console.log(`[memeRotor] expansion verdict: no venue qualified this pass (idle \$${idleUsd.toFixed(0)})`);
    }
    return;
  }

  try {
    rollStopDecayDay();
    const stopsHere = poolStopsToday.get(poolId(target).toLowerCase()) ?? 0;
    const mult = entrySizeMultiplier(stopsHere);
    if (mult === 0) {
      console.log(`[memeRotor] ${target.symbol} benched for the day: ${stopsHere} stops already`);
      return;
    }
    const wallet = getWalletClient();
    const capWei = BigInt(Math.round(((capUsd * mult) / ethUsd) * 1e18));
    const mintWei = available > capWei ? capWei : available;

    const { tick, sqrtP } = await ethPoolSlot0(target);
    if (sqrtP === 0) return;
    const mint = buildNativeOnlyMint(target, tick, mintWei, signer.address, target.offsetAbove);
    await client.call({ account: signer.address, to: mint.to, data: mint.data, value: mint.value });
    const h = await wallet.sendTransaction({ to: mint.to, data: mint.data, value: mint.value });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`expansion mint reverted ${h}`);
    const newId = mintedIdFrom(r.logs);

    if (adopted) {
      venueByToken.set(target.token.toLowerCase(), target);
      persistDynamicVenues();
    }
    poolLastEarned.set(poolId(target).toLowerCase(), Date.now());
    expandsToday += 1;
    movesToday += 1;
    lastMoveAt = Date.now();
    appendFileSync(
      ROTATION_JOURNAL,
      `${JSON.stringify({
        ts: Date.now(),
        kind: "expand",
        venue: target.symbol,
        poolId: poolId(target),
        newId,
        ticks: [mint.tickLower, mint.tickUpper],
        spot: tick,
        ethIn: formatEther(mintWei),
        tx: h,
      })}\n`,
    );
    console.log(`[memeRotor] EXPANDED into ${target.symbol}: ${formatEther(mintWei)} ETH as #${newId}`);
  } catch (err) {
    console.error(`[memeRotor] expansion into ${target.symbol} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
}

// --- Fee collection + treasury skim ------------------------------------------
// Uncollected fees earn NOTHING: v4 holds them as tokens owed, outside the
// liquidity. So once a band's accrual clears the floor, a zero-liquidity
// decrease sweeps the fees home WITHOUT touching the quote (it keeps earning),
// half the ETH side banks to the treasury on the spot as realized profit, and
// the rest stays in the float to compound. Token-side fees stay as inventory:
// the sell-band cycle converts them at a fee EARNED instead of paid. Rotations
// already sweep fees on every re-quote; this pass exists for bands that sit in
// range earning for days without a reason to move.
const FEE_COLLECT_MIN_USD = 10;
const FEE_SKIM_RATIO = 0.5;
const FEE_COLLECTS_PER_DAY = 6;
const MIN_SKIM_WEI = 500_000_000_000_000n; // 0.0005 ETH: below this, wait for more

// SIZE IS ONE ROUTE TO COLLECTING. AGE IS THE OTHER.
//
// A flat per-band floor is calibrated to weekday velocity, and on a quiet
// weekend no band ever reaches it. Measured, 2026-08-08/09: $64.22 of fees
// accrued across four bands and the desk collected ZERO times, both days, while
// weekdays either side collected two to five times a day on ~$109.
//
// Uncollected fees are not lost, since closing a band takes them with it. What
// they are is UNBANKED: they stay denominated in the meme token, the treasury
// skim only runs on collect so nothing reaches the treasury, and the wallet
// sweep eventually liquidates them at whatever price a stop happens to fire at.
// The desk earned all weekend and banked none of it.
//
// So the risk of holding fees is time-based, not size-based, and the rule now
// says so. A band sitting on real money for hours gets swept even when the
// amount is small. The hard floor underneath both routes exists only so a dust
// collect never costs more than it banks.
const FEE_COLLECT_FLOOR_USD = 2;
const FEE_COLLECT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function shouldCollect(feesUsd: number, pendingForMs: number): boolean {
  if (feesUsd < FEE_COLLECT_FLOOR_USD) return false;
  return feesUsd >= FEE_COLLECT_MIN_USD || pendingForMs >= FEE_COLLECT_MAX_AGE_MS;
}

/** Biggest accrual first. The daily budget is small, so iterating in whatever
 *  order the bands happened to arrive can spend the last slot on a $2 band and
 *  leave a $40 one uncollected until tomorrow. */
export function collectOrder<T extends { feesUsd: number }>(bands: readonly T[]): T[] {
  return [...bands].sort((a, b) => b.feesUsd - a.feesUsd);
}

let collectsDay = "";
let collectsToday = 0;
/** When each band's uncollected fees first cleared the hard floor, so slow
 *  accrual can be banked on age instead of waiting for a size a quiet weekend
 *  never reaches. Cleared on collect, and pruned when a band goes away. */
const feesPendingSince = new Map<string, number>();

async function collectAndSkim(bands: MemeBand[], ethUsd: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== collectsDay) {
    collectsDay = today;
    collectsToday = 0;
  }
  // Bands that closed since the last pass must not keep an ageing clock alive.
  const live = new Set(bands.map((b) => b.tokenId));
  for (const id of feesPendingSince.keys()) if (!live.has(id)) feesPendingSince.delete(id);

  for (const b of collectOrder(bands)) {
    if (b.feesUsd < FEE_COLLECT_FLOOR_USD) {
      feesPendingSince.delete(b.tokenId);
      continue;
    }
    const since = feesPendingSince.get(b.tokenId) ?? Date.now();
    if (!feesPendingSince.has(b.tokenId)) feesPendingSince.set(b.tokenId, since);
    if (!shouldCollect(b.feesUsd, Date.now() - since)) continue;
    if (collectsToday >= FEE_COLLECTS_PER_DAY) return;
    const reg = venueByToken.get(b.token.toLowerCase());
    if (!reg) continue;
    try {
      const client = getPublicClient();
      const wallet = getWalletClient();
      const signer = getAgentSigner()!;
      const before = await client.getBalance({ address: signer.address });
      // Zero-liquidity decrease: sweeps owed fees, leaves the quote working.
      const sweep = buildNativeWithdraw(reg, BigInt(b.tokenId), 0n, signer.address);
      await client.call({ account: signer.address, to: sweep.to, data: sweep.data });
      const h = await wallet.sendTransaction({ to: sweep.to, data: sweep.data });
      const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
      if (r.status !== "success") throw new Error(`fee collect reverted ${h}`);
      const ethGain = (await client.getBalance({ address: signer.address })) - before;

      // The skim is its own failure domain: the fees are already home, so a
      // failed bank transfer must not void the collect (it did once, via a
      // nonce race). Unbanked fees just compound from the float instead.
      let skimTx: Hex | null = null;
      const skim = ethGain > 0n ? (ethGain * BigInt(Math.round(FEE_SKIM_RATIO * 1000))) / 1000n : 0n;
      if (skim >= MIN_SKIM_WEI) {
        try {
          skimTx = await wallet.sendTransaction({ to: TREASURY_WALLET, value: skim });
          await client.waitForTransactionReceipt({ hash: skimTx, timeout: 90_000 });
        } catch (err) {
          skimTx = null;
          console.error(`[memeRotor] treasury skim failed (fees stay in float): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        }
      }
      collectsToday += 1;
      // The fees are home, so the ageing clock restarts from nothing.
      feesPendingSince.delete(b.tokenId);
      appendFileSync(
        ROTATION_JOURNAL,
        `${JSON.stringify({
          ts: Date.now(),
          kind: "collect",
          pool: reg.symbol,
          tokenId: b.tokenId,
          feesUsdAtRead: Math.round(b.feesUsd * 100) / 100,
          ethCollected: formatEther(ethGain > 0n ? ethGain : 0n),
          ethBankedToTreasury: skimTx ? formatEther(skim) : "0",
          txs: skimTx ? [h, skimTx] : [h],
        })}\n`,
      );
      console.log(
        `[memeRotor] collected ${formatEther(ethGain > 0n ? ethGain : 0n)} ETH fees from ${reg.symbol} #${b.tokenId}${skimTx ? `, banked ${formatEther(skim)} ETH to treasury (${skimTx})` : ""} (~$${(Number(ethGain) / 1e18 * ethUsd).toFixed(2)} ETH side)`,
      );
    } catch (err) {
      console.error(`[memeRotor] fee collect on #${b.tokenId} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }
}

// --- Cross-pool migration: the "never stuck" mandate -------------------------
// Re-quoting keeps capital NEAR the market within a pool; migration moves it
// OUT of a pool that has stopped paying. A pool is stuck when none of its
// bands have earned for MIGRATE_AFTER_MS despite the rotor re-quoting them.
// The destination must clear the analyst's vetting gate AND beat our current
// pool's fees-per-liquidity yardstick by 2x, entries are capped at probation
// size, and everything is journaled. The analyst sweep is heavy, so candidates
// refresh detached on a slow clock and a migration only fires on fresh data.
const MIGRATE_AFTER_MS = 6 * 60 * 60 * 1000;
const CANDIDATE_REFRESH_MS = 6 * 60 * 60 * 1000;
const CANDIDATE_TTL_MS = 12 * 60 * 60 * 1000;
const MIGRATIONS_PER_DAY = 2;
const PROBATION_CAP_USD = 250;
const MIN_MIGRATE_USD = 50;

const poolLastEarned = new Map<string, number>();
let candidates: { at: number; list: CandidateVenue[] } = { at: 0, list: [] };
let candidateRefreshInFlight = false;
let migrationsDay = "";
let migrationsToday = 0;

let prevScanIds = new Set<string>();

function refreshCandidatesDetached(): void {
  if (candidateRefreshInFlight || Date.now() - candidates.at < CANDIDATE_REFRESH_MS) return;
  candidateRefreshInFlight = true;
  const exclude = new Set([...venueByToken.values()].map((p) => poolId(p).toLowerCase()));
  candidateVenues(exclude)
    .then((list) => {
      // Two-scan persistence, the UNIFROG lesson: capital only enters a venue
      // that cleared the FULL gate on two consecutive sweeps. Edge that
      // cannot survive six hours was momentum wearing a costume. First sweep
      // after a boot therefore adopts nothing, deliberately.
      const seasoned = list.filter((c) => prevScanIds.has(c.poolId.toLowerCase()));
      prevScanIds = new Set(list.map((c) => c.poolId.toLowerCase()));
      candidates = { at: Date.now(), list: seasoned };
      console.log(
        `[memeRotor] analyst refresh: ${list.length} cleared this sweep, ${seasoned.length} seasoned (two consecutive sweeps)${seasoned[0] ? `, best ${seasoned[0].symbol}` : ""}`,
      );
    })
    .catch((err) => console.error(`[memeRotor] candidate refresh failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`))
    .finally(() => {
      candidateRefreshInFlight = false;
    });
}

async function maybeMigrate(bands: MemeBand[], ethUsd: number): Promise<void> {
  refreshCandidatesDetached();
  if (Date.now() - candidates.at > CANDIDATE_TTL_MS || candidates.list.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== migrationsDay) {
    migrationsDay = today;
    migrationsToday = 0;
  }
  if (migrationsToday >= MIGRATIONS_PER_DAY) return;

  // A pool is stuck when it has bands, none are earning, and the last earn is
  // stale. Only its ETH-side bands can leave (tokens are tied to their pool).
  const byPool = new Map<string, MemeBand[]>();
  for (const b of bands) (byPool.get(b.poolId) ?? byPool.set(b.poolId, []).get(b.poolId)!).push(b);
  for (const [pid, poolBands] of byPool) {
    if (poolBands.some((b) => b.inRange || b.side === "mixed")) continue;
    // Two ways a venue becomes dead weight, both measured:
    //   stuck: earned NOTHING for 6h despite the rotor re-quoting it
    //   barely: a mature earn window that never reached the printing floor
    const stuck = Date.now() - (poolLastEarned.get(pid) ?? Date.now()) >= MIGRATE_AFTER_MS;
    const w = poolEarnWindow.get(pid);
    const barely = w != null && Date.now() - w.start >= EARN_WINDOW_MS / 2 && w.usd < MIN_PRINTING_USD;
    if (!stuck && !barely) continue;
    const movable = poolBands.filter((b) => b.side === "eth" && venueByToken.has(b.token.toLowerCase()));
    const movableUsd = movable.reduce((s, b) => s + b.valueUsd, 0);
    if (movable.length === 0 || movableUsd < MIN_MIGRATE_USD) continue;

    // Destination: the venue measurably printing takes the capital UNCAPPED
    // (compounding into a proven earner), else the best fresh candidate at
    // probation size. A venue idle for 6h is a measured zero; anything vetted
    // and earning beats it.
    const earner = bestEarner(bands.filter((b) => b.poolId !== pid));
    const dest: EthPool | null = earner
      ? earner.pool
      : candidates.list[0]
        ? {
            symbol: candidates.list[0].symbol,
            token: candidates.list[0].token,
            fee: candidates.list[0].fee,
            tickSpacing: candidates.list[0].tickSpacing,
            expectedId: candidates.list[0].poolId as Hex,
            offsetAbove: candidates.list[0].tickSpacing >= 100 ? 1 : 2,
            widthSpacings: candidates.list[0].tickSpacing >= 100 ? 4 : 8,
          }
        : null;
    if (!dest || dest.token.toLowerCase() === movable[0].token.toLowerCase()) continue;

    try {
      await migrate(movable, dest, ethUsd, { capped: !earner, adopt: !earner, reason: stuck ? "stuck 6h" : "below printing floor" });
      migrationsToday += 1;
      lastMoveAt = Date.now();
      return; // at most one migration per tick
    } catch (err) {
      console.error(`[memeRotor] migration from pool ${pid.slice(0, 10)} failed: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return;
    }
  }
}

async function migrate(
  movable: MemeBand[],
  destPool: EthPool,
  ethUsd: number,
  opts: { capped: boolean; adopt: boolean; reason: string },
): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const srcReg = venueByToken.get(movable[0].token.toLowerCase())!;

  const before = await client.getBalance({ address: signer.address });
  const withdrawnTxs: string[] = [];
  for (const b of movable) {
    const liq = await client.readContract({
      address: POSITION_MANAGER,
      abi: [parseAbiItem("function getPositionLiquidity(uint256) view returns (uint128)")],
      functionName: "getPositionLiquidity",
      args: [BigInt(b.tokenId)],
    });
    if (liq === 0n) continue;
    const wd = buildNativeWithdraw(srcReg, BigInt(b.tokenId), liq, signer.address);
    await client.call({ account: signer.address, to: wd.to, data: wd.data });
    const h = await wallet.sendTransaction({ to: wd.to, data: wd.data });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`migration withdraw reverted ${h}`);
    withdrawnTxs.push(h);
  }
  const recovered = (await client.getBalance({ address: signer.address })) - before;
  if (recovered <= 0n) throw new Error("migration recovered nothing");

  // Probation sizing only for venues the desk has never traded; compounding
  // into a venue that is measurably printing moves the full recovery.
  const capWei = BigInt(Math.round((PROBATION_CAP_USD / ethUsd) * 1e18));
  const mintWei = opts.capped && recovered > capWei ? capWei : recovered;
  const { tick } = await ethPoolSlot0(destPool);
  const mint = buildNativeOnlyMint(destPool, tick, mintWei, signer.address, destPool.offsetAbove);
  await client.call({ account: signer.address, to: mint.to, data: mint.data, value: mint.value });
  const h = await wallet.sendTransaction({ to: mint.to, data: mint.data, value: mint.value });
  const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
  if (r.status !== "success") throw new Error(`migration mint reverted ${h}`);
  const newId = mintedIdFrom(r.logs);

  if (opts.adopt) {
    venueByToken.set(destPool.token.toLowerCase(), destPool);
    persistDynamicVenues();
  }
  poolLastEarned.set(poolId(destPool).toLowerCase(), Date.now());

  appendFileSync(
    ROTATION_JOURNAL,
    `${JSON.stringify({
      ts: Date.now(),
      kind: "migrate",
      reason: opts.reason,
      from: srcReg.symbol,
      to: destPool.symbol,
      destPoolId: poolId(destPool),
      oldIds: movable.map((b) => b.tokenId),
      newId,
      ticks: [mint.tickLower, mint.tickUpper],
      spot: tick,
      ethMoved: formatEther(mintWei),
      ethHeldBack: formatEther(recovered - mintWei),
      txs: [...withdrawnTxs, h],
    })}\n`,
  );
  console.log(
    `[memeRotor] MIGRATED (${opts.reason}) ${srcReg.symbol} -> ${destPool.symbol}: ${formatEther(mintWei)} ETH into #${newId}, ${formatEther(recovered - mintWei)} ETH held back`,
  );
}

async function rotate(reg: EthPool, b: MemeBand, ethUsd: number, offsetAbove = reg.offsetAbove, drift: number | null = null): Promise<void> {
  const client = getPublicClient();
  const wallet = getWalletClient();
  const signer = getAgentSigner()!;
  const tokenBal = () =>
    client.readContract({
      address: reg.token,
      abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
      functionName: "balanceOf",
      args: [signer.address],
    });

  const liquidity = await client.readContract({
    address: POSITION_MANAGER,
    abi: [parseAbiItem("function getPositionLiquidity(uint256) view returns (uint128)")],
    functionName: "getPositionLiquidity",
    args: [BigInt(b.tokenId)],
  });
  if (liquidity === 0n) return;

  const [ethBefore, tokBefore] = await Promise.all([client.getBalance({ address: signer.address }), tokenBal()]);
  const wd = buildNativeWithdraw(reg, BigInt(b.tokenId), liquidity, signer.address);
  await client.call({ account: signer.address, to: wd.to, data: wd.data });
  const wdHash = await wallet.sendTransaction({ to: wd.to, data: wd.data });
  const wdRcpt = await client.waitForTransactionReceipt({ hash: wdHash, timeout: 90_000 });
  if (wdRcpt.status !== "success") throw new Error(`withdraw reverted ${wdHash}`);
  const [ethAfter, tokAfter] = await Promise.all([client.getBalance({ address: signer.address }), tokenBal()]);
  const ethDelta = ethAfter - ethBefore;
  const tokDelta = tokAfter - tokBefore;

  const { tick, sqrtP } = await ethPoolSlot0(reg);
  const px = 1 / (sqrtP / 2 ** 96) ** 2;
  const txs: string[] = [wdHash];
  const newIds: string[] = [];

  if ((Number(ethDelta) / 1e18) * ethUsd >= MIN_LEG_USD) {
    const mint = buildNativeOnlyMint(reg, tick, ethDelta, signer.address, offsetAbove);
    await client.call({ account: signer.address, to: mint.to, data: mint.data, value: mint.value });
    const h = await wallet.sendTransaction({ to: mint.to, data: mint.data, value: mint.value });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`eth mint reverted ${h}`);
    txs.push(h);
    const id = mintedIdFrom(r.logs);
    if (id) newIds.push(id);
  }
  if ((Number(tokDelta) / 1e18) * px * ethUsd >= MIN_LEG_USD) {
    await ensureTokenApprovals(reg, tokDelta);
    const mint = buildTokenOnlyMint(reg, tick, tokDelta, signer.address, 1);
    await client.call({ account: signer.address, to: mint.to, data: mint.data });
    const h = await wallet.sendTransaction({ to: mint.to, data: mint.data });
    const r = await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
    if (r.status !== "success") throw new Error(`token mint reverted ${h}`);
    txs.push(h);
    const id = mintedIdFrom(r.logs);
    if (id) newIds.push(id);
  }

  const entry = {
    ts: Date.now(),
    pool: reg.symbol,
    oldId: b.tokenId,
    newIds,
    oldRange: [b.tickLower, b.tickUpper],
    spot: tick,
    driftPctPerHr: drift == null ? null : Math.round(drift * 100) / 100,
    offsetAbove,
    ethMoved: formatEther(ethDelta > 0n ? ethDelta : 0n),
    tokenMoved: formatEther(tokDelta > 0n ? tokDelta : 0n),
    txs,
  };
  appendFileSync(ROTATION_JOURNAL, `${JSON.stringify(entry)}\n`);
  console.log(`[memeRotor] rotated ${reg.symbol} #${b.tokenId} -> ${newIds.join(",") || "(dust held)"} at spot ${tick}`);
}

// --- Risk state persistence: a deploy must not lobotomize the desk -----------
// Every redeploy used to reset the in-memory tick histories (blinding the
// knife and drift gates), the inventory hold clocks and reference prices
// (delaying stops), and the earn windows (making concentration chase
// post-boot noise like "leader $1.96 vs $0"). The state is tiny: write it
// every rotor pass and once a minute from the fast watcher, reload on boot,
// and a restart costs at most a minute of memory. Stale state is worse than
// none (a reference price from hours ago would fire stops on old news), so
// anything older than 30 minutes is ignored and the desk starts cold.
const ROTOR_STATE_PATH = dataPath("meme-rotor-state.json");
const ROTOR_STATE_MAX_AGE_MS = 30 * 60 * 1000;

export function saveRotorState(): void {
  try {
    const state = {
      tickHistory: Object.fromEntries([...poolTickHistory].map(([k, v]) => [k, v.slice(-500)])),
      heldSince: Object.fromEntries(tokenHeldSince),
      refPrice: Object.fromEntries(tokenRefPriceEth),
      earnWindow: Object.fromEntries(poolEarnWindow),
      lastEarnedAt: Object.fromEntries(poolLastEarnedAt),
      feesPrev: Object.fromEntries(bandFeesPrev),
      pulse: Object.fromEntries([...swapPulse].map(([k, v]) => [k, v.slice(-200)])),
      breaker: { bookHwm, bookHwmDay, haltDay },
      stopDecay: { day: poolStopsDay, counts: Object.fromEntries(poolStopsToday) },
      counters: {
        movesDay, moves: movesToday, chaseExtra: chaseExtraToday,
        expandDay, expands: expandsToday,
        concDay, conc: concToday,
        migDay: migrationsDay, migs: migrationsToday,
      },
      savedAt: Date.now(),
    };
    writeFileSync(ROTOR_STATE_PATH, JSON.stringify(state));
  } catch {
    /* state is a cache; never let it break a trading pass */
  }
}

function loadRotorState(): void {
  try {
    if (!existsSync(ROTOR_STATE_PATH)) return;
    const s = JSON.parse(readFileSync(ROTOR_STATE_PATH, "utf8")) as {
      tickHistory?: Record<string, { t: number; tick: number }[]>;
      heldSince?: Record<string, number>;
      refPrice?: Record<string, number>;
      earnWindow?: Record<string, { usd: number; start: number }>;
      lastEarnedAt?: Record<string, number>;
      feesPrev?: Record<string, number>;
      pulse?: Record<string, number[]>;
      breaker?: { bookHwm?: number; bookHwmDay?: string; haltDay?: string };
      stopDecay?: { day?: string; counts?: Record<string, number> };
      counters?: { movesDay?: string; moves?: number; chaseExtra?: number; expandDay?: string; expands?: number; concDay?: string; conc?: number; migDay?: string; migs?: number };
      savedAt?: number;
    };
    if (!s.savedAt || Date.now() - s.savedAt > ROTOR_STATE_MAX_AGE_MS) return;
    for (const [k, v] of Object.entries(s.tickHistory ?? {})) poolTickHistory.set(k, v);
    for (const [k, v] of Object.entries(s.heldSince ?? {})) tokenHeldSince.set(k, v);
    for (const [k, v] of Object.entries(s.refPrice ?? {})) tokenRefPriceEth.set(k, v);
    for (const [k, v] of Object.entries(s.earnWindow ?? {})) poolEarnWindow.set(k, v);
    // Absent on an older state file: an empty map fails CLOSED (no compounding
    // until a pool is observed earning again), which is the safe direction.
    for (const [k, v] of Object.entries(s.lastEarnedAt ?? {})) poolLastEarnedAt.set(k, v as number);
    for (const [k, v] of Object.entries(s.feesPrev ?? {})) bandFeesPrev.set(k, v);
    for (const [k, v] of Object.entries(s.pulse ?? {})) swapPulse.set(k, v);
    // The daily budgets survive a redeploy too: resetting them mid-crash is
    // how 18 expansions happened on a 6-per-day budget (2026-08-05).
    const br = s.breaker ?? {};
    if (br.bookHwmDay) { bookHwmDay = br.bookHwmDay; bookHwm = br.bookHwm ?? 0; haltDay = br.haltDay ?? ""; }
    if (s.stopDecay?.day) {
      poolStopsDay = s.stopDecay.day;
      for (const [k, v] of Object.entries(s.stopDecay.counts ?? {})) poolStopsToday.set(k, v);
    }
    const c = s.counters ?? {};
    if (c.movesDay) { movesDay = c.movesDay; movesToday = c.moves ?? 0; chaseExtraToday = c.chaseExtra ?? 0; }
    if (c.expandDay) { expandDay = c.expandDay; expandsToday = c.expands ?? 0; }
    if (c.concDay) { concDay = c.concDay; concToday = c.conc ?? 0; }
    if (c.migDay) { migrationsDay = c.migDay; migrationsToday = c.migs ?? 0; }
    console.log(`[memeRotor] risk state restored (${Object.keys(s.tickHistory ?? {}).length} pools of tick history)`);
  } catch {
    /* corrupted state file: start cold, exactly like before it existed */
  }
}
loadRotorState();
