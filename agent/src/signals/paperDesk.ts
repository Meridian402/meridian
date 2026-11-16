// THE PAPER DESK. Read-only. No capital.
//
// One surface for everything the desk is doing on paper: the four hour ledgers
// (poolWatch + chainTrack), the cross-chain ranking, and the paper replay of
// the desk's own rules. It serves GET /api/paper-desk, which is what the site's
// "Paper desk" tab draws.
//
// It also moves the hourly collection onto the server. The watchers were built
// to run on the operator's Mac under launchd, which is fine for a first look
// and wrong for a record: a laptop that sleeps leaves holes. With
// MERIDIAN_RUN_PAPER_DESK=1 the server runs the same four runs once an hour and
// writes the same ledgers to the data volume. Any other value leaves the loop
// off, so deploying this file changes nothing until that flag is set.
//
// Public by design, and honest by construction: every number here is a
// simulation or a measurement of someone else's pool, and the payload says so
// (`paper: true`, plus the notes the page prints). Nothing in it names a wallet.
import { runOnce as runPoolWatch } from "./poolWatch.js";
import { runOnce as runChainTrack, rank, CHAINS, type ChainKey, type RankRow } from "./chainTrack.js";
import { loadPools, variants, replay, passive, GAS_PER_OP_USD, DESK_FINAL, type PassiveRow } from "./paperReplay.js";

const COLLECT_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 90 * 1000;
const CACHE_MS = 5 * 60 * 1000;

export interface PaperRuleSet {
  name: string;
  note: string;
  seats: number;
  seatHours: number;
  feesUsd: number;
  inventoryUsd: number;
  costsUsd: number;
  netUsd: number;
  endBookUsd: number;
  maxDrawdownUsd: number;
  breakerFires: number;
  candidateHours: number;
  refusals: Array<{ gate: string; count: number }>;
  seatLog: Array<{ pool: string; chain: string; openedAt: string; hours: number; hoursInRange: number; feesUsd: number; inventoryUsd: number; costsUsd: number; netUsd: number; exit: string }>;
}

