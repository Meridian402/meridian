import type { ChainId, RwaAsset } from "./types.js";
import { config } from "./config.js";
import { poolPricesUsd } from "./venues/stockPools.js";

export type ChainStatus = "idle" | "active" | "bridging";

export interface ChainInfo {
  id: ChainId;
  label: string;
  status: ChainStatus;
}

/**
 * Chains Meridian can source RWA liquidity on. Scoped to Robinhood Chain for
 * now, by request — the other chains (solana/ethereum/base/polygon) are a
 * real ChainId/CHAIN_IDS-valid future, not deleted, just not populated with
 * assets while focus is The Index. Kept in sync with the frontend chain rail
 * (frontend/src/data/assets.ts).
 */
export const CHAINS: ChainInfo[] = [{ id: "robinhood", label: "Robinhood Chain", status: "active" }];

// The Index (theindex.finance) — the full 18-ticker tokenized-equity basket on
// Robinhood Chain, traded via Uniswap v4 pools. Token contract addresses live
// alongside these in venues/IndexTrader.ts.
//
// These are the SEED values: they double as (a) the instant boot snapshot
// before the first live fetch returns and (b) the fallback if the live feed is
// unreachable, so the agent never reasons over an empty book. At runtime the
// live feed overwrites priceUsd/changePct with real numbers — the tokenized
// equities track their underlying 1:1, so the underlying's spot price and
// trailing intraday move ARE the tokenized asset's price and momentum. (Seed
// changePct values are stale full-session numbers, safely above no live data.)
const SEED: RwaAsset[] = [
  { id: "index-aapl", symbol: "AAPL", name: "Apple", chain: "robinhood", priceUsd: 315.5, changePct: 1.2 },
  { id: "index-amd", symbol: "AMD", name: "AMD", chain: "robinhood", priceUsd: 558.21, changePct: 2.7 },
  { id: "index-amzn", symbol: "AMZN", name: "Amazon", chain: "robinhood", priceUsd: 245.57, changePct: 0.9 },
  { id: "index-be", symbol: "BE", name: "Bloom Energy", chain: "robinhood", priceUsd: 243.86, changePct: -1.4 },
  { id: "index-coin", symbol: "COIN", name: "Coinbase", chain: "robinhood", priceUsd: 159.43, changePct: 2.1 },
  { id: "index-crwv", symbol: "CRWV", name: "CoreWeave", chain: "robinhood", priceUsd: 88.84, changePct: 5.2 },
  { id: "index-googl", symbol: "GOOGL", name: "Alphabet Class A", chain: "robinhood", priceUsd: 356.72, changePct: 1.1 },
  { id: "index-intc", symbol: "INTC", name: "Intel", chain: "robinhood", priceUsd: 109.65, changePct: -2.3 },
  { id: "index-meta", symbol: "META", name: "Meta Platforms", chain: "robinhood", priceUsd: 670.67, changePct: 1.8 },
  { id: "index-msft", symbol: "MSFT", name: "Microsoft", chain: "robinhood", priceUsd: 384.69, changePct: 0.6 },
  { id: "index-mu", symbol: "MU", name: "Micron Technology", chain: "robinhood", priceUsd: 978.54, changePct: 3.1 },
  { id: "index-nvda", symbol: "NVDA", name: "NVIDIA", chain: "robinhood", priceUsd: 210.19, changePct: 3.4 },
  { id: "index-orcl", symbol: "ORCL", name: "Oracle", chain: "robinhood", priceUsd: 141.08, changePct: 0.4 },
  { id: "index-pltr", symbol: "PLTR", name: "Palantir Technologies", chain: "robinhood", priceUsd: 126.56, changePct: 4.1 },
  { id: "index-sndk", symbol: "SNDK", name: "Sandisk", chain: "robinhood", priceUsd: 1921.98, changePct: -0.5 },
  { id: "index-spcx", symbol: "SPCX", name: "SpaceX", chain: "robinhood", priceUsd: 145.73, changePct: 1.5 },
  { id: "index-tsla", symbol: "TSLA", name: "Tesla", chain: "robinhood", priceUsd: 407.83, changePct: -0.8 },
  { id: "index-usar", symbol: "USAR", name: "USA Rare Earth", chain: "robinhood", priceUsd: 18.56, changePct: -3.6 },
];

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

interface LiveQuote {
  priceUsd: number;
  changePct: number;
}

