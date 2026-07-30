// A real ceiling on what chat can spend in a day.
//
// The chat guards that existed before this file are a per-wallet rate limit and
// a global concurrency cap, and those two multiply rather than bound: N messages
// per wallet per minute times however many wallets sign up is a slope, not a
// number. This is the flat backstop underneath them. The defaults sit far above
// normal use on purpose, so a trip means something is wrong rather than that a
// real user was busy, and CHAT_MAX_TURNS_PER_DAY=0 closes chat entirely, which
// is the kill switch that does not require a deploy.
//
// Counted FROM THE LEDGER, the same doctrine as the swarm's daily budget in
// swarm/loop.ts: a process counter resets on deploy, and a crash loop would hand
// the box a fresh allowance on every restart, which is precisely the failure a
// spend ceiling exists to stop.
//
// METERED IN ITS OWN FILE, and that is the correction that matters. This first
// folded credits.jsonl spend rows, which tied the ceiling to whether the turn was
// CHARGED. With MERIDIAN_CREDITS=off no spend row is written, so the fold saw an
// empty window and both ceilings went inert: the kill switch and the escape hatch
// cancelled each other out, and the one configuration you would reach for in an
// incident was the one that removed the backstop. Model spend happens whether or
// not the user pays for it, so the meter cannot depend on the money path. Turns
// are recorded here instead, on every turn that reaches the gateway.
//
// A SEPARATE FILE rather than a new row kind in credits.jsonl, deliberately: that
// ledger's fold treats any kind other than "spend" as credits coming IN, so a
// "turn" row added there would quietly hand every caller free credits. Keeping
// the meter out of the money file makes that mistake unrepresentable.
//
// A refunded turn still counts here. The meter is model spend, not revenue: a
// turn that reached the gateway and failed cost us the same tokens as one that
// worked, and a caller who can make turns fail must not get unlimited ones.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";

/** One row per metered turn. Mirrored to Postgres like every other ledger. */
export const TURNS_FILE = "turns.jsonl";

const PATH = dataPath(TURNS_FILE);
const DAY_MS = 24 * 60 * 60 * 1000;

// The global ceiling is a runaway stop, not a budget. It exists so a bug or an
// abusive caller cannot spend the month in an afternoon, and it should sit well
// above any plausible honest day, because the failure it causes is total: every
// wallet gets a 503 until it rolls off.
//
// 5,000 was too low for that job in a way the ratio makes obvious. At 200 per
// wallet it took only TWENTY FIVE keen users to close the door on everybody
// else, which is precisely the shape of a launch day. 50,000 needs 250, while
// still stopping a runaway inside a day.
//
// What a turn costs, measured rather than assumed (Haiku 4.5 via OpenRouter,
// $1/M in, $5/M out, $0.10/M cached read): the fixed prefix is ~4,100 tokens of
// persona plus tool definitions, so a cached turn with a short reply lands near
// $0.002 and an uncached one near $0.006. 50,000 turns is therefore roughly
// $100 on a day that actually hit the ceiling, against 4 turns on a normal one
// today. Raise it further by env, but price it first.
const DEFAULT_MAX_PER_DAY = 50_000;
// Deliberately unchanged. Lowering it would buy a better ratio at the cost of
// the people who use this most, and the global ceiling is the right place to
// hold the line.
const DEFAULT_MAX_PER_WALLET_PER_DAY = 200;
const DEFAULT_CACHE_MS = 10_000;

/** The only fields of a turn row this file cares about. Declared locally rather
 *  than imported so the dependency runs one way: credits tells this module about
 *  a turn, this module never reaches back. */
interface LedgerRow {
  wallet?: unknown;
  kind?: unknown;
  at?: unknown;
}

export interface SpendWindow {
  /** Charged turns in the trailing 24h, all wallets. */
  total: number;
  /** Charged turns in the trailing 24h, per lowercased wallet. */
  byWallet: Map<string, number>;
}

/**
 * Pure fold: how many charged turns each wallet has taken since `since`.
 * Spend rows only, since grants and purchases are money coming in, not model
 * tokens going out. Rows with a missing or malformed timestamp are ignored:
 * a row we cannot place in time cannot be placed in the window either.
 */
export function foldSpend(rows: LedgerRow[], since: number): SpendWindow {
  const byWallet = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    // "turn" is what this file writes. "spend" is still counted so the window
    // does not go blind on the deploy that introduces turns.jsonl, when the only
    // rows inside it are the ones already in the credit ledger.
    if (!row || (row.kind !== "turn" && row.kind !== "spend")) continue;
    if (typeof row.at !== "number" || !Number.isFinite(row.at) || row.at < since) continue;
    if (typeof row.wallet !== "string" || !row.wallet) continue;
    const w = row.wallet.toLowerCase();
    byWallet.set(w, (byWallet.get(w) ?? 0) + 1);
    total += 1;
  }
  return { total, byWallet };
}

