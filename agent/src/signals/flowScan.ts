// THE USDG FLOW SCANNER. Read-only. No capital moves anywhere in this file.
//
// The desk's chain-wide discovery (tokenAnalyst) indexes only ETH-quoted pools
// (Initialize filtered to currency0 == NATIVE). Per the rhc-liq-001 brief, USDG
// is ~69% of the chain's stablecoin supply and stablecoins are ~74% of TVL, so
// the majority of the flow is in USDG-quoted pools we could not see. This finds
// them: same fees-minus-markout bar the desk already trusts, pointed at the
// half of the market we were blind to.
//
// Deliberately SELF-CONTAINED and SEPARATE from tokenAnalyst:
//   - its own durable index (usdg-pool-index.json), so the live ETH rotor's
//     index is never touched by this
//   - its own adaptive log scanner, so a change here cannot regress the desk
//   - no export that any deployment path consumes. This surfaces sight; whether
//     a single dollar ever follows it is a separate, human-gated decision.
//
// Why the math is simpler than the ETH side: for a USDG-quoted pool the money
// leg IS dollars (USDG is 6-decimal, 1:1), so volume needs no price oracle, and
// markout uses only RELATIVE price change so the token's decimals cancel out.
import { parseAbiItem, type Address, type Hex } from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getPublicClient } from "../venues/signer.js";
import { dataPath } from "../dataDir.js";

const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NATIVE = "0x0000000000000000000000000000000000000000";
const USDG_DECIMALS = 6;
const Q96 = 2 ** 96;
const MARKOUT_HORIZON_S = 30 * 60;
const INDEX_PATH = dataPath("usdg-pool-index.json");

const initEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);
const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

interface UsdgPool {
  token: Address;
  /** True when USDG is currency0 (so amount0 is the money leg). */
  usdgIsToken0: boolean;
  fee: number;
  tickSpacing: number;
}
interface PoolIndex {
  lastBlock: string;
  pools: Record<string, UsdgPool>;
}

function loadIndex(): PoolIndex {
  if (existsSync(INDEX_PATH)) {
    try {
      return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PoolIndex;
    } catch {
      /* corrupt -> rebuild from genesis */
    }
  }
  return { lastBlock: "0", pools: {} };
}

/** The same adaptive-step scan the analyst uses: the RPC caps by result count,
 *  not block range, so widen on a good streak and halve on a failure. */
async function scanLogs<T>(from: bigint, to: bigint, fetch: (a: bigint, b: bigint) => Promise<T[]>, sink: (logs: T[]) => void): Promise<void> {
  let cur = from;
  let step = 50_000n;
  const MIN = 500n;
  const MAX = 200_000n;
  let streak = 0;
  while (cur <= to) {
    const end = cur + step - 1n > to ? to : cur + step - 1n;
    try {
      sink(await fetch(cur, end));
      cur = end + 1n;
      if (++streak >= 3 && step < MAX) {
        step = step * 2n > MAX ? MAX : step * 2n;
        streak = 0;
      }
    } catch {
      streak = 0;
      if (step > MIN) {
        step /= 2n;
        continue;
      }
      // Irreducible failure on the minimum step: skip it rather than hang the
      // whole scan. A missed window understates a pool, never invents one.
      cur = end + 1n;
    }
  }
}

/** Incrementally index every hookless pool with USDG on one side. Durable and
 *  resumable; a delete just means a slower first rebuild. */
export async function updateUsdgPoolIndex(): Promise<{ known: number; added: number }> {
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  const idx = loadIndex();
  const from = BigInt(idx.lastBlock) + 1n;
  let added = 0;
  if (from <= head) {
    // Two passes: USDG as currency0, and USDG as currency1. v4 sorts currencies
    // by address, so which leg USDG lands on depends on the paired token.
    for (const asToken0 of [true, false]) {
      await scanLogs(
        from,
        head,
        (a, b) =>
          client.getLogs({
            address: POOL_MANAGER,
            event: initEvent,
            args: asToken0 ? { currency0: USDG } : { currency1: USDG },
            fromBlock: a,
            toBlock: b,
          }),
        (logs) => {
          for (const l of logs) {
            if ((l.args.hooks as string).toLowerCase() !== NATIVE) continue; // hookless only, same rule as the ETH index
            const id = (l.args.id as string).toLowerCase();
            if (idx.pools[id]) continue;
            const token = (asToken0 ? l.args.currency1 : l.args.currency0) as Address;
            idx.pools[id] = { token, usdgIsToken0: asToken0, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing) };
            added++;
          }
        },
      );
    }
    idx.lastBlock = head.toString();
    writeFileSync(INDEX_PATH, JSON.stringify(idx));
  }
  return { known: Object.keys(idx.pools).length, added };
}

export interface FlowRow {
  poolId: string;
  token: Address;
  feeTierPct: number;
  swaps24h: number;
  volumeUsd24h: number;
  feesUsd24h: number;
  markoutUsd24h: number;
  lpNetUsd24h: number;
  recentMovePct: number;
  verdict: "fees beat toxicity" | "toxic: fees lose";
}

