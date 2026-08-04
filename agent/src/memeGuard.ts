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
import { candidateVenues, type CandidateVenue } from "./signals/tokenAnalyst.js";
import { sellTokenForEth } from "./venues/ethSwap.js";
import { dataPath } from "./dataDir.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const NATIVE = "0x0000000000000000000000000000000000000000";
const POSITION_MANAGER: Address = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROTATION_JOURNAL = dataPath("meme-rotations.jsonl");

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
const DAILY_MOVE_CAP = 24;
const MIN_BAND_USD = 25;
const MIN_LEG_USD = 20;
const ERROR_BACKOFF_MS = 60 * 60 * 1000;
/** Tick drift above this (percent per hour, positive = token dumping) counts
 *  as a knife for the ETH side. */
const DUMP_DRIFT_PCT_PER_HR = 1.5;

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
  const native = positions.filter((p) => p.currency0.toLowerCase() === NATIVE && p.liquidity > 0n);
  if (native.length === 0) return [];

  const client = getPublicClient();
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
  // Fine-grained velocity: the same history the slow rotor's knife gate reads.
  const h = poolTickHistory.get(pid) ?? [];
  const now = Date.now();
  if (!h.length || now - h[h.length - 1].t > 5_000) {
    h.push({ t: now, tick });
    while (h.length && now - h[0].t > 2 * 60 * 60 * 1000) h.shift();
    poolTickHistory.set(pid, h);
  }

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
  if (!signer) return;
  const [bands, ethUsd] = await Promise.all([memeBandsLive(), fetchEthUsd()]);
  for (const b of bands) {
    if (b.poolId.toLowerCase() !== pid) continue;
    if (b.inRange || b.side !== "token") continue; // must CONFIRM as filled on authoritative data
    if (b.valueUsd < MIN_BAND_USD) continue;
    if (movesToday >= DAILY_MOVE_CAP) return;
    const reg = venueByToken.get(b.token.toLowerCase());
    if (!reg) continue;
    const target = targetRange(reg, b.currentTick, "token");
    if (target.tickLower === b.tickLower && target.tickUpper === b.tickUpper) continue;
    await rotate(reg, b, ethUsd, reg.offsetAbove, tickDriftPctPerHour(poolTickHistory.get(pid) ?? [], Date.now()));
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
        for (const l of logs) onSwap(String(l.args.id).toLowerCase(), Number(l.args.tick));
      },
      onError: () => { /* transient; the poller retries on its own */ },
    });
  let unwatch = subscribe();
  const resub = setInterval(() => {
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
let lastMoveAt = 0;
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
 *  whole desk. */
const MAX_VENUE_SHARE = 0.6;

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
    }
    bandFeesPrev.set(b.tokenId, b.feesUsd);
  }
}

/** The quoted venue currently earning the most, if it is genuinely printing
 *  and not already at the concentration cap. */
