// lpScore's fees-minus-markout measurement, pointed at the ETH-quoted meme
// family. Same bar that condemned NVDA/USDG as a $944/day LP loser: fees are
// what the flow pays, markout is what informed flow takes back, and only the
// difference is real. A meme pool with spectacular fees and worse markout is
// a trap wearing a yield.
//
// Differences from the equity scorer, all quote-side mechanics:
//   - currency0 is native ETH, currency1 the token, both 18dp (no 1e12 scale)
//   - swap size in USD = |ETH side| x ETH/USD at scan time
//   - markout is measured in the pool's own quote (ETH terms). ETH/USD beta on
//     the inventory is a SEPARATE risk the sleeve sizing carries, not a flow
//     property, and mixing it in would let an ETH rally disguise toxic flow.
import { parseAbiItem, type Hex } from "viem";
import { getPublicClient } from "../venues/signer.js";
import { fetchEthUsd } from "../venues/uniswapV4.js";
import { ETH_POOLS, poolId, assertRegistryIds } from "../venues/ethPools.js";

const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const; // same singleton the equity scorer scans
const Q96 = 2 ** 96;
const MARKOUT_HORIZON_S = 30 * 60;

const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

export interface EthPoolScore {
  pool: string;
  swaps: number;
  volumeUsd: number;
  feesUsd: number;
  markoutUsd: number;
  lpNetUsd: number;
  feesPerDayUsd: number;
  lpNetPerDayUsd: number;
  verdict: "fees beat toxicity" | "toxic: fees lose";
}

export async function ethPoolScores(windowDays = 2.5): Promise<{ windowDays: number; ethUsd: number; pools: EthPoolScore[] }> {
  assertRegistryIds();
  const client = getPublicClient();
  const ethUsd = await fetchEthUsd();
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const probe = await client.getBlock({ blockNumber: head - 500_000n });
  const bps = 500_000 / (headTs - Number(probe.timestamp));
  const fromBlock = head - BigInt(Math.round(windowDays * 86400 * bps));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;

  const entries = Object.values(ETH_POOLS);
  const wanted = new Map(entries.map((p) => [poolId(p).toLowerCase(), p.symbol]));
  const swaps = new Map<string, { t: number; px: number; usd: number; dir: number }[]>(entries.map((p) => [p.symbol, []]));

  // Same adaptive scan as lpScore: the RPC caps by result count, not range.
  let from = fromBlock;
  let step = 4_000n;
  const MIN_STEP = 250n;
  const MAX_STEP = 8_000n;
  let streak = 0;
  let lastErr = "";
  while (from <= head) {
    const to = from + step - 1n > head ? head : from + step - 1n;
    try {
      const logs = await client.getLogs({
        address: POOL_MANAGER,
        event: swapEvent,
        args: { id: [...wanted.keys()] as Hex[] },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        const sym = wanted.get((l.args.id as string).toLowerCase())!;
        // token per ETH = (sqrtP/Q96)^2; the token's ETH price is its inverse.
        const praw = (Number(l.args.sqrtPriceX96) / Q96) ** 2;
        const px = 1 / praw;
        const usd = (Math.abs(Number(l.args.amount0)) / 1e18) * ethUsd;
        if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(usd) || usd === 0) continue;
        swaps.get(sym)!.push({ t: blockTs(l.blockNumber), px, usd, dir: 0 });
      }
      from = to + 1n;
      if (++streak >= 3 && step < MAX_STEP) {
        step = step * 3n / 2n > MAX_STEP ? MAX_STEP : step * 3n / 2n;
        streak = 0;
      }
    } catch (err) {
      streak = 0;
      lastErr = String((err as { details?: string })?.details ?? (err as Error)?.message ?? err).slice(0, 200);
      if (step > MIN_STEP) {
        step /= 2n;
        continue;
      }
      throw new Error(`swap scan failing even at ${MIN_STEP}-block ranges: ${lastErr}`);
    }
  }

  const pools: EthPoolScore[] = [];
  for (const p of entries) {
    const s = swaps.get(p.symbol)!.sort((a, b) => a.t - b.t);
    if (s.length === 0) continue;
    for (let i = 1; i < s.length; i++) s[i].dir = Math.sign(s[i].px - s[i - 1].px);
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
      // Meme prices legitimately move harder than equities, but a 30-minute
      // |return| beyond 50% is still corrupt-tick territory, same cap as the
      // equity scorer so the two families stay comparable.
      if (!Number.isFinite(ret) || Math.abs(ret) > 0.5) continue;
      markout += sw.dir * ret * sw.usd;
    }
    const net = fees - markout;
    pools.push({
      pool: `ETH/${p.symbol} ${(p.fee / 10000).toFixed(2)}%`,
      swaps: s.length,
      volumeUsd: Math.round(vol),
      feesUsd: Math.round(fees * 100) / 100,
      markoutUsd: Math.round(markout * 100) / 100,
      lpNetUsd: Math.round(net * 100) / 100,
      feesPerDayUsd: Math.round((fees / windowDays) * 100) / 100,
      lpNetPerDayUsd: Math.round((net / windowDays) * 100) / 100,
      verdict: net > 0 ? "fees beat toxicity" : "toxic: fees lose",
    });
  }
  pools.sort((a, b) => b.lpNetUsd - a.lpNetUsd);
  return { windowDays, ethUsd, pools };
}
