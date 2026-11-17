/**
 * TOKEN SIGNALS (2026-11-17). Read-only record keeping, beside the hourly pool
 * record. No signer, no key, no chain reads: everything comes from the public
 * pool index.
 *
 * The operator's point: a pool should not be entered just because it has
 * volume; who holds the token, how many wallets are trading it and whether
 * anyone is paying attention to it should count too. The first day of the
 * record agrees about volume. On Base the watched pools cleared the desk's
 * $150k/h flow bar in 105 of 144 pool-hours and never once paid a $1,000 seat
 * $3 in an hour; on the desk's own chain no pool cleared the flow bar at all
 * and four of them paid $6 or more in eleven separate hours.
 *
 * So this file writes down, once an hour for every watched pool:
 *   - who traded it in the last 60 minutes: buys, sells, distinct buyers and
 *     sellers, distinct traders (the index's count, not ours)
 *   - who holds the token: holder count, the top ten wallets' share, the
 *     developer's share, the index's own quality score and honeypot flag
 *   - attention: the pool's place on its network's trending list, if it is on it
 *
 * It decides nothing. A signal earns a place in an entry rule only if, on hours
 * it has not seen, it predicts a seat's income or a falling price better than
 * the seat's own recent fees do. That first check was already strong (rank
 * correlation 0.91 between a pool's last three hours of seat fees and its next
 * three, on thirteen decision hours), so the bar for anything added here is
 * "better than that", not "sounds sensible".
 *
 * What this is NOT: real social data. Post counts and follower growth need a
 * paid feed. The trending list is a free stand-in for attention and is recorded
 * as exactly that.
 *
 * The index allows only a handful of calls a minute without a key, so calls are
 * spaced and holder figures (which move slowly) are re-read every six hours,
 * not every hour.
 *
 * Run: tsx src/signals/tokenSignals.ts            one pass, appends to the ledger
 *      tsx src/signals/tokenSignals.ts --report   the latest reading per pool
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataPath } from "../dataDir.js";
import { WATCHED as RH_WATCHED, labelOf } from "./poolWatch.js";
import { CHAINS, WATCHED as CHAIN_WATCHED, type ChainKey } from "./chainTrack.js";

export const SIGNAL_LEDGER = "token-signals.jsonl";
const CALL_GAP_MS = 10_000; // the keyless limit is a handful of calls a minute; 7 s was refused in practice
const HOLDERS_MAX_AGE_MS = 6 * 3600_000;

export interface SignalTarget {
  chain: string;
  /** The pool index's name for the network. */
  network: string;
  /** Same key the replay uses for the pool: `<chain>:<pool id or address, lower case>`. */
  key: string;
  label: string;
  /** What the index calls the pool: its address, or its id on Uniswap v4. */
  ref: string;
}