function bestEarner(bands: MemeBand[]): { pool: EthPool; poolId: string } | null {
  const totalBook = bands.reduce((s, b) => s + b.valueUsd, 0);
  let best: { pool: EthPool; poolId: string; usd: number } | null = null;
  for (const [pid, w] of poolEarnWindow) {
    if (w.usd < MIN_PRINTING_USD) continue;
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
    await client.waitForTransactionReceipt({ hash: h });
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
    await client.waitForTransactionReceipt({ hash: h });
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
  }

  updateEarnTracking(bands);
  recordTicks(bands);

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
    if (now - since < (knife ? KNIFE_PERSIST_MS : OUT_OF_RANGE_MIN_MS)) continue;
    if ((errorBackoffUntil.get(b.tokenId) ?? 0) > now) continue;
    if (b.valueUsd < MIN_BAND_USD) continue;
    if (now - lastMoveAt < GLOBAL_COOLDOWN_MS) continue;
    if (movesToday >= DAILY_MOVE_CAP) {
      console.error(`[memeRotor] daily cap ${DAILY_MOVE_CAP} reached; holding remaining quotes until tomorrow`);
      return;
    }
    const offsetAbove = knife ? reg.offsetAbove + 2 : reg.offsetAbove;
    const target = targetRange(reg, b.currentTick, b.side, offsetAbove);
    if (target.tickLower === b.tickLower && target.tickUpper === b.tickUpper) continue; // already where we'd quote

    try {
      await rotate(reg, b, ethUsd, offsetAbove, drift);
      lastMoveAt = Date.now();
      movesToday += 1;
      outOfRangeSince.delete(b.tokenId);
    } catch (err) {
      errorBackoffUntil.set(b.tokenId, Date.now() + ERROR_BACKOFF_MS);
      console.error(`[memeRotor] rotation of #${b.tokenId} failed (backing off 1h): ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    }
  }

  await inventoryStopLoss(bands, ethUsd);
  await collectAndSkim(bands, ethUsd);
  await maybeExpand(bands, ethUsd);
  await maybeMigrate(bands, ethUsd);
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
const TOKEN_MAX_HOLD_MS = 30 * 60 * 1000;
const TOKEN_STOP_DRAWDOWN_PCT = 4;
const STOP_CHUNK_USD = 200;
const STOP_MAX_CHUNKS_PER_PASS = 3;
const STOP_MIN_USD = 15;

const tokenHeldSince = new Map<string, number>();
const tokenRefPriceEth = new Map<string, number>();

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
    const aged = age > TOKEN_MAX_HOLD_MS;
    const cut = drawdownPct > TOKEN_STOP_DRAWDOWN_PCT;
    if (!aged && !cut) continue;

    const reg = venueByToken.get(stuck[0].token.toLowerCase());
    if (!reg) continue;
    try {
      await liquidateInventory(reg, stuck, ethUsd, aged ? `maker exit unfilled ${Math.round(age / 60000)}min` : `drawdown ${drawdownPct.toFixed(1)}%`);
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
      const { hash, ethOut } = await sellTokenForEth(reg, bal);
      appendFileSync(
        ROTATION_JOURNAL,
        `${JSON.stringify({ ts: Date.now(), kind: "wallet-sweep", pool: reg.symbol, tokensSold: formatEther(bal), ethRealized: formatEther(ethOut), txs: [hash] })}\n`,
      );
      console.log(`[memeRotor] swept ${formatEther(bal)} loose ${reg.symbol} to ${formatEther(ethOut)} ETH`);
    } catch (err) {
      console.error(`[memeRotor] wallet sweep of ${reg.symbol} failed: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
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
    const r = await client.waitForTransactionReceipt({ hash: h });
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
  const chunkWei = BigInt(Math.max(1, Math.floor((STOP_CHUNK_USD / ethUsd / px) * 1e18)));
  let remaining = bal;
  let ethRealized = 0n;
  let chunks = 0;
  while (remaining > 0n && chunks < STOP_MAX_CHUNKS_PER_PASS) {
    const amt = remaining > chunkWei ? chunkWei : remaining;
    const { hash, ethOut } = await sellTokenForEth(reg, amt);
    txs.push(hash);
    ethRealized += ethOut;
    remaining -= amt;
    chunks += 1;
  }
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
const EXPANSIONS_PER_DAY = 3;

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
  if (expandsToday >= EXPANSIONS_PER_DAY) return;
  if (Date.now() - lastMoveAt < GLOBAL_COOLDOWN_MS) return;

  // Priority order is the operator's allocation policy:
  //   1. PROBE an unquoted pinned venue (small, capped: breadth stays cheap)
  //   2. COMPOUND into the venue that is measurably printing (concentration)
  //   3. only then a fresh analyst candidate
  // A venue that is not printing gets nothing here; its exit is maybeMigrate's.
  const quoted = new Set(bands.map((b) => b.poolId.toLowerCase()));
  let target: EthPool | null = [...venueByToken.values()].find((p) => !quoted.has(poolId(p).toLowerCase())) ?? null;
  let adopted: CandidateVenue | null = null;
  if (!target) {
    const earner = bestEarner(bands);
    if (earner) target = earner.pool;
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
  if (!target) return;

  try {
    const client = getPublicClient();
    const wallet = getWalletClient();
    const bal = await client.getBalance({ address: signer.address });
    const available = bal - EXPAND_GAS_FLOOR_WEI;
    if (available < EXPAND_MIN_ENTRY_WEI) return;
    const capWei = BigInt(Math.round((PROBATION_CAP_USD / ethUsd) * 1e18));
    const mintWei = available > capWei ? capWei : available;

    const { tick, sqrtP } = await ethPoolSlot0(target);
    if (sqrtP === 0) return;
    const mint = buildNativeOnlyMint(target, tick, mintWei, signer.address, target.offsetAbove);
    await client.call({ account: signer.address, to: mint.to, data: mint.data, value: mint.value });
    const h = await wallet.sendTransaction({ to: mint.to, data: mint.data, value: mint.value });
    const r = await client.waitForTransactionReceipt({ hash: h });
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

let collectsDay = "";
let collectsToday = 0;

async function collectAndSkim(bands: MemeBand[], ethUsd: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== collectsDay) {
    collectsDay = today;
    collectsToday = 0;
  }
  for (const b of bands) {
    if (b.feesUsd < FEE_COLLECT_MIN_USD) continue;
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
      const r = await client.waitForTransactionReceipt({ hash: h });
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
          await client.waitForTransactionReceipt({ hash: skimTx });
        } catch (err) {
          skimTx = null;
          console.error(`[memeRotor] treasury skim failed (fees stay in float): ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        }
      }
      collectsToday += 1;
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
    const r = await client.waitForTransactionReceipt({ hash: h });
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
  const r = await client.waitForTransactionReceipt({ hash: h });
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
  const wdRcpt = await client.waitForTransactionReceipt({ hash: wdHash });
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
    const r = await client.waitForTransactionReceipt({ hash: h });
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
    const r = await client.waitForTransactionReceipt({ hash: h });
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
