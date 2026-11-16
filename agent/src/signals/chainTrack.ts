// THE CHAIN TRACK. Read-only. No wallet, no key, no capital. Record keeping on
// chains where nothing of ours lives yet: BNB Chain, Base and Ethereum.
//
// The operator's direction (2026-11-16): a cross-chain LP market maker that
// sits in whichever pools pay best at the moment, under the desk's own rules.
// Nothing in this file trades. It is the part that has to exist first: one
// ledger per chain, written every hour with the SAME yardstick as the desk's
// own chain (poolWatch.ts), so "this pool paid $X per $1,000 of seat" means
// the same thing on four chains and a ranking across them is honest.
//
// Three tools:
//
//   <chain> --scan   ranks a few hundred pools from a public pool index by what
//                    their LPs are paid per dollar of liquidity, after throwing
//                    out the junk. This is how a pool gets ONTO a watch list.
//
//   <chain>          the hourly watch: reads the watched pools' own Swap logs
//                    and writes one row per completed hour (fees, 30-minute
//                    markout, open/high/low/close, depth, a seat's share).
//
//   --rank           one table across every ledger, the desk's chain included:
//                    what a seat would have earned, best first.
//
// What differs from the desk's chain, and why this is its own file:
//   - v3-style pools are contracts of their own: logs are filtered by pool
//     ADDRESS, and the venues' Swap events differ (PancakeSwap adds two fields).
//   - LPs do not keep the whole fee, and how much they keep is per venue AND
//     per pool. It is read from the pool on first sight, never assumed:
//     Uniswap v3 and PancakeSwap v3 pack a protocol fee into slot0; Aerodrome
//     Slipstream pays swap fees to stakers' voters, so an outside (unstaked)
//     seat keeps its fees less the pool's unstaked fee.
//   - Volumes are an order of magnitude larger, so a run reads only the blocks
//     since its last recorded hour instead of re-reading a day.
//   - Public endpoints cap a log query: 50,000 blocks on BNB and Base, a few
//     thousand on Ethereum. The sweep halves its step on any refusal.
//
// The scan's numbers come from a third-party index and are a first look: fees
// over total value locked is what the AVERAGE dollar in a pool earned, and
// says nothing about drift. The watch is the measurement.
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dataPath } from "../dataDir.js";
import { hourRows, seatView, windowSum, watchFlags, readHourLedger, summaryLine, reportPool, reportHeader, MARKOUT_HORIZON_S, type WatchSwap, type LedgerHour, type Carry } from "./poolWatch.js";

const HOUR = 3600;
const Q96 = 2 ** 96;
const SEAT_USD = Number(process.env.CHAIN_TRACK_SEAT_USD ?? 1000);
const SEAT_WIDTH = Number(process.env.CHAIN_TRACK_SEAT_WIDTH ?? 1.25);
const FIRST_LOOKBACK_H = Number(process.env.CHAIN_TRACK_FIRST_LOOKBACK_H ?? 6);
const MAX_BACKFILL_H = Number(process.env.CHAIN_TRACK_MAX_BACKFILL_H ?? 24); // long enough to cover the Mac sleeping overnight

export type ChainKey = "bnb" | "base" | "eth";
export type Dex = "uniswap-v3" | "pancake-v3" | "slipstream";

export interface ChainCfg {
  key: ChainKey;
  name: string;
  /** The pool index's name for this network. */
  indexNetwork: string;
  rpcEnv: string;
  rpcDefault: string;
  /** Largest block span the public endpoint serves in one log query. */
  maxRange: bigint;
  wrappedNative: Address;
  nativeSymbol: string;
  /** Dollar stables a pool can be quoted in, most preferred first. */
  stables: Address[];
  /** A deep native/stable pool, read once per run for the native price. */
  refPool: { address: Address; dex: Dex };
  /** Index venue id -> what the scan assumes LPs keep, and how the watch decodes it. */
  venues: Record<string, { lpShare: number; dex?: Dex; note?: string }>;
  v2FeePct: Record<string, number>;
}

