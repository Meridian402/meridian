// The standing token analyst: what the one-shot census was, as a repeatable
// pipeline. Three passes, all read-only:
//
//   1. INDEX (incremental): scan PoolManager Initialize events from a durable
//      checkpoint, keeping every ETH-quoted, hookless v4 pool. Hooked pools
//      are excluded outright: an unverified hook can tax or trap LPs, and no
//      yield number survives that.
//   2. RANK: sample the last 24h of swaps for indexed pools and rank by fee
//      flow. This is where "a lot more tokens since we last looked" shows up
//      without anyone hand-adding them.
//   3. SCORE: the ethPoolScore fees-minus-markout bar on the top of the
//      ranking, so the analyst's output is net-of-toxicity, never gross hype.
//
// State lives in dataPath("eth-pool-index.json"): one file, resumable, safe
// to delete (a delete just means a slow first rebuild).
import { parseAbiItem, type Address, type Hex } from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getScanClient } from "../venues/signer.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";
import { dataPath } from "../dataDir.js";

const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;
const INDEX_PATH = dataPath("eth-pool-index.json");
const MARKOUT_HORIZON_S = 30 * 60;

const initEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

interface IndexedPool { token: Address; fee: number; tickSpacing: number }
interface PoolIndex { lastBlock: string; pools: Record<string, IndexedPool> }

function loadIndex(): PoolIndex {
  if (existsSync(INDEX_PATH)) {
    try { return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PoolIndex; } catch { /* rebuild */ }
  }
  return { lastBlock: "0", pools: {} };
}

/** Adaptive-step log scan shared by both passes; the RPC caps by result count. */
async function scanLogs<T>(from: bigint, to: bigint, fetch: (a: bigint, b: bigint) => Promise<T[]>, sink: (logs: T[]) => void): Promise<void> {
  let cur = from;
  let step = 50_000n;
  const MIN = 500n, MAX = 200_000n;
  let streak = 0, lastErr = "";
  while (cur <= to) {
    const end = cur + step - 1n > to ? to : cur + step - 1n;
    try {
      sink(await fetch(cur, end));
      cur = end + 1n;
      if (++streak >= 3 && step < MAX) { step = step * 2n > MAX ? MAX : step * 2n; streak = 0; }
    } catch (err) {
      streak = 0;
      lastErr = String((err as { details?: string })?.details ?? (err as Error)?.message ?? err).slice(0, 160);
      if (step > MIN) { step /= 2n; continue; }
      // Skip the irreducible window rather than killing the whole sweep: a
      // missed window understates a pool, never invents one (the flow
      // scanner's doctrine, adopted 2026-08-17). Throwing here was why the
      // candidate refresh failed for days: one stuck 500-block window ended
      // the sweep, the two-consecutive-sweeps seasoning rule never saw two
      // successes in a row, and the rotor ran one-venue on a chain where
      // FOUR pools cleared the vet.
      console.error(`[analyst] skipping stuck window at ${cur}: ${lastErr}`);
      cur = end + 1n;
    }
  }
}

/** Pass 1: bring the ETH-quoted pool index up to head. Resumable, incremental. */
export async function updatePoolIndex(): Promise<{ known: number; added: number }> {
  const client = getScanClient();
  const head = await client.getBlockNumber();
  const idx = loadIndex();
  const from = BigInt(idx.lastBlock) + 1n;
  let added = 0;
  if (from <= head) {
    await scanLogs(
      from,
      head,
      (a, b) => client.getLogs({ address: POOL_MANAGER, event: initEvent, args: { currency0: NATIVE as Address }, fromBlock: a, toBlock: b }),
      (logs) => {
        for (const l of logs) {
          if ((l.args.hooks as string).toLowerCase() !== NATIVE) continue; // hookless only
          const id = (l.args.id as string).toLowerCase();
          if (!idx.pools[id]) {
            idx.pools[id] = { token: l.args.currency1 as Address, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing) };
            added++;
          }
        }
      },
    );
    idx.lastBlock = head.toString();
    writeFileSync(INDEX_PATH, JSON.stringify(idx));
  }
  return { known: Object.keys(idx.pools).length, added };
}

/**
 * Every ETH-quoted hookless v4 pool the index knows for a given token. The
 * front door of the market-making skill: a creator hands us a token address,
 * this says which pools the desk could quote, before any funds move.
 */
export function poolsForToken(token: Address): { poolId: string; fee: number; tickSpacing: number }[] {
  const idx = loadIndex();
  const t = token.toLowerCase();
  return Object.entries(idx.pools)
    .filter(([, p]) => p.token.toLowerCase() === t)
    .map(([poolId, p]) => ({ poolId, fee: p.fee, tickSpacing: p.tickSpacing }));
}

