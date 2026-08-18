// Backfill: walk the journals the desk already kept and emit attribution
// rows for the era before the accountant existed. Deliberately best-effort:
// gas is 0 (cents per op on this chain), ETH amounts are valued with a
// daily close map, and every row is stamped backfilled+approx so the report
// can show the historical era with the honesty it deserves. Idempotent:
// rows are deduped by tx+mech against what attribution.jsonl already holds.
import { existsSync, readFileSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { readAttributionRows, recordAttribution, type AttributionRow, type Sleeve } from "./attribution.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";

function readJsonl(file: string): any[] {
  const path = dataPath(file);
  if (!existsSync(path)) return [];
  const rows: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

/** Daily ETH-USD closes for valuing historical ETH amounts. Falls back to a
 *  flat current price if the range fetch fails (still stamped approx). */
async function dailyEthUsdMap(): Promise<{ at: (ts: number) => number }> {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/ETH-USD?range=3mo&interval=1d", {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const j: any = await res.json();
    const r = j?.chart?.result?.[0];
    const stamps: number[] = r?.timestamp ?? [];
    const closes: number[] = r?.indicators?.quote?.[0]?.close ?? [];
    const byDay = new Map<string, number>();
    stamps.forEach((t, i) => {
      const c = closes[i];
      if (Number.isFinite(c)) byDay.set(new Date(t * 1000).toISOString().slice(0, 10), c);
    });
    if (byDay.size > 0) {
      const fallback = [...byDay.values()].at(-1)!;
      return { at: (ts) => byDay.get(new Date(ts).toISOString().slice(0, 10)) ?? fallback };
    }
  } catch {
    /* fall through */
  }
  const flat = (await fetchEthUsd().catch(() => 0)) ?? 0;
  return { at: () => flat };
}

export async function runAttributionBackfill(): Promise<{ emitted: number; skipped: number; holes: string[] }> {
  const seen = new Set<string>();
  for (const r of readAttributionRows(0)) seen.add(`${r.tx ?? `${r.ts}`}:${r.mech}`);
  const px = await dailyEthUsdMap();
  let emitted = 0;
  let skipped = 0;
  const holes: string[] = [];

  const emit = (row: Omit<AttributionRow, "backfilled" | "approx">) => {
    const key = `${row.tx ?? `${row.ts}`}:${row.mech}`;
    if (seen.has(key)) {
      skipped += 1;
      return;
    }
    seen.add(key);
    recordAttribution({ ...row, backfilled: true, approx: true });
    emitted += 1;
  };
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : 0;
  };

  // The meme rotation journal: per-venue ETH lumps, valued at that day's close.
  for (const r of readJsonl("meme-rotations.jsonl")) {
    const ts: number = r.ts ?? 0;
    if (!ts) continue;
    const ethUsd = px.at(ts);
    const meme = (venue: string) => ({ ts, sleeve: "meme" as Sleeve, venue, ethUsd, gasUsd: 0 });
    const tx: string | undefined = r.tx ?? r.txs?.[0];
    if (r.kind === "expand" && r.venue) {
      emit({ ...meme(r.venue), mech: "band-mint", usdIn: num(r.ethIn) * ethUsd, usdOut: 0, feeUsd: 0, tx });
    } else if (r.kind === "capitulation-catch" && r.venue) {
      emit({ ...meme(r.venue), mech: "catch-mint", usdIn: num(r.ethIn) * ethUsd, usdOut: 0, feeUsd: 0, tx });
    } else if (r.kind === "collect" && r.pool) {
      const usd = num(r.ethCollected) * ethUsd;
      emit({ ...meme(r.pool), tokenId: r.tokenId, mech: "collect", usdIn: 0, usdOut: usd, feeUsd: usd, tx });
    } else if (r.kind === "stop-loss" && r.pool) {
      emit({ ...meme(r.pool), mech: "stop-exit", usdIn: 0, usdOut: num(r.ethRealized) * ethUsd, feeUsd: 0, tx });
    } else if (r.kind === "wallet-sweep" && r.pool) {
      emit({ ...meme(r.pool), mech: "sweep", usdIn: 0, usdOut: num(r.ethRealized) * ethUsd, feeUsd: 0, tx });
    } else if (r.kind === "migrate" && r.from && r.to) {
      const moved = num(r.ethMoved) * ethUsd;
      const heldBack = num(r.ethHeldBack) * ethUsd;
      emit({ ...meme(r.from), mech: "migrate-out", usdIn: 0, usdOut: moved + heldBack, feeUsd: 0, tx });
      emit({ ...meme(r.to), mech: "band-mint", usdIn: moved, usdOut: 0, feeUsd: 0, tx: tx ? `${tx}:in` : undefined });
    }
    // rotate rows (no kind) are cash-neutral historically; breaker-withdraw and
    // stale-withdraw recorded no amounts, a known hole.
  }
  holes.push("meme breaker-withdraw and stale-withdraw rows carry no amounts; their returned ETH is missing from history");

  // The USDG sleeve: mint basis is exact (usdgIn); the token-buy legs that
  // funded the token sides were never recorded, a known hole that overstates
  // historical USDG nets. Sells are exact from the executions ledger.
  for (const r of readJsonl("lp-positions.jsonl")) {
    if (!r.symbol || r.usdgIn == null || !r.mintedAt) continue;
    emit({ ts: r.mintedAt, sleeve: "usdg", venue: r.symbol, tokenId: r.tokenId, mech: "mint", usdIn: num(r.usdgIn), usdOut: 0, feeUsd: 0, gasUsd: 0, ethUsd: px.at(r.mintedAt), tx: r.txHash });
  }
  holes.push("historical token-buy funding legs were never recorded; USDG venue history reads better than it was");

  for (const r of readJsonl("executions.jsonl")) {
    const ts: number = r.ts ?? 0;
    if (!ts || r.success !== true) continue;
    if (r.kind === "liquidation" && r.fromSymbol) {
      emit({ ts, sleeve: "usdg", venue: r.fromSymbol, mech: "sell", usdIn: 0, usdOut: num(r.amountUsd), feeUsd: 0, gasUsd: 0, ethUsd: px.at(ts), tx: r.txHash });
    } else if (r.kind === "lp-collect" && r.fromSymbol) {
      const usd = num(r.amountUsd);
      emit({ ts, sleeve: "usdg", venue: r.fromSymbol, mech: "collect", usdIn: 0, usdOut: usd, feeUsd: usd, gasUsd: 0, ethUsd: px.at(ts), tx: r.txHash });
    }
    // lp-exit rows recorded amountUsd 0 for their whole history; nothing to recover.
  }
  holes.push("historical lp-exit proceeds were recorded as $0 and are not recoverable from the ledgers");

  console.error(`[attribution] backfill: ${emitted} rows emitted, ${skipped} already present`);
  return { emitted, skipped, holes };
}