export interface PaperDeskSnapshot {
  generatedAt: string;
  /** Always true. Nothing on this surface is a live position. */
  paper: true;
  capitalUsd: number;
  seatUsd: number;
  record: { from: string | null; to: string | null; hours: number; pools: number; byChain: Array<{ chain: string; pools: number; hours: number }> };
  ruleSets: PaperRuleSet[];
  ranking: RankRow[];
  baseline: PassiveRow[];
  notes: string[];
  collecting: boolean;
  lastCollectedAt: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

let lastCollectedAt: number | null = null;
let cache: { at: number; value: PaperDeskSnapshot } | null = null;

/** Build the payload from whatever the ledgers hold right now. Never throws:
 *  an empty record is a valid answer and the page says "nothing recorded yet". */
export function buildPaperDesk(collecting: boolean, capitalUsd = DESK_FINAL.capitalUsd): PaperDeskSnapshot {
  const pools = loadPools();
  const results = variants(capitalUsd).map((v) => replay(pools, v));
  const first = results[0];
  const byChain = new Map<string, { pools: number; hours: number }>();
  for (const p of pools) {
    const c = byChain.get(p.chain) ?? { pools: 0, hours: 0 };
    c.pools++;
    c.hours = Math.max(c.hours, p.rows.length);
    byChain.set(p.chain, c);
  }
  return {
    generatedAt: new Date().toISOString(),
    paper: true,
    capitalUsd,
    seatUsd: DESK_FINAL.seatUsd,
    record: { from: first?.hours ? iso(first.from) : null, to: first?.hours ? iso(first.to) : null, hours: first?.hours ?? 0, pools: pools.length, byChain: [...byChain].map(([chain, v]) => ({ chain, ...v })) },
    ruleSets: results.map((r) => ({
      name: r.rules.name,
      note: r.rules.note,
      seats: r.seats.length,
      seatHours: r.seatHours,
      feesUsd: r2(r.feesUsd),
      inventoryUsd: r2(r.principalUsd),
      costsUsd: r2(r.costsUsd),
      netUsd: r2(r.netUsd),
      endBookUsd: r2(r.endBookUsd),
      maxDrawdownUsd: r2(r.maxDrawdownUsd),
      breakerFires: r.breakerFires,
      candidateHours: r.candidateHours,
      refusals: Object.entries(r.refusals).map(([gate, count]) => ({ gate: gate.replace(/^desk: cash N under seat N \+ reserve N$/, "book fully deployed"), count })).sort((a, b) => b.count - a.count),
      seatLog: r.seats.slice(0, 40).map((s) => ({ pool: s.pool, chain: s.chain, openedAt: iso(s.openedAt), hours: s.hours, hoursInRange: s.hoursInRange, feesUsd: r2(s.feesUsd), inventoryUsd: r2(s.principalUsd), costsUsd: r2(s.costsUsd), netUsd: r2(s.netUsd), exit: s.exit })),
    })),
    ranking: rank(() => {}).map((r) => ({ ...r, volumeUsd: Math.round(r.volumeUsd), lpNetUsd: Math.round(r.lpNetUsd), seatPerDayUsd: r2(r.seatPerDayUsd), movePct: r2(r.movePct), rangePct: r2(r.rangePct), seatSharePct: r2(r.seatSharePct) })),
    baseline: passive(pools).map((p) => ({ ...p, feesUsd: r2(p.feesUsd), principalUsd: r2(p.principalUsd), netUsd: r2(p.netUsd), inRangePct: Math.round(p.inRangePct), movePct: r2(p.movePct) })),
    notes: [
      "Paper only. No capital is deployed and none of these are positions. The desk's last real record closed on 2026-09-07.",
      "Entries and exits are decided by the desk's own rule functions, on one open, high, low and close per hour. The live desk checked every 150 seconds; its dump early-warning exit is not modelled.",
      "A seat is a concentrated position valued at each hour's close, so a token that trends against it shows as an inventory loss. Fees are the pool's recorded LP fees times the seat's share of in-range liquidity.",
      "Moving money between chains is treated as free and instant. It is neither.",
      `Gas per action: ${Object.entries(GAS_PER_OP_USD).map(([c, g]) => `${c} $${g}`).join(", ")}. Only the first is measured; the rest are assumptions.`,
      "A real seat changes the pool it joins: other LPs respond. A short record cannot tell a good rule from a lucky window.",
    ],
    collecting,
    lastCollectedAt: lastCollectedAt ? new Date(lastCollectedAt).toISOString() : null,
  };
}

/** Cached for five minutes: the replay is cheap, but this is a public route. */
export function paperDeskSnapshot(): PaperDeskSnapshot {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = buildPaperDesk(process.env.MERIDIAN_RUN_PAPER_DESK === "1");
  cache = { at: Date.now(), value };
  return value;
}

/** One collection pass: the desk's chain, then each other chain. A failure on
 *  one never stops the rest; every run is idempotent, so a missed pass is made
 *  up by the next. */
export async function collectOnce(log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const quiet = () => {};
  const run = async (name: string, fn: () => Promise<{ appended: number }>) => {
    try {
      const r = await fn();
      log(`[paperDesk] ${name}: appended ${r.appended} hour rows`);
    } catch (err) {
      log(`[paperDesk] ${name}: run failed (${String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, "<url>").slice(0, 140)})`);
    }
  };
  await run("robinhood", () => runPoolWatch(quiet));
  for (const chain of Object.keys(CHAINS) as ChainKey[]) await run(chain, () => runChainTrack(chain, quiet));
  lastCollectedAt = Date.now();
  cache = null;
}

/** Start the hourly collection. Read-only; holds no lock and touches no wallet. */
export function startPaperDesk(): NodeJS.Timeout {
  console.log("[boot] paper desk ON: recording the watched pools on four chains once an hour (MERIDIAN_RUN_PAPER_DESK)");
  let running = false;
  const tick = () => {
    if (running) return; // a slow pass must not stack on the next
    running = true;
    void collectOnce().finally(() => { running = false; });
  };
  setTimeout(tick, FIRST_RUN_MS).unref?.();
  const timer = setInterval(tick, COLLECT_MS);
  timer.unref?.();
  return timer;
}