/** PURE: every watched pool on every chain, keyed the way the replay keys them. */
export function targets(): SignalTarget[] {
  const out: SignalTarget[] = RH_WATCHED.map((p) => ({ chain: "robinhood", network: "robinhood", key: `robinhood:${p.id.toLowerCase()}`, label: labelOf(p), ref: p.id.toLowerCase() }));
  for (const chain of Object.keys(CHAINS) as ChainKey[]) {
    for (const p of CHAIN_WATCHED[chain]) out.push({ chain, network: CHAINS[chain].indexNetwork, key: `${chain}:${p.address.toLowerCase()}`, label: p.label, ref: p.address.toLowerCase() });
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface PoolReading {
  baseToken: string | null;
  buys1h: number | null;
  sells1h: number | null;
  buyers1h: number | null;
  sellers1h: number | null;
  traders1h: number | null;
  reserveUsd: number | null;
  fdvUsd: number | null;
  lockedLiqPct: number | null;
}

/** PURE: the index's multi-pool answer -> one reading per pool, by lower-case address or id. */
export function parsePools(json: unknown): Map<string, PoolReading> {
  const out = new Map<string, PoolReading>();
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return out;
  for (const row of rows as Array<Record<string, any>>) {
    const a = row?.attributes ?? {};
    const address = typeof a.address === "string" ? a.address.toLowerCase() : null;
    if (!address) continue;
    const h1 = a.transactions?.h1 ?? {};
    const baseId: unknown = row?.relationships?.base_token?.data?.id;
    out.set(address, {
      // ids look like "<network>_<address>"; the network name can itself contain an underscore
      baseToken: typeof baseId === "string" && baseId.includes("_") ? baseId.slice(baseId.lastIndexOf("_") + 1).toLowerCase() : null,
      buys1h: num(h1.buys), sells1h: num(h1.sells), buyers1h: num(h1.buyers), sellers1h: num(h1.sellers), traders1h: num(h1.unique_traders),
      reserveUsd: num(a.reserve_in_usd), fdvUsd: num(a.fdv_usd), lockedLiqPct: num(a.locked_liquidity_percentage),
    });
  }
  return out;
}

export interface HolderReading {
  holders: number | null;
  top10Pct: number | null;
  devPct: number | null;
  gtScore: number | null;
  honeypot: boolean | null;
  /** When the index last refreshed its holder figures, if it says. */
  holdersAsOf: string | null;
}

/** PURE: the index's token-info answer -> holder figures. Null fields mean the index did not say. */
export function parseTokenInfo(json: unknown): HolderReading | null {
  const a = (json as { data?: { attributes?: Record<string, any> } })?.data?.attributes;
  if (!a || typeof a !== "object") return null;
  const h = a.holders ?? {};
  return {
    holders: num(h.count),
    // The index sends a flat 0 for some tokens with thousands of holders (seen on HBTC, 2026-11-17).
    // Ten wallets holding nothing is not a reading; it is recorded as not known.
    top10Pct: num(h.distribution_percentage?.top_10) || null,
    devPct: num(a.developer_holding_percentage),
    gtScore: num(a.gt_score),
    honeypot: typeof a.is_honeypot === "boolean" ? a.is_honeypot : null,
    holdersAsOf: typeof h.last_updated === "string" ? h.last_updated : null,
  };
}

/** PURE: the network's trending list -> pool -> place on it (1 is the top). */
export function parseTrending(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return out;
  rows.forEach((row: any, i: number) => {
    const address = row?.attributes?.address;
    if (typeof address === "string" && !out.has(address.toLowerCase())) out.set(address.toLowerCase(), i + 1);
  });
  return out;
}

export interface SignalRow extends PoolReading, HolderReading {
  ts: number;
  kind: "signal";
  chain: string;
  key: string;
  label: string;
  /** Place on the network's trending list at `ts`; null when not on it or the list could not be read. */
  trendingRank: number | null;
  /** False when the trending list itself could not be read, so null rank is "unknown", not "absent". */
  trendingRead: boolean;
  /** When the holder figures in this row were fetched (carried forward between refreshes). */
  holdersTs: number | null;
}

/** PURE: holder figures are re-read when there are none, or the last read is older than the limit. */
export function holdersStale(last: Pick<SignalRow, "holdersTs"> | undefined, now: number, maxAgeMs = HOLDERS_MAX_AGE_MS): boolean {
  return !last || last.holdersTs == null || now - last.holdersTs >= maxAgeMs;
}

/** Every row on the ledger, oldest first. A line that does not parse is skipped. */
export function readSignals(file = SIGNAL_LEDGER): SignalRow[] {
  const p = dataPath(file);
  if (!existsSync(p)) return [];
  const out: SignalRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SignalRow;
      if (r && r.kind === "signal" && typeof r.key === "string") out.push(r);
    } catch {
      /* a torn line is not worth stopping for */
    }
  }
  return out;
}

/** PURE: the newest row per pool. */
export function latestByPool(rows: readonly SignalRow[]): Map<string, SignalRow> {
  const out = new Map<string, SignalRow>();
  for (const r of rows) if (!out.has(r.key) || out.get(r.key)!.ts <= r.ts) out.set(r.key, r);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One spaced call to the index. Null on failure: a missing reading is recorded as missing, never guessed. */
async function indexGet(network: string, path: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(attempt === 0 ? CALL_GAP_MS : CALL_GAP_MS * 3 * attempt);
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}${path}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) return null; // asking again will not change a 404
    } catch {
      /* retry below */
    }
  }
  return null;
}