/**
 * One live quote for a tokenized-equity symbol. Reads intraday 5-minute bars
 * from a public equities feed (no key required) and derives the trailing
 * `config.momentumLookbackMinutes` % move — the momentum the strategy rotates
 * on. Tightened from since-previous-close to a short intraday window per
 * direct instruction (2026-07-11). The window is anchored to the LAST BAR's
 * time, not wall-clock, so off-hours it compares the final two closes of the
 * session (≈flat) and the agent naturally holds. Returns null on any failure
 * so the caller keeps the last-known value rather than reasoning over a hole.
 */
/**
 * The trailing % move over `lookbackMinutes`, from one session's 5-minute bars.
 * Exported because this is where the feed silently died and a pure function is
 * the only way to pin the edge that killed it.
 *
 * The window is anchored to the LAST BAR, not to wall-clock, so an off-hours
 * call measures the end of the last session rather than a window full of
 * nothing. Returns null only when the bars cannot support any answer at all.
 */
export function trailingMovePct(timestamps: number[], closes: Array<number | null>, lookbackMinutes: number): number | null {
  if (timestamps.length !== closes.length) return null;
  let lastIdx = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return null;

  const windowStart = timestamps[lastIdx] - lookbackMinutes * 60;
  let baseline: number | null = null;
  for (let i = lastIdx; i >= 0; i--) {
    if (timestamps[i] <= windowStart && closes[i] != null) {
      baseline = closes[i];
      break;
    }
  }

  // Early in the session the full lookback does not exist yet: a 4-hour window
  // needs 4 hours of bars, and at 10am there is one. Refusing the quote here is
  // what this used to do, and since a calendar day holds only ~6.5 hours of
  // regular-session bars, it meant NO live quote until nearly four hours into
  // every session, and none overnight, at a weekend or on a holiday. Production
  // logged "live refresh: 0/18" on every cycle for weeks: dataSource().live was
  // false, the site showed seed prices, and the swarm never once opened a
  // conversation on live prices because its topic builder correctly refuses to
  // reason over a feed that says it is not live.
  //
  // So fall back to the session's FIRST bar, making the figure "since the open"
  // until the window fills. Still strictly intraday: the caller requests one
  // session, so this can never reach across the overnight gap and quietly turn
  // a 4-hour move into a 21-hour one.
  if (baseline == null) {
    for (let i = 0; i <= lastIdx; i++) {
      if (closes[i] != null) {
        baseline = closes[i];
        break;
      }
    }
  }
  if (baseline == null || baseline === 0) return null;
  return ((closes[lastIdx]! - baseline) / baseline) * 100;
}

async function fetchLiveQuote(symbol: string): Promise<LiveQuote | null> {
  // range=1d is deliberate and load-bearing: it returns ONE session, so every
  // bar considered below is from the same day and a baseline can never be
  // picked from across the overnight gap. Widening it to satisfy the lookback
  // would quietly restore the since-previous-close behaviour this was tightened
  // away from on 2026-07-11.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Meridian agent)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number };
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice;
    if (typeof price !== "number") return null;

    const pct = trailingMovePct(result?.timestamp ?? [], result?.indicators?.quote?.[0]?.close ?? [], config.momentumLookbackMinutes);
    if (pct == null) return null;
    return { priceUsd: round(price, 2), changePct: round(pct, 2) };
  } catch {
    return null;
  }
}

export interface DataSourceStatus {
  /** true once at least one live quote has landed; false while still on seed/fallback. */
  live: boolean;
  provider: string;
  lastFetchedAt: number | null;
  /** how many of the tracked assets carried a live quote as of the last refresh. */
  liveCount: number;
  assetCount: number;
}

/**
 * RWA price/asset feed. The public tool surface (listChains / listAssets /
 * getAsset) is synchronous and unchanged — callers (the agent loop, the MCP
 * tools) read a snapshot that a background refresh keeps current from the live
 * equities feed. Boots instantly on SEED so nothing ever blocks on the network;
 * live quotes overwrite the snapshot as they arrive and on a TTL thereafter.
 */
