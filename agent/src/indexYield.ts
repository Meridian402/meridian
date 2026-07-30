// $INDEX distribution-yield data — the real mechanics behind theindex.finance's
// "hold it, get paid in stocks" product, read from the product's own public
// endpoints (no API key, no on-chain RPC needed for reads):
//   - /live      : real-time snapshot (price, ETH/USD, holder count, pending pot)
//   - /indexer   : GraphQL history of distribution events, for a trend signal
//
// Verified on-chain (2026-07-11): eligibility threshold is a literal contract
// constant (10,000e18 — g9 in the product's minified bundle); the 3% entry/exit
// fee is a hook (0x2cD91bD2...) on the ETH<->$INDEX Uniswap v4 pool, confirmed
// both by the product's own marketing copy ("A 3% ETH fee on trades funds stock
// distributions for eligible holders") and by reading the pool's fee tier
// on-chain. See meridian-index-yield-mechanics memory for the full derivation.
const LIVE_URL = "https://theindex.finance/live";
const INDEXER_URL = "https://theindex.finance/indexer";
const DIST_FAILURES_BEFORE_MUTE = Number(process.env.MERIDIAN_INDEX_DIST_FAILURES ?? 3);
const DIST_MUTE_MS = Number(process.env.MERIDIAN_INDEX_DIST_MUTE_MS ?? 15 * 60_000);

export const ELIGIBILITY_THRESHOLD_TOKENS = 10_000;
export const ENTRY_FEE_PCT = 3;

export const STOCK_ADDR_TO_SYMBOL: Record<string, string> = {
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "AAPL",
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": "AMD",
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "AMZN",
  "0x822cc93ffd030293e9842c30bbd678f530701867": "BE",
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN",
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3": "CRWV",
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "GOOGL",
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": "INTC",
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "META",
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": "MSFT",
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": "MU",
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "NVDA",
  "0xb0992820e760d836549ba69bc7598b4af75dee03": "ORCL",
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "PLTR",
  "0xb90a19ff0af67f7779aff50a882a9cff42446400": "SNDK",
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "SPCX",
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "TSLA",
  "0xd917b029c761d264c6a312bbbcda868658ef86a6": "USAR",
};

export type YieldTrend = "rising" | "falling" | "stable" | "unknown";

export interface IndexYieldSnapshot {
  live: boolean;
  asOf: number | null;
  ethUsd: number;
  indexPriceEth: number;
  indexPriceUsd: number;
  eligibilityThresholdTokens: number;
  eligibilityThresholdUsd: number;
  eligibleSupplyTokens: number | null;
  holderCount: number | null;
  nextDistributionAt: number | null;
  pendingPotUsd: number;
  entryFeePct: number;
  /** current USD price per Index stock ticker — needed to value distributions actually received. */
  stockUsd: Record<string, number>;
  /** trailing distributed-value rate, USD/day, most-recent half of the sampled window */
  distributedUsdPerDayRecent: number | null;
  /** same rate, prior half of the window — the comparison point for `trend` */
  distributedUsdPerDayPrior: number | null;
  trend: YieldTrend;
}

const UNKNOWN_SNAPSHOT: IndexYieldSnapshot = {
  live: false,
  asOf: null,
  ethUsd: 0,
  indexPriceEth: 0,
  indexPriceUsd: 0,
  eligibilityThresholdTokens: ELIGIBILITY_THRESHOLD_TOKENS,
  eligibilityThresholdUsd: 0,
  eligibleSupplyTokens: null,
  holderCount: null,
  nextDistributionAt: null,
  pendingPotUsd: 0,
  entryFeePct: ENTRY_FEE_PCT,
  stockUsd: {},
  distributedUsdPerDayRecent: null,
  distributedUsdPerDayPrior: null,
  trend: "unknown",
};

interface LiveResponse {
  stockUsd: Record<string, number>;
  potBySym: Record<string, string>;
  holderCount: number;
  ethUsd: number;
  indexPriceEth: number;
  eligibleSupply: string;
  nextDistribution: number;
  updatedAt: number;
}