/** One pass: a row per watched pool. Read-only. */
export async function runOnce(log: (line: string) => void = (l) => console.log(l)): Promise<{ appended: number }> {
  const all = targets();
  const last = latestByPool(readSignals());
  const now = Date.now();
  let appended = 0;
  const networks = [...new Set(all.map((t) => t.network))];
  for (const network of networks) {
    const mine = all.filter((t) => t.network === network);
    const chain = mine[0].chain;
    const skipInfo = new Set<string>();
    const cfg = (CHAINS as Record<string, (typeof CHAINS)[ChainKey] | undefined>)[chain];
    if (cfg) for (const a of [cfg.wrappedNative, ...cfg.stables]) skipInfo.add(a.toLowerCase()); // a holder count for WETH says nothing about a pool
    const poolsJson = await indexGet(network, `/pools/multi/${mine.map((t) => t.ref).join(",")}`);
    const pools = parsePools(poolsJson);
    const trendingJson = await indexGet(network, "/trending_pools?page=1");
    const trending = parseTrending(trendingJson);
    const trendingRead = Array.isArray((trendingJson as { data?: unknown } | null)?.data);
    const infoByToken = new Map<string, { reading: HolderReading | null; ts: number | null }>();
    for (const t of mine) {
      const pool = pools.get(t.ref);
      if (!pool) {
        log(`[tokenSignals] ${chain} ${t.label}: the index returned nothing for this pool`);
        continue;
      }
      const prev = last.get(t.key);
      let holder: HolderReading = { holders: prev?.holders ?? null, top10Pct: prev?.top10Pct ?? null, devPct: prev?.devPct ?? null, gtScore: prev?.gtScore ?? null, honeypot: prev?.honeypot ?? null, holdersAsOf: prev?.holdersAsOf ?? null };
      let holdersTs = prev?.holdersTs ?? null;
      if (pool.baseToken && !skipInfo.has(pool.baseToken) && holdersStale(prev, now)) {
        if (!infoByToken.has(pool.baseToken)) {
          const reading = parseTokenInfo(await indexGet(network, `/tokens/${pool.baseToken}/info`));
          infoByToken.set(pool.baseToken, { reading, ts: reading ? Date.now() : null });
        }
        const got = infoByToken.get(pool.baseToken)!;
        if (got.reading) {
          holder = got.reading;
          holdersTs = got.ts;
        }
      }
      const row: SignalRow = { ts: Date.now(), kind: "signal", chain, key: t.key, label: t.label, ...pool, ...holder, trendingRank: trending.get(t.ref) ?? null, trendingRead, holdersTs };
      appendFileSync(dataPath(SIGNAL_LEDGER), JSON.stringify(row) + "\n");
      appended++;
    }
  }
  log(`[tokenSignals] ${new Date().toISOString().slice(0, 16)}Z: appended ${appended} of ${all.length} pool readings`);
  return { appended };
}

/** The latest reading per pool, as a table. */
export function report(log: (line: string) => void = (l) => console.log(l)): void {
  const rows = readSignals();
  if (!rows.length) {
    log("No token signals recorded yet. Run: tsx src/signals/tokenSignals.ts");
    return;
  }
  const latest = latestByPool(rows);
  const n = (v: number | null, digits = 0) => (v == null ? "-" : v.toLocaleString(undefined, { maximumFractionDigits: digits }));
  log(`TOKEN SIGNALS, latest reading per pool (${rows.length} rows since ${new Date(rows[0].ts).toISOString().slice(0, 16)}Z). Recorded, not acted on.`);
  log(`${"chain".padEnd(10)} ${"pool".padEnd(24)} ${"holders".padStart(9)} ${"top10%".padStart(7)} ${"dev%".padStart(6)} ${"score".padStart(6)} ${"buyers1h".padStart(9)} ${"sellers1h".padStart(10)} ${"traders1h".padStart(10)} ${"trending".padStart(9)}  read`);
  for (const t of targets()) {
    const r = latest.get(t.key);
    if (!r) {
      log(`${t.chain.padEnd(10)} ${t.label.slice(0, 24).padEnd(24)} (no reading)`);
      continue;
    }
    const trend = r.trendingRank != null ? `#${r.trendingRank}` : r.trendingRead ? "no" : "?";
    log(`${r.chain.padEnd(10)} ${r.label.slice(0, 24).padEnd(24)} ${n(r.holders).padStart(9)} ${n(r.top10Pct, 1).padStart(7)} ${n(r.devPct, 1).padStart(6)} ${n(r.gtScore).padStart(6)} ${n(r.buyers1h).padStart(9)} ${n(r.sellers1h).padStart(10)} ${n(r.traders1h).padStart(10)} ${trend.padStart(9)}  ${new Date(r.ts).toISOString().slice(5, 16)}Z${r.honeypot ? "  HONEYPOT FLAG" : ""}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--report")) report();
  else runOnce().catch((err) => {
    console.error(`[tokenSignals] run failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`);
    process.exitCode = 1;
  });
}