export const CHAINS: Record<ChainKey, ChainCfg> = {
  bnb: {
    key: "bnb", name: "BNB Chain", indexNetwork: "bsc", rpcEnv: "BNB_RPC_URL", rpcDefault: "https://bsc-rpc.publicnode.com", maxRange: 50_000n,
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", nativeSymbol: "BNB",
    stables: ["0x55d398326f99059fF775485246999027B3197955", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d"], // USDT, USDC, FDUSD, USD1
    refPool: { address: "0x36696169c63e42cd08ce11f5deebbcebae652050", dex: "pancake-v3" }, // USDT/WBNB 0.05%
    // Uniswap v3 is 0.83: the three Uniswap pools first watched here all read a protocol fee of one sixth.
    venues: { "pancakeswap-v3-bsc": { lpShare: 0.68, dex: "pancake-v3" }, pancakeswap_v2: { lpShare: 0.68 }, "uniswap-bsc": { lpShare: 0.83, dex: "uniswap-v3" }, "uniswap-v2-bsc": { lpShare: 1 } },
    v2FeePct: { pancakeswap_v2: 0.25, "uniswap-v2-bsc": 0.3, biswap: 0.1, apeswap_bsc: 0.2 },
  },
  base: {
    key: "base", name: "Base", indexNetwork: "base", rpcEnv: "BASE_RPC_URL", rpcDefault: "https://base-rpc.publicnode.com", maxRange: 50_000n,
    wrappedNative: "0x4200000000000000000000000000000000000006", nativeSymbol: "ETH",
    stables: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"], // USDC, USDT, USDbC, DAI
    refPool: { address: "0xd0b53D9277642d899DF5C87A3966A349A798F224", dex: "uniswap-v3" }, // WETH/USDC 0.05%
    venues: {
      "uniswap-v3-base": { lpShare: 0.83, dex: "uniswap-v3" }, "pancakeswap-v3-base": { lpShare: 0.68, dex: "pancake-v3" }, "uniswap-v2-base": { lpShare: 1 },
      "aero-slipstream-base": { lpShare: 0.9, dex: "slipstream", note: "unstaked" }, "aerodrome-slipstream": { lpShare: 0.9, dex: "slipstream", note: "unstaked" }, "aerodrome-slipstream-3": { lpShare: 0.9, dex: "slipstream", note: "unstaked" },
    },
    v2FeePct: { "uniswap-v2-base": 0.3 },
  },
  eth: {
    key: "eth", name: "Ethereum", indexNetwork: "eth", rpcEnv: "ETH_RPC_URL", rpcDefault: "https://ethereum-rpc.publicnode.com", maxRange: 2_000n,
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", nativeSymbol: "ETH",
    stables: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x6B175474E89094C44Da98b954EedeAC495271d0F"], // USDC, USDT, DAI
    refPool: { address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", dex: "uniswap-v3" }, // USDC/WETH 0.05%
    venues: { uniswap_v3: { lpShare: 0.83, dex: "uniswap-v3" }, uniswap_v2: { lpShare: 1 }, "aero-slipstream-ethereum": { lpShare: 0.9, dex: "slipstream", note: "unstaked" } },
    v2FeePct: { uniswap_v2: 0.3 },
  },
};

export interface TrackedPool {
  address: Address;
  label: string;
  dex: Dex;
  note: string;
}

/** Starter lists, 2026-11-16: on each chain the alt pairs that topped that
 *  day's scan on fee yield with real depth and real traders, on venues this
 *  file can decode, plus the chain's deep native pair as a benchmark. A
 *  starting point, not a recommendation; the scan is how a list should change.
 *  Tokens, fee and LP share are read from each pool on first sight and kept in
 *  the state file, so only the address is trusted from here. */
export const WATCHED: Record<ChainKey, TrackedPool[]> = {
  bnb: [
    { address: "0xccb5e080c38e4e7a1c6437db53bcbe016e45b9db", label: "EVAA/USDT 0.3%", dex: "uniswap-v3", note: "top fee yield on the first scan; thin pool" },
    { address: "0xcec354f641fb46b977c3a1f18b5caf3e2ede4c2c", label: "JCT/USDT 0.3%", dex: "uniswap-v3", note: "second on fee yield; thin pool" },
    { address: "0x20c0555ea3e2066673416423a17d64275fa43488", label: "AKE/USDT 0.3%", dex: "uniswap-v3", note: "third on fee yield; thin pool" },
    { address: "0xb040ea24a4ef35a3ed400b0ff26d8b6f30deecad", label: "ASTER/WBNB 0.25%", dex: "pancake-v3", note: "largest alt pool by LP fees" },
    { address: "0xaead6bd31dd66eb3a6216aaf271d0e661585b0b1", label: "ASTER/USDT 0.25%", dex: "pancake-v3", note: "same token, dollar quoted" },
    { address: "0xcc2bffaec373a6004bb6ccc8a62cdd66061f7c6a", label: "NVDAB/USDT 0.05%", dex: "pancake-v3", note: "tokenized stock, 48x daily turnover" },
    { address: "0x02eda8dbc97a0c9adfbbfab589430d76a7c7f5b6", label: "FXIon/WBNB 0.25%", dex: "pancake-v3", note: "66 days old" },
    { address: "0x36696169c63e42cd08ce11f5deebbcebae652050", label: "WBNB/USDT 0.05%", dex: "pancake-v3", note: "benchmark: the deep, competitive pair" },
  ],
  base: [
    { address: "0x2740c0faab738f6e346e545fde02aef9b1a01ee7", label: "MSFTc/USDC", dex: "slipstream", note: "tokenized stock on Aerodrome; top alt fee yield on the first scan" },
    { address: "0x66dcd42e6314b287110922ae36cb2a8bdeecc153", label: "MSTRc/USDC", dex: "slipstream", note: "tokenized stock on Aerodrome; 31x daily turnover" },
    { address: "0xd072410fa13d242e1d53721bcf7af02e3455dc96", label: "METAc/USDC", dex: "slipstream", note: "tokenized stock on Aerodrome" },
    { address: "0xf668e21993f0acd7ab00bb1cfbaed0df28a3c8ec", label: "NVDAc/USDC", dex: "slipstream", note: "tokenized stock on Aerodrome; largest of the set" },
    { address: "0xc200f21efe67c7f41b81a854c26f9cda80593065", label: "VIRTUAL/WETH 0.7%", dex: "slipstream", note: "two-year-old alt pool on Aerodrome" },
    { address: "0x9011cbf8d2900908286c9bf4d5d1644ece7b684a", label: "DRV/WETH 0.3%", dex: "uniswap-v3", note: "best Uniswap v3 alt pool on the first scan" },
    { address: "0x42609aa1e58c5dd7e5a012dc74118fff975f0eac", label: "cbBTC/USDC", dex: "slipstream", note: "a major pair with an unusually high fee yield" },
    { address: "0xd0b53D9277642d899DF5C87A3966A349A798F224", label: "WETH/USDC 0.05%", dex: "uniswap-v3", note: "benchmark: the deep, competitive pair" },
  ],
  eth: [
    { address: "0xcd4abaf39691dcbb877165b7ba6d04ec6436c22a", label: "LIT/WETH 1%", dex: "uniswap-v3", note: "top alt fee yield on the first scan" },
    { address: "0xdbf919d8a1276be708736527045b1610df27319f", label: "GDLR/USDC 0.3%", dex: "uniswap-v3", note: "89 days old" },
    { address: "0x32b16ffa899ac5fd40d798abbafb4ee59de88fb1", label: "SDLR/USDC 0.3%", dex: "uniswap-v3", note: "89 days old" },
    { address: "0x3470447f3cecffac709d3e783a307790b0208d60", label: "UNI/USDT 0.3%", dex: "uniswap-v3", note: "old, deep alt pool" },
    { address: "0xba9abfdfb7c28e232d853d85c619e4248971aa31", label: "WETH/USDT", dex: "slipstream", note: "Aerodrome on Ethereum; a major pair with a high fee yield" },
    { address: "0xd661623947ef2ead12d577b47021c167d163b0c5", label: "WETH/USDC", dex: "slipstream", note: "Aerodrome on Ethereum" },
    { address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", label: "USDC/WETH 0.05%", dex: "uniswap-v3", note: "benchmark: the deep, competitive pair" },
  ],
};

const ledgerOf = (c: ChainKey) => `${c}-track.jsonl`;
const stateOf = (c: ChainKey) => `${c}-track-state.json`;

const uniSwap = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const cakeSwap = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)");

export interface PoolMeta {
  token0: Address;
  token1: Address;
  dec0: number;
  dec1: number;
  sym0: string;
  sym1: string;
  feePips: number;
  /** Share of the swap fee that reaches an outside LP, read from the pool. */
  lpShare: number;
  quoteIs0: boolean;
  quote: "USD" | "NATIVE";
}

/** PURE: the fraction of the swap fee LPs keep, from slot0's protocol fee.
 *  Uniswap v3 packs two 4-bit denominators (0 = off, n = protocol takes 1/n).
 *  PancakeSwap v3 packs two 16-bit values in hundredths of a percent. */
export function lpShareOf(dex: "uniswap-v3" | "pancake-v3", feeProtocol: number): number {
  if (dex === "uniswap-v3") {
    const d = feeProtocol % 16;
    return d === 0 ? 1 : 1 - 1 / d;
  }
  const taken = (feeProtocol % 65536) / 10000;
  return taken >= 0 && taken < 1 ? 1 - taken : 1;
}

/** PURE: which side of a pool is its money leg. A dollar stable wins over the
 *  chain's native coin; a pool with neither cannot be priced here. */
export function quoteSide(token0: string, token1: string, cfg: Pick<ChainCfg, "stables" | "wrappedNative">): { quoteIs0: boolean; quote: "USD" | "NATIVE" } | null {
  const a = token0.toLowerCase(), b = token1.toLowerCase();
  const stables = cfg.stables.map((s) => s.toLowerCase());
  const s0 = stables.indexOf(a), s1 = stables.indexOf(b);
  if (s0 >= 0 && (s1 < 0 || s0 <= s1)) return { quoteIs0: true, quote: "USD" };
  if (s1 >= 0) return { quoteIs0: false, quote: "USD" };
  const native = cfg.wrappedNative.toLowerCase();
  if (a === native) return { quoteIs0: true, quote: "NATIVE" };
  if (b === native) return { quoteIs0: false, quote: "NATIVE" };
  return null;
}

/** PURE: one v3 Swap log as a scored sample. Dollars come from the quote leg;
 *  the price is the token in dollars, decimals and side handled here so the
 *  rest of the pipeline never sees raw units. */
export function v3SwapToWatch(
  log: { t: number; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; sender: string },
  meta: Pick<PoolMeta, "quoteIs0" | "dec0" | "dec1">,
  quoteUsd: number,
): WatchSwap | null {
  const qDec = meta.quoteIs0 ? meta.dec0 : meta.dec1;
  const tDec = meta.quoteIs0 ? meta.dec1 : meta.dec0;
  const usd = (Math.abs(Number(meta.quoteIs0 ? log.amount0 : log.amount1)) / 10 ** qDec) * quoteUsd;
  const sqrtP = Number(log.sqrtPriceX96) / Q96;
  const ratio = sqrtP ** 2; // token1 per token0, raw
  const px = (meta.quoteIs0 ? 1 / ratio : ratio) * 10 ** (tDec - qDec) * quoteUsd;
  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(usd)) return null;
  return { t: log.t, usd, px, sqrtP, L: Number(log.liquidity), sender: log.sender.toLowerCase() };
}

// ---- the scan --------------------------------------------------------------------------------

export interface ScanRow {
  address: string;
  pair: string;
  venue: string;
  venueId: string;
  /** Set when the hourly watch knows how to decode this venue. */
  dex: Dex | null;
  feePct: number | null;
  lpShare: number;
  lpShareKnown: boolean;
  venueNote: string;
  kind: "stable" | "major" | "alt";
  volumeUsd: number;
  tvlUsd: number;
  trades: number;
  traders: number;
  ageDays: number | null;
  change1h: number;
  change6h: number;
  change24h: number;
  lpFeesUsd: number | null;
  /** LP fees per day over total value locked, percent. */
  yieldPct: number | null;
}

const SCAN_STABLE = new Set(["USDT", "USDC", "FDUSD", "USD1", "DAI", "BUSD", "TUSD", "USDD", "USDE", "LISUSD", "USDX", "USDF", "FRAX", "USDBC", "USDS", "PYUSD", "GHO", "CRVUSD", "EURC", "SUSDE", "USD0", "RLUSD", "USDTB"]);
const SCAN_MAJOR = new Set(["WBNB", "BNB", "BTCB", "ETH", "WETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "CAKE", "SLISBNB", "WBETH", "ASBNB", "WBTC", "CBBTC", "CBETH", "WSTETH", "STETH", "WEETH", "RETH", "TBTC", "LBTC"]);

/** PURE: one pool from the index as a scan row. */
export function scanRow(attrs: any, venueId: string, venueName: string, nowMs: number, cfg: Pick<ChainCfg, "venues" | "v2FeePct">): ScanRow {
  const name = String(attrs.name ?? "");
  const m = name.match(/([0-9.]+)%\s*$/);
  const feePct = m ? Number(m[1]) : (cfg.v2FeePct[venueId] ?? null);
  const pair = name.replace(/\s+[0-9.]+%\s*$/, "");
  const toks = pair.split("/").map((t) => t.trim().toUpperCase());
  const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
  const volumeUsd = num(attrs.volume_usd?.h24);
  const tvlUsd = num(attrs.reserve_in_usd);
  const tx = attrs.transactions?.h24 ?? {};
  const created = Date.parse(attrs.pool_created_at ?? "");
  const venue = cfg.venues[venueId];
  const lpShare = venue?.lpShare ?? 1;
  const lpFeesUsd = feePct == null ? null : (volumeUsd * feePct * lpShare) / 100;
  const kind = toks.every((t) => SCAN_STABLE.has(t)) ? "stable" : toks.every((t) => SCAN_STABLE.has(t) || SCAN_MAJOR.has(t)) ? "major" : "alt";
  return {
    address: String(attrs.address ?? "").toLowerCase(), pair, venue: venueName, venueId, dex: venue?.dex ?? null, feePct, lpShare, lpShareKnown: venue != null, venueNote: venue?.note ?? "", kind,
    volumeUsd, tvlUsd, trades: num(tx.buys) + num(tx.sells), traders: num(tx.buyers) + num(tx.sellers),
    ageDays: Number.isFinite(created) ? (nowMs - created) / 86_400_000 : null,
    change1h: num(attrs.price_change_percentage?.h1), change6h: num(attrs.price_change_percentage?.h6), change24h: num(attrs.price_change_percentage?.h24),
    lpFeesUsd, yieldPct: lpFeesUsd != null && tvlUsd > 0 ? (lpFeesUsd / tvlUsd) * 100 : null,
  };
}

/** PURE: why a pool is not worth ranking, or null if it is. Most of the
 *  headline volume on these chains sits in pools that fail this: no liquidity
 *  behind the volume, turnover no real market has, a token that just went to
 *  zero. */
export function scanReject(r: ScanRow): string | null {
  if (r.feePct == null) return "fee unknown";
  if (r.tvlUsd < 50_000) return "under $50k of liquidity";
  if (r.volumeUsd / r.tvlUsd > 150) return "turnover above 150x (wash or broken)";
  if (r.trades < 300) return "under 300 trades";
  if (Math.abs(r.change24h) > 60) return "moved more than 60% in a day";
  return null;
}

async function indexPage(network: string, path: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}${path}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
    } catch {
      /* retry below */
    }
    await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
  }
  return { data: [], included: [] };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export async function scan(chain: ChainKey, log: (line: string) => void = (l) => console.log(l), withAddresses = false): Promise<ScanRow[]> {
  const cfg = CHAINS[chain];
  const seen = new Map<string, ScanRow>();
  const venues = new Map<string, string>();
  const paths = [...Array.from({ length: 10 }, (_, i) => `/pools?page=${i + 1}&sort=h24_volume_usd_desc&include=dex`), ...[1, 2, 3].map((p) => `/trending_pools?page=${p}&include=dex`)];
  for (const path of paths) {
    const j = await indexPage(cfg.indexNetwork, path);
    for (const x of j.included ?? []) if (x.type === "dex") venues.set(x.id, x.attributes?.name ?? x.id);
    for (const p of j.data ?? []) {
      const venueId = p.relationships?.dex?.data?.id ?? "";
      const row = scanRow(p.attributes ?? {}, venueId, venues.get(venueId) ?? venueId, Date.now(), cfg);
      if (row.address) seen.set(row.address, row);
    }
    await new Promise((r) => setTimeout(r, 2300)); // the index allows about 30 requests a minute
  }
  const rows = [...seen.values()];
  const kept = rows.filter((r) => !scanReject(r));
  const sum = (rs: ScanRow[], k: "volumeUsd" | "tvlUsd") => rs.reduce((a, r) => a + r[k], 0);
  log(`${cfg.name} scan, ${new Date().toISOString().slice(0, 16)}Z: ${rows.length} pools from the index, ${money(sum(rows, "volumeUsd"))} of 24h volume; ${rows.length - kept.length} rejected carrying ${money(sum(rows, "volumeUsd") - sum(kept, "volumeUsd"))}; ${kept.length} ranked`);
  log("yield = LP fees per day over total liquidity: what the AVERAGE dollar in the pool earned, before any price drift");
  const watched = new Set(WATCHED[chain].map((p) => p.address.toLowerCase()));
  for (const [kind, title, n] of [["alt", "ALT AND MEME PAIRS", 15], ["major", "MAJORS", 6], ["stable", "STABLE PAIRS", 4]] as const) {
    log("");
    log(title);
    log("pair                       venue                  fee%          volume     liquidity   turn   trades  traders  age(d)   24h%   LP fees/day  yield/day");
    for (const r of kept.filter((x) => x.kind === kind).sort((a, b) => (b.yieldPct ?? 0) - (a.yieldPct ?? 0)).slice(0, n)) {
      const tags = [watched.has(r.address) ? "WATCHED" : "", r.lpShareKnown ? r.venueNote : "LP share unverified", r.dex ? "" : "watch cannot decode this venue yet", withAddresses ? r.address : ""].filter(Boolean).join("; ");
      log(
        `${r.pair.slice(0, 26).padEnd(26)} ${r.venue.slice(0, 22).padEnd(22)} ${String(r.feePct).padStart(5)} ${money(r.volumeUsd).padStart(15)} ${money(r.tvlUsd).padStart(13)} ${((r.volumeUsd / r.tvlUsd).toFixed(1) + "x").padStart(6)} ${r.trades.toLocaleString().padStart(8)} ${r.traders.toLocaleString().padStart(8)} ${String(Math.round(r.ageDays ?? 0)).padStart(7)} ${r.change24h.toFixed(1).padStart(6)} ${money(r.lpFeesUsd ?? 0).padStart(13)} ${((r.yieldPct ?? 0).toFixed(2) + "%").padStart(10)}${tags ? `  ${tags}` : ""}`,
      );
    }
  }
  return kept;
}

// ---- the hourly watch ----------------------------------------------------------------------------

interface TrackState {
  lastHour: Record<string, number>;
  carry: Record<string, Carry>;
  meta: Record<string, PoolMeta>;
  nativeUsd?: number;
  lastRunAt?: number;
}

function loadState(chain: ChainKey): TrackState {
  try {
    const s = JSON.parse(readFileSync(dataPath(stateOf(chain)), "utf8")) as Partial<TrackState> & { bnbUsd?: number };
    const meta = s.meta ?? {};
    for (const m of Object.values(meta)) m.quote = (m.quote as string) === "USD" ? "USD" : "NATIVE"; // the first BNB-only version wrote "BNB"
    return { lastHour: s.lastHour ?? {}, carry: s.carry ?? {}, meta, nativeUsd: s.nativeUsd ?? s.bnbUsd, lastRunAt: s.lastRunAt };
  } catch {
    return { lastHour: {}, carry: {}, meta: {} };
  }
}

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "unstakedFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;
const slot0Abi: Record<Dex, readonly unknown[]> = {
  "uniswap-v3": [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }],
  "pancake-v3": [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint32" }, { type: "bool" }] }],
  slipstream: [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "bool" }] }],
};
const erc20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