export interface AnalystRow {
  poolId: string;
  token: Address;
  feeTierPct: number;
  swaps24h: number;
  volumeUsd24h: number;
  feesUsd24h: number;
  markoutUsd24h: number;
  lpNetUsd24h: number;
  /** Price change over the trailing quarter of the window, percent. The
   *  UNIFROG lesson: a great 24h snapshot taken at the top of a pump is a
   *  trap; entries need to know what the token did RECENTLY. */
  recentMovePct: number;
  verdict: "fees beat toxicity" | "toxic: fees lose";
}

/** Passes 2+3: rank last-24h flow across the whole index, markout-score everything with real activity. */
export async function analyzeEthPools(minSwaps = 50): Promise<{ ethUsd: number; scanned: number; rows: AnalystRow[] }> {
  const client = getScanClient();
  const idx = loadIndex();
  const ids = Object.keys(idx.pools);
  if (ids.length === 0) throw new Error("pool index empty; run updatePoolIndex() first");
  const ethUsd = await fetchEthUsd();
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const probe = await client.getBlock({ blockNumber: head - 200_000n });
  const bps = 200_000 / (headTs - Number(probe.timestamp));
  const from = head - BigInt(Math.round(86400 * bps));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;

  // One swap sweep for ALL indexed ids: filtering by 30k topic values is
  // rejected by RPCs, so scan unfiltered and keep what the index knows.
  const known = new Set(ids);
  const swaps = new Map<string, { t: number; px: number; usd: number; dir: number }[]>();
  await scanLogs(
    from,
    head,
    (a, b) => client.getLogs({ address: POOL_MANAGER, event: swapEvent, fromBlock: a, toBlock: b }),
    (logs) => {
      for (const l of logs) {
        const id = (l.args.id as string).toLowerCase();
        if (!known.has(id)) continue;
        const praw = (Number(l.args.sqrtPriceX96) / Q96) ** 2;
        const px = 1 / praw;
        const usd = (Math.abs(Number(l.args.amount0)) / 1e18) * ethUsd;
        if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(usd) || usd === 0) continue;
        let arr = swaps.get(id);
        if (!arr) swaps.set(id, (arr = []));
        arr.push({ t: blockTs(l.blockNumber), px, usd, dir: 0 });
      }
    },
  );

  const rows: AnalystRow[] = [];
  for (const [id, s] of swaps) {
    if (s.length < minSwaps) continue;
    s.sort((a, b) => a.t - b.t);
    for (let i = 1; i < s.length; i++) s[i].dir = Math.sign(s[i].px - s[i - 1].px);
    const p = idx.pools[id];
    const feeRate = p.fee / 1e6;
    let fees = 0, markout = 0, vol = 0;
    for (let i = 1; i < s.length; i++) {
      const sw = s[i];
      vol += sw.usd;
      fees += sw.usd * feeRate;
      if (sw.dir === 0) continue;
      const tTarget = sw.t + MARKOUT_HORIZON_S;
      let later: (typeof s)[number] | null = null;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j].t <= tTarget) later = s[j];
        else break;
      }
      if (!later) continue;
      const ret = (later.px - sw.px) / sw.px;
      if (!Number.isFinite(ret)) continue;
      // Bleed program phase 2: a >50% post-swap move used to be DISCARDED as
      // "a different regime", which excluded exactly the catastrophic dumps
      // from the toxicity measure and let dump venues score clean. It now
      // counts, clamped at 50% so one wick cannot own the whole window.
      markout += sw.dir * Math.max(-0.5, Math.min(0.5, ret)) * sw.usd;
    }
    // Time-based recent move (phase 2): the last quarter BY COUNT could span
    // mere minutes in a busy pool, so calm-before-the-dump passed the arrival
    // gate trivially. Read the last 30 minutes by the clock instead, falling
    // back to the count quarter only when the tape is too sparse to slice.
    const lastT = s[s.length - 1].t;
    const recentWin = s.filter((x) => lastT - x.t <= 30 * 60);
    const qStart = recentWin.length >= 2 ? recentWin[0] : s[Math.floor(s.length * 0.75)];
    const recentMovePct = qStart && qStart.px > 0 ? ((s[s.length - 1].px - qStart.px) / qStart.px) * 100 : 0;
    rows.push({
      poolId: id,
      token: p.token,
      feeTierPct: p.fee / 10000,
      swaps24h: s.length,
      volumeUsd24h: Math.round(vol),
      feesUsd24h: Math.round(fees * 100) / 100,
      markoutUsd24h: Math.round(markout * 100) / 100,
      lpNetUsd24h: Math.round((fees - markout) * 100) / 100,
      recentMovePct: Math.round(recentMovePct * 100) / 100,
      verdict: fees - markout > 0 ? "fees beat toxicity" : "toxic: fees lose",
    });
  }
  rows.sort((a, b) => b.lpNetUsd24h - a.lpNetUsd24h);
  return { ethUsd, scanned: ids.length, rows };
}