export class MarketData {
  private assets: RwaAsset[] = SEED.map((a) => ({ ...a }));
  private lastFetchedAt: number | null = null;
  private liveCount = 0;
  private refreshing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { autoRefresh?: boolean; ttlMs?: number } = {}) {
    // Disable for tests / the backtest (which brings its own historical data)
    // via MERIDIAN_LIVE_PRICES=0, so importing this module never hits the wire
    // unless a live server actually wants it.
    const enabled = (opts.autoRefresh ?? process.env.MERIDIAN_LIVE_PRICES !== "0") === true;
    if (!enabled) return;
    // 3 min default: pool prices on this thin chain barely move minute to
    // minute, live trading is off, and the site display doesn't need second-
    // level freshness. This was the single biggest steady RPC consumer at 60s.
    const ttlMs = opts.ttlMs ?? Number(process.env.MERIDIAN_PRICE_TTL_MS ?? 180_000);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), ttlMs);
    this.timer.unref?.(); // don't keep the process alive on this alone
  }

  /** Pull live quotes for every tracked asset in parallel; keep last-known on miss. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const quotes = await Promise.all(
        this.assets.map(async (a) => [a.symbol, await fetchLiveQuote(a.symbol)] as const),
      );
      const bySymbol = new Map(quotes);
      let live = 0;
      this.assets = this.assets.map((a) => {
        const q = bySymbol.get(a.symbol);
        if (!q) return a; // unreachable this cycle — keep the last-known value
        live++;
        return { ...a, priceUsd: q.priceUsd, changePct: q.changePct };
      });
      this.liveCount = live;
      if (live > 0) this.lastFetchedAt = Date.now();
      await this.overlayPoolPrices();
      console.error(`[marketData] live refresh: ${live}/${this.assets.length} Index quotes`);
    } finally {
      this.refreshing = false;
    }
  }

  /** Rolling pool-price samples per symbol, spanning at least the momentum lookback. */
  private poolHistory = new Map<string, { ts: number; priceUsd: number }[]>();

  /**
   * Overlay on-chain pool prices for the tickers we can actually execute —
   * the pools trade 24/7, so this keeps priceUsd and changePct live when the
   * equity feed is frozen (nights/weekends). Momentum is the trailing
   * `momentumLookbackMinutes` move of the POOL price, from our own samples;
   * until enough history accumulates (≈one lookback after boot) the equity
   * feed's changePct stands. Chain unreachable → keep equity-feed values.
   */
  private async overlayPoolPrices(): Promise<void> {
    if (!config.robinhoodRpcUrl) return;
    let poolPrices: Record<string, number>;
    try {
      poolPrices = await poolPricesUsd();
    } catch {
      return;
    }
    const now = Date.now();
    const lookbackMs = config.momentumLookbackMinutes * 60_000;
    this.assets = this.assets.map((a) => {
      const poolPx = poolPrices[a.symbol];
      if (poolPx == null || !Number.isFinite(poolPx) || poolPx <= 0) return a;
      const hist = this.poolHistory.get(a.symbol) ?? [];
      hist.push({ ts: now, priceUsd: poolPx });
      while (hist.length > 0 && hist[0].ts < now - lookbackMs - 120_000) hist.shift();
      this.poolHistory.set(a.symbol, hist);
      let changePct = a.changePct;
      const windowStart = now - lookbackMs;
      let baseline: { ts: number; priceUsd: number } | undefined;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].ts <= windowStart) {
          baseline = hist[i];
          break;
        }
      }
      if (baseline && baseline.priceUsd > 0) changePct = round(((poolPx - baseline.priceUsd) / baseline.priceUsd) * 100, 2);
      return { ...a, priceUsd: round(poolPx, 2), changePct };
    });
  }

  /** Whether the snapshot is live-backed and how fresh — surfaced by MCP/monitor. */
  dataSource(): DataSourceStatus {
    return {
      live: this.lastFetchedAt != null,
      provider: "yahoo-finance-chart-v8 + on-chain v4 pools (tradable tickers)",
      lastFetchedAt: this.lastFetchedAt,
      liveCount: this.liveCount,
      assetCount: this.assets.length,
    };
  }

  listChains(): ChainInfo[] {
    return CHAINS;
  }

  listAssets(chain?: ChainId): RwaAsset[] {
    const pool = chain ? this.assets.filter((a) => a.chain === chain) : this.assets;
    return pool.map((a) => ({ ...a }));
  }

  getAsset(symbol: string): RwaAsset | undefined {
    const needle = symbol.toUpperCase();
    const a = this.assets.find((x) => x.symbol.toUpperCase() === needle);
    return a ? { ...a } : undefined;
  }
}