type Reader = { readContract(a: unknown): Promise<unknown> };

async function readMeta(client: Reader, p: Pick<TrackedPool, "address" | "dex">, cfg: ChainCfg): Promise<PoolMeta | null> {
  const [token0, token1, fee, slot0] = (await Promise.all([
    client.readContract({ address: p.address, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: p.address, abi: poolAbi, functionName: "token1" }),
    client.readContract({ address: p.address, abi: poolAbi, functionName: "fee" }),
    client.readContract({ address: p.address, abi: slot0Abi[p.dex], functionName: "slot0" }),
  ])) as [Address, Address, number, readonly unknown[]];
  const side = quoteSide(token0, token1, cfg);
  if (!side) return null;
  let lpShare: number;
  if (p.dex === "slipstream") {
    // Swap fees on staked liquidity go to the gauge's voters; an outside, unstaked seat keeps its fees less this cut.
    const unstaked = Number(await client.readContract({ address: p.address, abi: poolAbi, functionName: "unstakedFee" }));
    lpShare = unstaked >= 0 && unstaked < 1_000_000 ? 1 - unstaked / 1_000_000 : 0.9;
  } else {
    lpShare = lpShareOf(p.dex, Number(slot0[5]));
  }
  const [dec0, dec1, sym0, sym1] = (await Promise.all([
    client.readContract({ address: token0, abi: erc20, functionName: "decimals" }),
    client.readContract({ address: token1, abi: erc20, functionName: "decimals" }),
    client.readContract({ address: token0, abi: erc20, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: token1, abi: erc20, functionName: "symbol" }).catch(() => "?"),
  ])) as [number, number, string, string];
  return { token0, token1, dec0: Number(dec0), dec1: Number(dec1), sym0: String(sym0), sym1: String(sym1), feePips: Number(fee), lpShare, ...side };
}