// --- Vetting: the analyst's leaderboard is a ranking, this is a GATE ---------
// A pool the desk may auto-enter must clear every filter. The census taught
// each one: predator pools carry 5%+ fee tiers that no organic taker pays
// (their "fees" are wash flow); sub-500-swap pools die between scans; toxic
// pools pay fees and lose more to informed flow; thin volume means our size IS
// the market and the measured numbers stop applying the moment we arrive.
export function vetRow(r: AnalystRow): { ok: boolean; reason: string } {
  if (r.verdict !== "fees beat toxicity") return { ok: false, reason: "toxic: fees lose to informed flow" };
  if (r.feeTierPct < 0.25) return { ok: false, reason: "fee tier too thin to pay for toxicity" };
  if (r.feeTierPct > 3) return { ok: false, reason: "predator-tier fee: flow is not organic" };
  if (r.swaps24h < 500) return { ok: false, reason: "too few swaps: dies between scans" };
  if (r.volumeUsd24h < 100_000) return { ok: false, reason: "volume too thin for our size" };
  if (r.feesUsd24h < 500) return { ok: false, reason: "fee flow below the floor" };
  // The UNIFROG lesson, encoded: entering right after a pump buys the retrace,
  // entering into a dump catches the knife. Flat arrivals only.
  if (r.recentMovePct < -5) return { ok: false, reason: "dumping on arrival: entering catches the knife" };
  if (r.recentMovePct > 15) return { ok: false, reason: "freshly pumped: entering buys the retrace" };
  return { ok: true, reason: "cleared" };
}

const initEventForAge = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

/** Pool age in hours, from its Initialize event. A pool younger than three
 *  days has not proven its flow persists; day-one wonders are where great
 *  snapshots lie. */
export async function poolAgeHours(id: string): Promise<number | null> {
  try {
    const client = getScanClient();
    const logs = await client.getLogs({
      address: POOL_MANAGER,
      event: initEventForAge,
      args: { id: id as Hex },
      fromBlock: 0n,
      toBlock: "latest",
    });
    if (!logs.length) return null;
    const blk = await client.getBlock({ blockNumber: logs[0].blockNumber });
    return (Date.now() / 1000 - Number(blk.timestamp)) / 3600;
  } catch {
    return null;
  }
}

/** Fees per unit of at-spot liquidity VALUE, comparable across pools: for a
 *  band of relative width r around spot, valueUsd scales with L * r / sqrtP,
 *  so fees-per-dollar scales with feesUsd * sqrtP / L (r cancels). */
export const poolYardstick = (feesUsd24h: number, sqrtPfrac: number, activeL: number): number =>
  activeL > 0 ? (feesUsd24h * sqrtPfrac) / activeL : 0;

export interface CandidateVenue {
  poolId: string;
  token: Address;
  symbol: string;
  fee: number;
  tickSpacing: number;
  feeTierPct: number;
  feesUsd24h: number;
  lpNetUsd24h: number;
  yardstick: number;
}

/**
 * The venues the desk is ALLOWED to migrate into: full 24h analysis, vetting
 * gate, then fees-per-liquidity yardstick from live pool state. Heavy (a full
 * swap sweep); callers cache the result and refresh on a slow clock.
 */