function readRows(): LedgerRow[] {
  try {
    if (!existsSync(PATH)) return [];
    const rows: LedgerRow[] = [];
    for (const line of readFileSync(PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LedgerRow);
      } catch {}
    }
    return rows;
  } catch {
    return [];
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // Negative or unparseable means someone mistyped, and a mistype must not
  // silently remove the ceiling. Zero IS meaningful and is honoured: it closes
  // the door, which is the point of having the knob.
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function chatMaxTurnsPerDay(): number {
  return envInt("CHAT_MAX_TURNS_PER_DAY", DEFAULT_MAX_PER_DAY);
}

export function chatMaxTurnsPerWalletPerDay(): number {
  return envInt("CHAT_MAX_TURNS_PER_WALLET_PER_DAY", DEFAULT_MAX_PER_WALLET_PER_DAY);
}

// The folded window, refreshed at most once per CACHE_MS. This is evaluated on
// every chat request, and re-reading and re-parsing the whole credit ledger per
// request would make the guard itself the expensive thing under exactly the load
// it exists to survive. The cache cannot drift upward unnoticed because every
// spend written in this process bumps it live (see noteSpend); the periodic
// refold is what keeps it honest across restarts and other writers.
let cached: { view: SpendWindow; at: number } | null = null;

function cacheMs(): number {
  return envInt("CHAT_SPEND_CACHE_MS", DEFAULT_CACHE_MS);
}

/** The trailing-24h view, folded from the ledger and cached briefly. */
export function spendWindow(now = Date.now()): SpendWindow {
  if (cached && now - cached.at < cacheMs()) return cached.view;
  const view = foldSpend(readRows(), now - DAY_MS);
  cached = { view, at: now };
  return view;
}

/**
 * Count a spend that was just written, so the cached view stays current inside
 * its window instead of under-reporting a burst by up to CACHE_MS worth of
 * turns. Called from the single credit write path, never from a route, so a new
 * route cannot forget it. With no cache yet there is nothing to correct: the
 * first fold will read the row from the file.
 */
export function noteSpend(wallet: string): void {
  if (!cached) return;
  const w = wallet.toLowerCase();
  cached.view.total += 1;
  cached.view.byWallet.set(w, (cached.view.byWallet.get(w) ?? 0) + 1);
}

/**
 * Record one metered turn: the durable row plus the live cache bump, in one call
 * so a caller cannot do half of it. Called for EVERY turn that reaches the
 * gateway, charged or not, which is what keeps the ceiling armed while credits
 * are switched off.
 *
 * Never throws. A meter that can fail the request it is metering would turn a
 * disk hiccup into an outage, and the ceiling exists to prevent outages.
 */
export function recordTurn(wallet: string): void {
  const w = wallet.toLowerCase();
  try {
    appendLedger(TURNS_FILE, { wallet: w, kind: "turn", at: Date.now() });
  } catch {
    // The cache bump below still bounds this process. A dropped row only means
    // the window under-counts after a restart, which is the safe direction.
  }
  noteSpend(w);
}

/** Drop the cached fold. For tests, and for anything that rewrites the ledger. */
export function resetSpendWindow(): void {
  cached = null;
}

export interface CeilingBreach {
  status: number;
  code: string;
  error: string;
}

/**
 * Pure ceiling check against an already-folded window. The global ceiling is a
 * 503 because the service, not the caller, is the thing that is unavailable;
 * the per-wallet one is a 429 because that caller really has had their share.
 * Both trip when the count has REACHED the max, so a max of N allows exactly N
 * charged turns in the window and refuses the N+1th.
 */
export function ceilingBreach(
  view: SpendWindow,
  wallet: string,
  limits: { globalMax: number; walletMax: number },
): CeilingBreach | null {
  if (view.total >= limits.globalMax) {
    return {
      status: 503,
      code: "chat_daily_cap",
      error: "meridian has hit its daily limit on agent conversations. chat is paused until it resets, nothing you did caused this.",
    };
  }
  const mine = view.byWallet.get(wallet.toLowerCase()) ?? 0;
  if (mine >= limits.walletMax) {
    return {
      status: 429,
      code: "wallet_daily_cap",
      error: `you've used ${limits.walletMax} agent messages in the last 24 hours, which is today's limit for one wallet. it frees up as those roll off.`,
    };
  }
  return null;
}

let lastGlobalLog = 0;

/**
 * Live ceiling check for a chat route. Returns the response to send, or null to
 * proceed. Cheap: one cached fold and two map reads.
 */
export function chatSpendBlocked(wallet: string): CeilingBreach | null {
  const limits = { globalMax: chatMaxTurnsPerDay(), walletMax: chatMaxTurnsPerWalletPerDay() };
  const view = spendWindow();
  const breach = ceilingBreach(view, wallet, limits);
  // Loud, but not once per request: a tripped global ceiling is exactly the
  // moment logs matter and exactly the moment they would drown.
  if (breach?.code === "chat_daily_cap") {
    const now = Date.now();
    if (now - lastGlobalLog > 60_000) {
      lastGlobalLog = now;
      console.error(`[spend] GLOBAL CHAT CEILING HIT: ${view.total} charged turns in the last 24h, max ${limits.globalMax}. Chat is refusing every wallet until this rolls off or CHAT_MAX_TURNS_PER_DAY is raised.`);
    }
  }
  return breach;
}

/** Ops snapshot: where today's chat spend sits against both ceilings. */
export function chatSpendStatus(): { turns24h: number; maxPerDay: number; maxPerWalletPerDay: number; wallets24h: number } {
  const view = spendWindow();
  return {
    turns24h: view.total,
    maxPerDay: chatMaxTurnsPerDay(),
    maxPerWalletPerDay: chatMaxTurnsPerWalletPerDay(),
    wallets24h: view.byWallet.size,
  };
}
