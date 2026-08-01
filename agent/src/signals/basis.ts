// The basis feed: live gap between 24/7 on-chain pool prices and the real
// equity market's prints, per depth-verified ticker. This is a revenue tool
// for agents on the platform — the pools trade around the clock while NYSE
// doesn't, so the gap (and its convergence at the open) is a tradable signal.
import { poolPricesUsd, uiMultipliers, TRADABLE_SYMBOLS } from "../venues/stockPools.js";

export interface BasisRow {
  symbol: string;
  /** Per-SHARE on-chain price: the raw pool price divided by the ERC-8056
   *  multiplier, so it compares apples-to-apples with a real share price. */
  poolUsd: number;
  marketUsd: number;
  basisPct: number;
  marketState: string;
  marketTime: number;
  /** The token's UI multiplier (1.0 = no split/dividend applied). Surfaced so a
   *  reader can see when a gap is a corporate action rather than a real basis. */
  uiMultiplier: number;
}

async function marketQuote(symbol: string): Promise<{ price: number; time: number; state: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (Meridian)" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const meta = ((await res.json()) as any)?.chart?.result?.[0]?.meta;
    if (typeof meta?.regularMarketPrice !== "number") return null;
    return { price: meta.regularMarketPrice, time: meta.regularMarketTime ?? 0, state: meta.marketState ?? "?" };
  } catch {
    return null;
  }
}

/**
 * The basis of one ticker, with the pool price normalized to a per-share number
 * by its ERC-8056 multiplier. Pure, so the multiplier correction is unit-tested
 * against the exact scenario it exists to prevent: a split moving the multiplier
 * must NOT read as a giant basis.
 */
export function perShareBasis(rawPoolUsd: number, marketUsd: number, uiMultiplier: number): { poolUsd: number; basisPct: number } {
  const m = Number.isFinite(uiMultiplier) && uiMultiplier > 0 ? uiMultiplier : 1;
  const poolUsd = rawPoolUsd / m;
  return { poolUsd, basisPct: ((poolUsd - marketUsd) / marketUsd) * 100 };
}

/** One full basis snapshot across the tradable universe. */
export async function basisSnapshot(): Promise<{ ts: number; rows: BasisRow[]; note: string }> {
  const [pool, mult, quotes] = await Promise.all([
    poolPricesUsd(),
    uiMultipliers(TRADABLE_SYMBOLS),
    Promise.all(TRADABLE_SYMBOLS.map(async (s) => [s, await marketQuote(s)] as const)),
  ]);
  const rows: BasisRow[] = [];
  for (const [symbol, q] of quotes) {
    const rawPoolUsd = pool[symbol];
    if (!q || rawPoolUsd == null || !Number.isFinite(rawPoolUsd)) continue;
    // The pool trades RAW tokens, and a raw token is worth `m` real shares, so
    // its per-share price is rawPool / m. Comparing the RAW pool price to a real
    // per-share price would report a corporate action (a split or dividend that
    // moved m) as a giant fake basis. m is 1.0 until a token has one, so this is
    // a no-op today for most symbols and the correct number the moment it is not.
    const m = mult[symbol] ?? 1;
    const { poolUsd, basisPct } = perShareBasis(rawPoolUsd, q.price, m);
    rows.push({
      symbol,
      poolUsd,
      marketUsd: q.price,
      basisPct,
      marketState: q.state,
      marketTime: q.time,
      uiMultiplier: m,
    });
  }
  rows.sort((a, b) => a.basisPct - b.basisPct);
  return {
    ts: Date.now(),
    rows,
    note:
      "basisPct < 0 means the on-chain pool trades below the last real-market print. " +
      "Off-hours the market side is the previous close; convergence risk runs both directions.",
  };
}