interface RawSwap {
  t: number;
  /** token price in USDG, direction-consistent; used only for relative markout. */
  px: number;
  /** dollars of flow, from the USDG leg directly. */
  usd: number;
  dir: number;
}

/** THE PURE SCORER, exported for tests. Same fees-minus-markout shape as the
 *  ETH analyst: fees are gross flow times the tier, markout is the price drift
 *  informed flow takes back over the horizon, LP net is the difference. */
export function scoreFlow(poolId: string, token: Address, fee: number, swaps: RawSwap[], minSwaps: number): FlowRow | null {
  if (swaps.length < minSwaps) return null;
  const s = [...swaps].sort((a, b) => a.t - b.t);
  for (let i = 1; i < s.length; i++) s[i].dir = Math.sign(s[i].px - s[i - 1].px);
  const feeRate = fee / 1e6;
  let fees = 0;
  let markout = 0;
  let vol = 0;
  for (let i = 1; i < s.length; i++) {
    const sw = s[i];
    vol += sw.usd;
    fees += sw.usd * feeRate;
    if (sw.dir === 0) continue;
    const tTarget = sw.t + MARKOUT_HORIZON_S;
    let later: RawSwap | null = null;
    for (let j = i + 1; j < s.length; j++) {
      if (s[j].t <= tTarget) later = s[j];
      else break;
    }
    if (!later) continue;
    const ret = (later.px - sw.px) / sw.px;
    if (!Number.isFinite(ret) || Math.abs(ret) > 0.5) continue; // a 50%+ move is a different regime, not markout
    markout += sw.dir * ret * sw.usd;
  }
  const qStart = s[Math.floor(s.length * 0.75)];
  const recentMovePct = qStart && qStart.px > 0 ? ((s[s.length - 1].px - qStart.px) / qStart.px) * 100 : 0;
  return {
    poolId,
    token,
    feeTierPct: fee / 10000,
    swaps24h: s.length,
    volumeUsd24h: Math.round(vol),
    feesUsd24h: Math.round(fees * 100) / 100,
    markoutUsd24h: Math.round(markout * 100) / 100,
    lpNetUsd24h: Math.round((fees - markout) * 100) / 100,
    recentMovePct: Math.round(recentMovePct * 100) / 100,
    verdict: fees - markout > 0 ? "fees beat toxicity" : "toxic: fees lose",
  };
}

/** Convert one swap log into a scored sample, or null if it is unusable. The
 *  money leg is whichever side is USDG; the price is the token/USDG ratio, and
 *  the swap direction is inferred later from consecutive prices. Pure and
 *  exported so the decimal/side handling is tested without a chain. */
export function swapToSample(
  amount0: bigint,
  amount1: bigint,
  sqrtPriceX96: bigint,
  usdgIsToken0: boolean,
  tSec: number,
): RawSwap | null {
  const usdgAmt = usdgIsToken0 ? amount0 : amount1;
  const usd = Math.abs(Number(usdgAmt)) / 10 ** USDG_DECIMALS;
  // token per USDG. sqrt gives currency1/currency0 in RAW units; markout only
  // uses relative change, so the fixed decimal offset cancels and never matters.
  const ratio = (Number(sqrtPriceX96) / Q96) ** 2;
  const px = usdgIsToken0 ? ratio : 1 / ratio; // token priced in USDG either way
  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(usd) || usd === 0) return null;
  return { t: tSec, px, usd, dir: 0 };
}

/** Rank the last 24h of USDG-pool flow, markout-scored. Read-only. */
export async function analyzeUsdgPools(minSwaps = 30): Promise<{ scanned: number; rows: FlowRow[] }> {
  const client = getPublicClient();
  const idx = loadIndex();
  const ids = Object.keys(idx.pools);
  if (ids.length === 0) throw new Error("USDG pool index empty; run updateUsdgPoolIndex() first");
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const probe = await client.getBlock({ blockNumber: head - 200_000n });
  const bps = 200_000 / (headTs - Number(probe.timestamp));
  const from = head - BigInt(Math.round(86400 * bps));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;

  const known = new Map(ids.map((id) => [id, idx.pools[id]]));
  const swaps = new Map<string, RawSwap[]>();
  await scanLogs(
    from,
    head,
    (a, b) => client.getLogs({ address: POOL_MANAGER, event: swapEvent, fromBlock: a, toBlock: b }),
    (logs) => {
      for (const l of logs) {
        const id = (l.args.id as string).toLowerCase();
        const p = known.get(id);
        if (!p) continue;
        const sample = swapToSample(l.args.amount0 as bigint, l.args.amount1 as bigint, l.args.sqrtPriceX96 as bigint, p.usdgIsToken0, blockTs(l.blockNumber));
        if (!sample) continue;
        let arr = swaps.get(id);
        if (!arr) swaps.set(id, (arr = []));
        arr.push(sample);
      }
    },
  );

  const rows: FlowRow[] = [];
  for (const [id, s] of swaps) {
    const p = known.get(id)!;
    const row = scoreFlow(id, p.token, p.fee, s, minSwaps);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.lpNetUsd24h - a.lpNetUsd24h);
  return { scanned: ids.length, rows };
}