interface DistributionItem {
  stock: string;
  amount: string;
  timestamp: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const DISTRIBUTIONS_QUERY = `{
  distributions(orderBy: "timestamp", orderDirection: "desc", limit: 500) {
    items { stock amount timestamp }
  }
}`;

/** Splits the sampled window at its time midpoint and rates each half in USD/day. */
function trendFromDistributions(
  items: DistributionItem[],
  stockUsd: Record<string, number>,
): Pick<IndexYieldSnapshot, "distributedUsdPerDayRecent" | "distributedUsdPerDayPrior" | "trend"> {
  if (items.length < 20) {
    return { distributedUsdPerDayRecent: null, distributedUsdPerDayPrior: null, trend: "unknown" };
  }
  const withUsd = items.map((it) => {
    const sym = STOCK_ADDR_TO_SYMBOL[it.stock.toLowerCase()];
    const price = sym ? stockUsd[sym] : undefined;
    return { ts: Number(it.timestamp), usd: price != null ? (Number(it.amount) / 1e18) * price : 0 };
  });
  const times = withUsd.map((w) => w.ts);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const mid = (min + max) / 2;
  const recent = withUsd.filter((w) => w.ts > mid);
  const prior = withUsd.filter((w) => w.ts <= mid);
  const halfDays = (max - min) / 2 / 86400;
  if (halfDays <= 0) return { distributedUsdPerDayRecent: null, distributedUsdPerDayPrior: null, trend: "unknown" };

  const recentRate = recent.reduce((a, w) => a + w.usd, 0) / halfDays;
  const priorRate = prior.reduce((a, w) => a + w.usd, 0) / halfDays;
  let trend: YieldTrend = "stable";
  if (priorRate > 0) {
    if (recentRate > priorRate * 1.15) trend = "rising";
    else if (recentRate < priorRate * 0.85) trend = "falling";
  }
  return { distributedUsdPerDayRecent: recentRate, distributedUsdPerDayPrior: priorRate, trend };
}

/**
 * Cached client for The Index's own live-stats and distribution-history
 * endpoints — the real signal behind "hold $INDEX, get paid in stocks,"
 * replacing the old per-stock momentum feed as what Meridian's strategy
 * reasons over. TTL'd so a 3-20s agent-loop cadence doesn't hammer a product
 * we don't operate; distributions actually land every ~15-20 minutes.
 */
export class IndexYieldData {
  private cached: IndexYieldSnapshot = UNKNOWN_SNAPSHOT;
  private lastFetchedAt = 0;

  constructor(private ttlMs = Number(process.env.MERIDIAN_INDEX_YIELD_TTL_MS ?? 120_000)) {}

  // A dead upstream should cost us one slow call, not one every couple of
  // minutes forever. After a few consecutive failures the distributions query is
  // skipped outright for a cooldown, so a third party being down stops costing
  // us 8 seconds of every refresh and a stack trace in the log each time.
  private distFailures = 0;
  private distMutedUntil = 0;

  private async fetchDistributions(): Promise<{ data: { distributions: { items: DistributionItem[] } } } | null> {
    if (Date.now() < this.distMutedUntil) return null;
    try {
      const r = await fetchJson<{ data: { distributions: { items: DistributionItem[] } } }>(INDEXER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: DISTRIBUTIONS_QUERY }),
      });
      this.distFailures = 0;
      return r;
    } catch (err) {
      this.distFailures += 1;
      if (this.distFailures >= DIST_FAILURES_BEFORE_MUTE) {
        this.distMutedUntil = Date.now() + DIST_MUTE_MS;
        console.error(
          `[indexYield] distributions upstream failed ${this.distFailures} times, skipping it for ${Math.round(DIST_MUTE_MS / 60000)}min. ` +
            "Price and pot stay live; only the payout trend is unavailable.",
        );
      }
      return null;
    }
  }

  async snapshot(): Promise<IndexYieldSnapshot> {
    if (Date.now() - this.lastFetchedAt < this.ttlMs) return this.cached;
    try {
      // allSettled, NOT all. These are two independent upstreams and only one of
      // them carries the price. Failing the pair together means a broken
      // distributions resolver throws away a perfectly good price quote and the
      // whole snapshot goes stale, which is what was happening: /live answers in
      // under half a second while /indexer hangs on this query until our own
      // timeout fires. The trend is the only thing that should degrade.
      const [liveRes, distRes] = await Promise.allSettled([
        fetchJson<LiveResponse>(LIVE_URL),
        this.fetchDistributions(),
      ]);
      if (liveRes.status === "rejected") throw liveRes.reason;
      const live = liveRes.value;
      const dist = distRes.status === "fulfilled" ? distRes.value : null;

      if (!Number.isFinite(live.indexPriceEth) || !Number.isFinite(live.ethUsd)) {
        throw new Error(
          `indexYield live response missing/invalid indexPriceEth or ethUsd: ${JSON.stringify({ indexPriceEth: live.indexPriceEth, ethUsd: live.ethUsd })}`,
        );
      }
      const indexPriceUsd = live.indexPriceEth * live.ethUsd;
      const pendingPotUsd = Object.entries(live.potBySym).reduce((sum, [sym, wei]) => {
        const price = live.stockUsd[sym];
        return price != null ? sum + (Number(wei) / 1e18) * price : sum;
      }, 0);
      // No distributions means no trend, and saying so beats inventing one.
      const trend = dist
        ? trendFromDistributions(dist.data.distributions.items, live.stockUsd)
        : { distributedUsdPerDayRecent: null, distributedUsdPerDayPrior: null, trend: "unknown" as const };

      this.cached = {
        live: true,
        asOf: live.updatedAt,
        ethUsd: live.ethUsd,
        indexPriceEth: live.indexPriceEth,
        indexPriceUsd,
        eligibilityThresholdTokens: ELIGIBILITY_THRESHOLD_TOKENS,
        eligibilityThresholdUsd: ELIGIBILITY_THRESHOLD_TOKENS * indexPriceUsd,
        eligibleSupplyTokens: Number(live.eligibleSupply) / 1e18,
        holderCount: live.holderCount,
        nextDistributionAt: live.nextDistribution,
        pendingPotUsd,
        entryFeePct: ENTRY_FEE_PCT,
        stockUsd: live.stockUsd,
        ...trend,
      };
      this.lastFetchedAt = Date.now();
    } catch (err) {
      console.error("[indexYield] fetch failed, keeping last-known snapshot:", err);
    }
    return this.cached;
  }
}
