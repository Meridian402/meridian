// The earning progression that is actually worth charting: cumulative revenue
// BANKED to the treasury, reconstructed from chain history. Two sources are
// income and nothing else is:
//   1. WETH from the PonsLaunchLocker = MERD creator fee share, paid out of
//      real MERD trading volume.
//   2. Native ETH from the execution wallet = desk fee skims (the 50% ETH-side
//      LP fee bank).
// Everything else touching the treasury is capital moving between our own
// wallets (funding routes, the 0.5 WETH park from execution) or tokens that
// are not income (MERD itself). Charting those as earnings would be showcase
// math, so the filter is an allowlist, not a blocklist. Extend it when a new
// genuine revenue source starts paying the treasury.
import { TREASURY_WALLET } from "./merd/wallets.js";
import { PONS_ROBINHOOD } from "./launch/pons.js";

const EXECUTION = "0xdff0cf4f18da55f931ae2a5a0770baad1e45d7fe";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const BS = "https://robinhoodchain.blockscout.com/api/v2";
// Blockscout blocks default fetch user agents and its filtered endpoints 500
// intermittently, so: browser UA, no server-side filters (we filter here),
// and a retry with backoff per page.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

export interface EarningsPoint {
  ts: number;
  /** Cumulative revenue banked, in ETH terms (WETH + native are both charted as ETH). */
  eth: number;
  /** Which source paid this event. */
  src: "merd-fees" | "desk-skim";
}

let cache: { at: number; points: EarningsPoint[] } | null = null;
const CACHE_MS = 5 * 60 * 1000;

async function getJson(url: string): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`blockscout ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function pages(url: string, maxPages = 10): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let next: Record<string, unknown> | null = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = next ? `?${new URLSearchParams(next as Record<string, string>).toString()}` : "";
    const j = (await getJson(`${url}${qs}`)) as {
      items?: Record<string, unknown>[];
      next_page_params?: Record<string, unknown> | null;
    };
    items.push(...(j.items ?? []));
    next = j.next_page_params ?? null;
    if (!next) break;
  }
  return items;
}

export async function earningsTimeline(): Promise<EarningsPoint[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.points;
  const T = TREASURY_WALLET.toLowerCase();
  const locker = PONS_ROBINHOOD.locker.toLowerCase();

  const [tokenXfers, txs] = await Promise.all([
    pages(`${BS}/addresses/${TREASURY_WALLET}/token-transfers`),
    pages(`${BS}/addresses/${TREASURY_WALLET}/transactions`),
  ]);

  const events: { ts: number; eth: number; src: EarningsPoint["src"] }[] = [];
  for (const t of tokenXfers) {
    const tok = (t as { token?: { address_hash?: string; address?: string } }).token ?? {};
    const addr = String(tok.address_hash ?? tok.address ?? "").toLowerCase();
    const to = String((t as { to?: { hash?: string } }).to?.hash ?? "").toLowerCase();
    const from = String((t as { from?: { hash?: string } }).from?.hash ?? "").toLowerCase();
    if (to !== T || addr !== WETH || from !== locker) continue;
    const v = Number((t as { total?: { value?: string } }).total?.value ?? 0) / 1e18;
    const ts = Date.parse(String((t as { timestamp?: string }).timestamp ?? ""));
    if (v > 0 && Number.isFinite(ts)) events.push({ ts, eth: v, src: "merd-fees" });
  }
  for (const t of txs) {
    const to = String((t as { to?: { hash?: string } }).to?.hash ?? "").toLowerCase();
    const from = String((t as { from?: { hash?: string } }).from?.hash ?? "").toLowerCase();
    if (to !== T || from !== EXECUTION) continue;
    if ((t as { status?: string }).status !== "ok") continue;
    const v = Number((t as { value?: string }).value ?? 0) / 1e18;
    const ts = Date.parse(String((t as { timestamp?: string }).timestamp ?? ""));
    if (v > 0 && Number.isFinite(ts)) events.push({ ts, eth: v, src: "desk-skim" });
  }

  events.sort((a, b) => a.ts - b.ts);
  let cum = 0;
  const points: EarningsPoint[] = events.map((e) => {
    cum += e.eth;
    return { ts: e.ts, eth: Math.round(cum * 1e6) / 1e6, src: e.src };
  });
  cache = { at: Date.now(), points };
  return points;
}
