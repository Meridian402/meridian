// Perp-venue feed: live view of the Lighter zk-orderbook exchange on Robinhood
// Chain (65 markets, USDG-margined, zero-fee bootstrap phase) — the venue that
// carries ~1000x the flow of the v4 spot pools. Read-only: this module fetches
// public market data and never touches a wallet.
//
// Sold per call as `meridian_perp_feed` over x402; also summarized into every
// user Merd's persona (perpPersonaLine) so the advisors can discuss the venue.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "../dataDir.js";
import { poolPricesUsd } from "../venues/stockPools.js";

const API = process.env.LIGHTER_API_BASE ?? "https://api.rh.lighter.xyz";
const TTL_MS = 60_000;

// Lighter-native funding currently sits at flat baselines (per-hour). A market
// is only interesting when its rate MOVES OFF these — that's imbalance showing.
const BASELINE_STOCK = 0.000032;
const BASELINE_CRYPTO = 0.000096;

interface PerpMarket {
  symbol: string;
  lastPrice: number;
  volume24hUsd: number;
  trades24h: number;
  fundingPerHour: number | null;
  fundingAprPct: number | null;
  offBaseline: boolean;
  externalFundingPerHour: number | null; // Binance reference for the same symbol
  spotPoolUsd: number | null; // our v4 pool price, where a depth-verified pool exists
  spotPerpBasisPct: number | null; // (spot - perp) / perp
}

let cache: { at: number; payload: unknown } | null = null;

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function offBaseline(rate: number): boolean {
  const near = (b: number) => Math.abs(rate - b) <= b * 0.2;
  return !(near(BASELINE_STOCK) || near(BASELINE_CRYPTO) || near(-BASELINE_STOCK) || near(-BASELINE_CRYPTO));
}

/** Full venue snapshot for the paid MCP tool. Cached 60s so callers can't hammer the upstream API through us. */
export async function perpSnapshot(): Promise<unknown> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.payload;
  const [stats, funding, spot] = await Promise.all([
    getJson("/api/v1/exchangeStats"),
    getJson("/api/v1/funding-rates"),
    poolPricesUsd().catch(() => ({}) as Record<string, number>),
  ]);
  const fLighter = new Map<string, number>();
  const fBinance = new Map<string, number>();
  for (const f of funding.funding_rates ?? []) {
    if (f.exchange === "lighter") fLighter.set(f.symbol, Number(f.rate));
    else if (f.exchange === "binance") fBinance.set(f.symbol, Number(f.rate));
  }
  const markets: PerpMarket[] = (stats.order_book_stats ?? [])
    .map((o: any): PerpMarket => {
      const symbol = String(o.symbol);
      const lastPrice = Number(o.last_trade_price) || 0;
      const fl = fLighter.get(symbol);
      const spotPx = (spot as Record<string, number>)[symbol];
      return {
        symbol,
        lastPrice,
        volume24hUsd: Math.round(Number(o.daily_quote_token_volume) || 0),
        trades24h: Number(o.daily_trades_count) || 0,
        fundingPerHour: fl ?? null,
        fundingAprPct: fl != null ? Math.round(fl * 24 * 365 * 1000) / 10 : null,
        offBaseline: fl != null ? offBaseline(fl) : false,
        externalFundingPerHour: fBinance.get(symbol) ?? null,
        spotPoolUsd: spotPx ?? null,
        spotPerpBasisPct: spotPx && lastPrice ? Math.round(((spotPx - lastPrice) / lastPrice) * 10000) / 100 : null,
      };
    })
    .sort((a: PerpMarket, b: PerpMarket) => b.volume24hUsd - a.volume24hUsd);
  const payload = {
    venue: "lighter-on-robinhood-chain (the orderbook perp venue behind rwa.wtf)",
    asOf: Date.now(),
    feesNote: "maker and taker fees are currently ZERO (bootstrap phase)",
    fundingNote:
      "fundingPerHour is Lighter-native (longs pay shorts when positive). Rates currently cluster at baselines (~0.0032%/h stocks, ~0.0096%/h crypto); offBaseline=true marks real imbalance. externalFundingPerHour is Binance's rate for the same symbol (context, not capturable here).",
    totalVolume24hUsd: markets.reduce((s: number, m: PerpMarket) => s + m.volume24hUsd, 0),
    markets,
  };
  cache = { at: Date.now(), payload };
  return payload;
}

/**
 * One compact, cheap line for the user-agent persona — built from the local
 * sampler ledger (no network on the provisioning path). Empty string if the
 * sampler hasn't written yet.
 */
export function perpPersonaLine(): string {
  try {
    const p = dataPath("lighter-log.jsonl");
    if (!existsSync(p)) return "";
    const lines = readFileSync(p, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
      const row = JSON.parse(lines[i]);
      if (!Array.isArray(row.m)) continue;
      const ms = row.m as [string, number, number, number, number | null, number | null][];
      const total = ms.reduce((s, m) => s + (m[2] || 0), 0);
      // Names, not per-book dollar figures, and the daily total quantized to the
      // nearest $5M.
      //
      // This line goes into a SYSTEM INSTRUCTION, which is the cached prefix of
      // every turn. Exact figures made it change on essentially every sampler
      // write: a 0.4% tick in volume rewrote the string, which rewrites the
      // instruction, which invalidates the cached prefix, which on Haiku 4.5 is
      // the difference between $0.10/M and $1.00/M on ~4,000 tokens of persona
      // plus tools plus the whole conversation behind it. Ten times the price
      // of the turn, to keep two decimal places nobody asked for.
      //
      // Nothing is lost: the agent has live tools and is told to use them when
      // precision matters. A persona is for what is durably true, and "Lighter
      // runs about $40M a day, busiest books are these" stays true for days.
      const top = [...ms].sort((a, b) => (b[2] || 0) - (a[2] || 0)).slice(0, 5).map((m) => m[0]).join(", ");
      const approxM = Math.max(5, Math.round(total / 1e6 / 5) * 5);
      return (
        `Robinhood Chain also runs a zero-fee perp orderbook venue (Lighter, the venue behind rwa.wtf): ${ms.length} markets doing roughly $${approxM}M a day, USDG margined. Busiest books lately: ${top}. ` +
        `Those are round numbers for orientation, so quote them as approximate and reach for a live tool when the exact figure matters. ` +
        `Funding is near flat baselines (roughly 28% APR stocks, 84% APR crypto, annualized) until real imbalance shows. You can analyze and discuss this venue with live numbers, but neither you nor Meridian executes perp trades yet.`
      );
    }
    return "";
  } catch {
    return "";
  }
}