export async function candidateVenues(excludePoolIds: Set<string>): Promise<CandidateVenue[]> {
  await updatePoolIndex();
  const { rows } = await analyzeEthPools(500);
  const idx = loadIndex();
  const cleared = rows.filter((r) => !excludePoolIds.has(r.poolId.toLowerCase()) && vetRow(r).ok).slice(0, 8);
  if (cleared.length === 0) return [];

  const client = getScanClient();
  const slot0Abi = [parseAbiItem("function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)")];
  const liqAbi = [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")];
  const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
  const symAbi = [parseAbiItem("function symbol() view returns (string)")];
  const syms = await client.multicall({
    contracts: cleared.map((r) => ({ address: r.token, abi: symAbi, functionName: "symbol" }) as const),
    allowFailure: true,
    multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11",
  });

  const out: CandidateVenue[] = [];
  for (let i = 0; i < cleared.length; i++) {
    const r = cleared[i];
    try {
      const age = await poolAgeHours(r.poolId);
      // A pool PROVEN younger than 72h never clears: day-one wonders are
      // where great snapshots lie. But age == null is an RPC failure, not a
      // young pool, and dropping on it convicted candidates on missing
      // evidence: the genesis log scan behind poolAgeHours flakes routinely
      // on the public endpoint, and three of four vet-cleared venues were
      // being silently discarded here. Fail closed on measured youth, open
      // on measurement failure; every other gate still applies.
      if (age != null && age < 72) continue;
      if (age == null) console.error(`[analyst] ${r.token.slice(0, 10)} age unknown (RPC): admitting on the other gates`);
      const [sqrtP] = await client.readContract({ address: STATE_VIEW, abi: slot0Abi, functionName: "getSlot0", args: [r.poolId as Hex] });
      const activeL = await client.readContract({ address: STATE_VIEW, abi: liqAbi, functionName: "getLiquidity", args: [r.poolId as Hex] });
      const p = idx.pools[r.poolId.toLowerCase()];
      if (!p || Number(sqrtP) === 0) continue;
      out.push({
        poolId: r.poolId,
        token: r.token,
        symbol: syms[i].status === "success" ? String(syms[i].result).slice(0, 20) : r.token.slice(0, 10),
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        feeTierPct: r.feeTierPct,
        feesUsd24h: r.feesUsd24h,
        lpNetUsd24h: r.lpNetUsd24h,
        // Ranked on NET flow: markout is shared pro-rata exactly like fees, so
        // gross-fee ranking flatters pools whose flow is informed.
        yardstick: poolYardstick(r.lpNetUsd24h, Number(sqrtP) / Q96, Number(activeL)),
      });
    } catch { /* a pool that cannot be read cannot be entered */ }
  }
  return out.sort((a, b) => b.yardstick - a.yardstick);
}

export interface TokenView {
  token: Address;
  symbol: string;
  totalVolumeUsd24h: number;
  totalFeesUsd24h: number;
  totalLpNetUsd24h: number;
  /** Every indexed pool for this token, best net first: the flow map the
   *  operator asked for, because volume migrates between a token's venues and
   *  yesterday's best tier is routinely today's dead one. */
  pools: AnalystRow[];
}

/**
 * The same analysis, grouped by TOKEN: one row per asset, all its pools under
 * it with the flow split visible. Scope note, stated rather than hidden: this
 * covers v4 ETH-quoted hookless pools (what the index holds). A token's v3
 * venues and USDG-quoted v4 pools are outside this index; the per-token view
 * shows where flow sits WITHIN the family we can mint into.
 */
export async function analyzeByToken(minSwaps = 50): Promise<{ ethUsd: number; tokens: TokenView[] }> {
  const { ethUsd, rows } = await analyzeEthPools(minSwaps);
  const byToken = new Map<string, AnalystRow[]>();
  for (const r of rows) {
    const k = r.token.toLowerCase();
    (byToken.get(k) ?? byToken.set(k, []).get(k)!).push(r);
  }
  // Resolve symbols in one multicall; a token that reverts stays addressed.
  const addrs = [...byToken.keys()] as Address[];
  const client = getScanClient();
  const symAbi = [parseAbiItem("function symbol() view returns (string)")];
  const syms = await client.multicall({
    contracts: addrs.map((a) => ({ address: a, abi: symAbi, functionName: "symbol" }) as const),
    allowFailure: true,
    multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11",
  });
  const tokens: TokenView[] = addrs.map((a, i) => {
    const pools = byToken.get(a.toLowerCase())!.sort((x, y) => y.lpNetUsd24h - x.lpNetUsd24h);
    return {
      token: a,
      symbol: syms[i].status === "success" ? String(syms[i].result).slice(0, 20) : a.slice(0, 10),
      totalVolumeUsd24h: pools.reduce((s, p) => s + p.volumeUsd24h, 0),
      totalFeesUsd24h: Math.round(pools.reduce((s, p) => s + p.feesUsd24h, 0) * 100) / 100,
      totalLpNetUsd24h: Math.round(pools.reduce((s, p) => s + p.lpNetUsd24h, 0) * 100) / 100,
      pools,
    };
  });
  tokens.sort((a, b) => b.totalLpNetUsd24h - a.totalLpNetUsd24h);
  return { ethUsd, tokens };
}