const scrub = (err: unknown, max = 90) => String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, "<url>").slice(0, max);

export async function runOnce(chain: ChainKey, log: (line: string) => void = (l) => console.log(l)): Promise<{ appended: number }> {
  const cfg = CHAINS[chain];
  const tag = `[chainTrack ${chain}]`;
  const state = loadState(chain);
  const pools = WATCHED[chain];
  const client = createPublicClient({ transport: http(process.env[cfg.rpcEnv] || cfg.rpcDefault, { retryCount: 3, retryDelay: 400 }) }) as unknown as Reader & {
    getBlockNumber(): Promise<bigint>;
    getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
    getLogs(a: unknown): Promise<Array<{ address: Address; blockNumber: bigint; args: { sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint } }>>;
  };
  const head = await client.getBlockNumber();
  const headTs = Number((await client.getBlock({ blockNumber: head })).timestamp);
  const span = 20_000n;
  const probe = await client.getBlock({ blockNumber: head - span });
  const bps = Number(span) / (headTs - Number(probe.timestamp));
  const blockTs = (bn: bigint) => headTs - Number(head - bn) / bps;
  const blockAt = (ts: number) => head - BigInt(Math.max(0, Math.round((headTs - ts) * bps)));

  for (const p of pools) {
    const key = p.address.toLowerCase();
    if (state.meta[key]) continue;
    try {
      const m = await readMeta(client, p, cfg);
      if (!m) { log(`${tag} ${p.label}: neither side is a dollar stable or ${cfg.nativeSymbol}; cannot price it, skipped`); continue; }
      state.meta[key] = m;
      log(`${tag} ${p.label}: on chain it is ${m.sym0}/${m.sym1}, fee ${m.feePips / 10000}%, an outside LP keeps ${(m.lpShare * 100).toFixed(0)}% of it, quoted in ${m.quote === "USD" ? "dollars" : cfg.nativeSymbol}`);
    } catch (err) {
      log(`${tag} ${p.label}: could not read the pool as ${p.dex} (${scrub(err)})`);
    }
  }

  // Slipstream pools set their fee dynamically, so the one read on first sight goes stale. Re-read
  // it every run and book this run's hours at the current fee: an approximation (the fee can move
  // inside an hour), but one that follows the pool instead of freezing a single reading forever.
  for (const p of pools) {
    const m = state.meta[p.address.toLowerCase()];
    if (!m || p.dex !== "slipstream") continue;
    try {
      const fee = Number(await client.readContract({ address: p.address, abi: poolAbi, functionName: "fee" }));
      if (fee > 0 && fee < 1_000_000) m.feePips = fee;
    } catch {
      /* keep the last fee that was read */
    }
  }

  // The native coin's price, from the reference pool's current price.
  let nativeUsd = NaN;
  try {
    const refKey = cfg.refPool.address.toLowerCase();
    const ref = state.meta[refKey] ?? (await readMeta(client, cfg.refPool, cfg));
    if (ref) {
      const slot0 = (await client.readContract({ address: cfg.refPool.address, abi: slot0Abi[cfg.refPool.dex], functionName: "slot0" })) as readonly unknown[];
      const ratio = (Number(slot0[0] as bigint) / Q96) ** 2;
      const nativeIs0 = ref.token0.toLowerCase() === cfg.wrappedNative.toLowerCase();
      nativeUsd = (nativeIs0 ? ratio : 1 / ratio) * 10 ** ((nativeIs0 ? ref.dec0 : ref.dec1) - (nativeIs0 ? ref.dec1 : ref.dec0));
    }
  } catch {
    /* fall back below */
  }
  if (!(nativeUsd > 50 && nativeUsd < 100_000)) nativeUsd = state.nativeUsd ?? NaN;
  if (nativeUsd > 0) state.nativeUsd = nativeUsd;

  const nowSec = Date.now() / 1000;
  const toHour = Math.floor((nowSec - MARKOUT_HORIZON_S) / HOUR) * HOUR;
  const active = pools.filter((p) => state.meta[p.address.toLowerCase()]);
  const wantFrom = (p: TrackedPool): number => {
    const last = state.lastHour[p.address.toLowerCase()];
    return last != null ? Math.max(last + HOUR, toHour - MAX_BACKFILL_H * HOUR) : toHour - FIRST_LOOKBACK_H * HOUR;
  };
  const raw = new Map<string, WatchSwap[]>();
  if (active.length) {
    let from = blockAt(Math.min(...active.map(wantFrom)));
    let step = cfg.maxRange;
    let errors = 0;
    while (from <= head) {
      const to = from + step - 1n > head ? head : from + step - 1n;
      try {
        const logs = await client.getLogs({ address: active.map((p) => p.address), events: [uniSwap, cakeSwap], fromBlock: from, toBlock: to });
        for (const l of logs) {
          const key = l.address.toLowerCase();
          const m = state.meta[key];
          if (!m) continue;
          const quoteUsd = m.quote === "USD" ? 1 : nativeUsd;
          if (!(quoteUsd > 0)) continue;
          const s = v3SwapToWatch({ t: blockTs(l.blockNumber), amount0: l.args.amount0, amount1: l.args.amount1, sqrtPriceX96: l.args.sqrtPriceX96, liquidity: l.args.liquidity, sender: l.args.sender }, m, quoteUsd);
          if (!s) continue;
          let arr = raw.get(key);
          if (!arr) raw.set(key, (arr = []));
          arr.push(s);
        }
        from = to + 1n;
        if (logs.length > 9000 && step > 500n) step /= 2n;
        else if (step < cfg.maxRange && logs.length < 4000) step = step * 2n > cfg.maxRange ? cfg.maxRange : step * 2n;
      } catch (err) {
        errors++;
        if (step > 250n) step /= 2n;
        if (errors > 40) throw err;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  let appended = 0;
  for (const p of active) {
    const key = p.address.toLowerCase();
    const m = state.meta[key];
    const quoteUsd = m.quote === "USD" ? 1 : nativeUsd;
    if (!(quoteUsd > 0)) { log(`${tag} ${p.label}: no ${cfg.nativeSymbol} price this run, skipped`); continue; }
    const last = state.lastHour[key];
    const fromHour = wantFrom(p);
    if (last != null && fromHour > last + HOUR) log(`${tag} ${p.label}: gap, ${Math.round((fromHour - last - HOUR) / HOUR)}h were beyond the ${MAX_BACKFILL_H}h backfill and are not recorded`);
    const rows = hourRows(raw.get(key) ?? [], (m.feePips / 1e6) * m.lpShare, fromHour, toHour, last != null ? (state.carry[key] ?? null) : null);
    const qDec = m.quoteIs0 ? m.dec0 : m.dec1;
    const quotePerUsd = 10 ** (qDec - 6) / quoteUsd; // seatView's money leg is in 6-decimal units
    for (const r of rows) {
      const v = seatView(SEAT_USD, SEAT_WIDTH, r.sqrtPClose, r.liquidity, m.quoteIs0, quotePerUsd);
      const row: LedgerHour = { ts: (r.hourStart + HOUR) * 1000, kind: "hour", chain, dex: p.dex, id: key, symbol: p.label, quote: m.quote === "USD" ? "USD" : cfg.nativeSymbol, feePct: m.feePips / 10000, enterable: true, hour: new Date(r.hourStart * 1000).toISOString().slice(0, 13) + ":00Z", ...r, depth2pctUsd: Math.round(v.depth2pctUsd), seatSharePct: Math.round(v.sharePct * 1e5) / 1e5, seatNetUsd: Math.round((v.sharePct / 100) * r.lpNetUsd * 100) / 100 };
      appendFileSync(dataPath(ledgerOf(chain)), JSON.stringify(row) + "\n");
      appended++;
    }
    if (rows.length) {
      const tail = rows[rows.length - 1];
      state.lastHour[key] = tail.hourStart;
      state.carry[key] = { px: tail.pxClose, sqrtP: tail.sqrtPClose, L: tail.liquidity };
    }
  }
  state.lastRunAt = Date.now();
  writeFileSync(dataPath(stateOf(chain)), JSON.stringify(state, null, 1));

  const ledger = readHourLedger(ledgerOf(chain));
  for (const p of pools) log(`${tag} ${summaryLine(p.label, ledger.get(p.address.toLowerCase()) ?? [], SEAT_USD)}`);
  return { appended };
}

export function report(chain: ChainKey, log: (line: string) => void = (l) => console.log(l)): void {
  const ledger = readHourLedger(ledgerOf(chain));
  log(`${CHAINS[chain].name} track report: ${reportHeader(SEAT_USD, SEAT_WIDTH)}`);
  for (const p of WATCHED[chain]) reportPool(`${p.label} on ${p.dex}`, p.note, ledger.get(p.address.toLowerCase()) ?? [], log);
}

// ---- the cross-chain ranking ---------------------------------------------------------------------

export interface RankRow {
  chain: string;
  label: string;
  hours: number;
  volumeUsd: number;
  lpNetUsd: number;
  /** The seat estimate over the window, scaled to a day. */
  seatPerDayUsd: number;
  movePct: number;
  rangePct: number;
  seatSharePct: number;
  depth2pctUsd: number;
  flags: string[];
}

/** PURE: one pool's ledger as a ranking row over its last `hours` hours. */
export function rankRow(chain: string, label: string, rows: readonly LedgerHour[], hours = 24): RankRow | null {
  if (!rows.length) return null;
  const w = windowSum(rows, hours);
  const tail = rows[rows.length - 1];
  return { chain, label, hours: w.hours, volumeUsd: w.volumeUsd, lpNetUsd: w.lpNetUsd, seatPerDayUsd: w.hours > 0 ? (w.seatNetUsd * 24) / w.hours : 0, movePct: w.movePct, rangePct: w.rangePct, seatSharePct: tail.seatSharePct, depth2pctUsd: tail.depth2pctUsd, flags: watchFlags(rows) };
}

/** Every recorded pool on every chain, best seat estimate first. The desk's
 *  own chain comes from poolWatch's ledger; hooked pools there are left out
 *  because an outside LP cannot enter them. */
export function rank(log: (line: string) => void = (l) => console.log(l), hours = 24): RankRow[] {
  const out: RankRow[] = [];
  for (const [id, rows] of readHourLedger("pool-watch.jsonl")) {
    if (!rows.length || rows[rows.length - 1].enterable === false) continue;
    const r = rows[rows.length - 1];
    const row = rankRow("robinhood", `${r.symbol}/${r.quote} ${r.feePct}%`, rows, hours);
    if (row) out.push(row);
    void id;
  }
  for (const chain of Object.keys(CHAINS) as ChainKey[]) {
    const ledger = readHourLedger(ledgerOf(chain));
    for (const p of WATCHED[chain]) {
      const row = rankRow(chain, p.label, ledger.get(p.address.toLowerCase()) ?? [], hours);
      if (row) out.push(row);
    }
  }
  out.sort((a, b) => b.seatPerDayUsd - a.seatPerDayUsd);
  log(`cross-chain ranking, last ${hours}h of each pool's record: ${reportHeader(SEAT_USD, SEAT_WIDTH)}`);
  log("the seat column is scaled to a day; a pool with few hours on record is a thin sample, and none of this includes the inventory left by a trending token");
  log("");
  log("chain      pool                     hours       volume      LP net   seat/day    price   range   share     depth  flags");
  for (const r of out) {
    log(
      `${r.chain.padEnd(10)} ${r.label.slice(0, 24).padEnd(24)} ${String(r.hours).padStart(5)} ${money(r.volumeUsd).padStart(12)} ${money(r.lpNetUsd).padStart(11)} ${("$" + r.seatPerDayUsd.toFixed(2)).padStart(10)} ${((r.movePct >= 0 ? "+" : "") + r.movePct.toFixed(1) + "%").padStart(8)} ${(r.rangePct.toFixed(0) + "%").padStart(7)} ${(r.seatSharePct.toFixed(2) + "%").padStart(7)} ${money(r.depth2pctUsd).padStart(9)}  ${r.flags.join("; ")}`,
    );
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const fail = (err: unknown) => {
    console.error(`[chainTrack] failed: ${scrub(err, 200)}`);
    process.exit(1);
  };
  const chain = args.find((a) => a in CHAINS) as ChainKey | undefined;
  if (args.includes("--rank")) rank();
  else if (!chain) {
    console.error(`usage: chainTrack <${Object.keys(CHAINS).join("|")}> [--scan [--addresses] | --report]   or   chainTrack --rank`);
    process.exit(2);
  } else if (args.includes("--report")) report(chain);
  else if (args.includes("--scan")) scan(chain, undefined, args.includes("--addresses")).then(() => process.exit(0)).catch(fail);
  else
    runOnce(chain)
      .then((r) => {
        console.log(`[chainTrack ${chain}] ${new Date().toISOString().slice(0, 16)}Z: appended ${r.appended} hour rows`);
        process.exit(0);
      })
      .catch(fail);
}
