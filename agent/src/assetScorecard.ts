// The asset scorecard: every venue the desk trades, graded continuously
// across MULTIPLE metric points, not just at entry. Market side: live price,
// measured drift, resting liquidity, holder base. Our side: what the desk
// actually earned and paid there, from the earn window and the journal. This
// is the operator's answer to "how are the assets we buy performing overall",
// served publicly like every other number the desk stands behind.
import { parseAbiItem, type Hex } from "viem";
import { readFileSync, existsSync } from "node:fs";
import { ETH_POOLS, poolId, ethPoolSlot0 } from "./venues/ethPools.js";
import { getPublicClient } from "./venues/signer.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { dataPath } from "./dataDir.js";

const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as const;
const Q96 = 2 ** 96;

export interface AssetScore {
  symbol: string;
  token: string;
  priceEth: number;
  priceUsd: number;
  /** Measured drift over the trailing hour from the flow log, pct (positive =
   *  price falling); null until enough recorded swaps exist. */
  drift1hPct: number | null;
  swaps1h: number;
  activeLiquidity: string;
  holders: number | null;
  /** Desk results with this asset, full journal history: what it earned us
   *  in collects, what its stop-losses realized, how many cycles. */
  ourCollectsUsd: number;
  ourStops: number;
  ourStopEthRealized: number;
  ourRotations: number;
}

export async function assetScorecard(): Promise<{ ethUsd: number; assets: AssetScore[] }> {
  const client = getPublicClient();
  const ethUsd = await fetchEthUsd();

  // Flow log: per-pool swaps in the trailing hour for drift + activity.
  const flows = new Map<string, { t: number; tick: number }[]>();
  try {
    const cutoff = Date.now() - 3600_000;
    const path = dataPath("pool-flow.jsonl");
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as { t: number; p: string; tick: number };
          if (r.t < cutoff) continue;
          (flows.get(r.p) ?? flows.set(r.p, []).get(r.p)!).push({ t: r.t, tick: r.tick });
        } catch { /* skip bad line */ }
      }
    }
  } catch { /* no flow yet */ }

  // Journal: the desk's own history per pool.
  const ours = new Map<string, { collects: number; stops: number; stopEth: number; rotations: number }>();
  try {
    for (const line of readFileSync(dataPath("meme-rotations.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const pool = String(e.pool ?? e.venue ?? "");
        if (!pool) continue;
        const o = ours.get(pool) ?? { collects: 0, stops: 0, stopEth: 0, rotations: 0 };
        const kind = String(e.kind ?? "rotate");
        if (kind === "collect") o.collects += Number(e.feesUsdAtRead ?? 0);
        else if (kind === "stop-loss") {
          o.stops += 1;
          o.stopEth += Number(e.ethRealized ?? 0);
        } else if (kind === "rotate") o.rotations += 1;
        ours.set(pool, o);
      } catch { /* skip */ }
    }
  } catch { /* no journal */ }

  const assets: AssetScore[] = [];
  for (const p of Object.values(ETH_POOLS)) {
    const id = poolId(p).toLowerCase();
    try {
      const { sqrtP } = await ethPoolSlot0(p);
      const priceEth = sqrtP > 0 ? 1 / (sqrtP / Q96) ** 2 : 0;
      const activeL = await client.readContract({
        address: STATE_VIEW,
        abi: [parseAbiItem("function getLiquidity(bytes32) view returns (uint128)")],
        functionName: "getLiquidity",
        args: [id as Hex],
      });
      let holders: number | null = null;
      try {
        const info = (await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${p.token}`, {
          signal: AbortSignal.timeout(8000),
        }).then((r) => r.json())) as { holders?: string };
        holders = info.holders != null ? Number(info.holders) : null;
      } catch { /* explorer optional */ }
      const fl = (flows.get(id.slice(0, 10)) ?? []).sort((a, b) => a.t - b.t);
      let drift: number | null = null;
      if (fl.length >= 3) {
        const hrs = (fl[fl.length - 1].t - fl[0].t) / 3600_000;
        if (hrs > 0.1) drift = (1.0001 ** ((fl[fl.length - 1].tick - fl[0].tick) / hrs) - 1) * 100;
      }
      const o = ours.get(p.symbol) ?? { collects: 0, stops: 0, stopEth: 0, rotations: 0 };
      assets.push({
        symbol: p.symbol,
        token: p.token,
        priceEth,
        priceUsd: priceEth * ethUsd,
        drift1hPct: drift == null ? null : Math.round(drift * 100) / 100,
        swaps1h: fl.length,
        activeLiquidity: String(activeL),
        holders,
        ourCollectsUsd: Math.round(o.collects * 100) / 100,
        ourStops: o.stops,
        ourStopEthRealized: Math.round(o.stopEth * 1e6) / 1e6,
        ourRotations: o.rotations,
      });
    } catch { /* an unreadable venue is skipped, never fabricated */ }
  }
  return { ethUsd, assets };
}
