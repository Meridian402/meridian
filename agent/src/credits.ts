// Credits: how agent usage gets paid for. 1 credit = 1 message, balances never
// expire, no subscriptions. Every balance change is an append-only event in
// credits.jsonl (mirrored to Postgres like every other ledger) and the current
// per-wallet balance is derived in memory, same doctrine as the other money
// paths: sync, local, rebuildable from the file.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.js";
import { dataPath } from "./dataDir.js";
import { recordTurn } from "./spendGuards.js";
import { merdTokenAddress } from "./deploy/tokenGate.js";
import type { SettlementAsset } from "./payments/PaymentGate.js";

const FILE = "credits.jsonl";
const PATH = dataPath(FILE);

export interface CreditEvent {
  wallet: string; // always lowercase
  kind: "grant" | "spend" | "purchase";
  credits: number; // positive integer; spend rows are positive and subtract in the fold
  reason?: string;
  tx?: string;
  at: number;
}

/**
 * Credit packs a wallet can buy, priced in USDG through the same x402 gate as
 * priced tools.
 *
 * PRICED FROM MEASURED COST, not from a round number. A message was sold at
 * $0.010 while costing us $0.0104 inside a warm conversation and $0.0242 on the
 * first message of a sitting, measured against the provider's own billing. Every
 * message was sold at a loss, and hardest on the lightest users.
 *
 * $0.025 on the base rate is the lowest round price where even the worst case
 * clears: somebody who opens the tab, asks one thing and leaves costs $0.0242,
 * so they are now a fraction above water instead of a subsidy. Anyone who
 * actually holds a conversation costs $0.011 to $0.013 and carries a real
 * margin. "A tiny bit above cost" is meant literally here.
 *
 * The volume bonus is not a giveaway, it tracks the cost curve. Bigger packs are
 * bought by people who talk in longer sittings, and a longer sitting is CHEAPER
 * per message because the cached prefix is already warm. Discounting the buyers
 * who are cheaper to serve is the one discount that pays for itself.
 *
 * If the caching gap closes, a message drops toward $0.004 and this should come
 * down with it. Pricing above cost is the rule; this particular number is only
 * today's answer to it.
 */
export const PACKS = [
  { id: "starter", usd: 5, credits: 200 },
  { id: "plus", usd: 15, credits: 650, bonusPct: 8 },
  { id: "pro", usd: 50, credits: 2300, bonusPct: 15 },
] as const;

export interface CreditPack {
  id: string;
  usd: number;
  credits: number;
  bonusPct?: number;
  /** Flat price in MERD wei, when the operator has set one. Absent means this
   *  pack cannot be bought with MERD. */
  merdWei?: bigint;
}

/**
 * The MERD price of a pack, from CREDITS_PACK_<ID>_MERD, in whole wei.
 *
 * FLAT AND OPERATOR-SET, on purpose. There is no oracle, no spot read and no
 * conversion from the USD price: quoting off a pool would let anyone push that
 * pool right before buying and take credits at a price they just invented. A
 * number the operator writes down has none of that surface. It is wei rather
 * than a decimal amount because a 1e18-scale price does not survive a float.
 *
 * Read at call time so this and merdCreditsEnabled() can never disagree.
 */
export function packMerdWei(packId: string): bigint | undefined {
  const key = `CREDITS_PACK_${packId.toUpperCase()}_MERD`;
  const raw = (process.env[key] ?? "").trim();
  if (!raw) return undefined;
  try {
    const wei = BigInt(raw);
    // A zero or negative price would mean free credits, which is never what an
    // operator meant to type. Refusing it leaves the pack USDG only.
    return wei > 0n ? wei : undefined;
  } catch {
    console.error(`[credits] ignoring ${key}: "${raw}" is not a whole number of MERD wei, so that pack stays USDG only`);
    return undefined;
  }
}

/** The catalogue with MERD pricing resolved. Same packs, same credits: paying
 *  in MERD buys the identical pack, there is no MERD bonus or discount. */
export function packs(): CreditPack[] {
  return PACKS.map((p) => {
    const merdWei = packMerdWei(p.id);
    return { ...p, ...(merdWei !== undefined ? { merdWei } : {}) };
  });
}

/** Wire form of the catalogue: merdWei as a decimal string, because JSON has no
 *  bigint and this number is far too large to survive as a float. */
export function packsForApi(): Array<Omit<CreditPack, "merdWei"> & { merdWei?: string }> {
  return packs().map(({ merdWei, ...p }) => ({ ...p, ...(merdWei !== undefined ? { merdWei: merdWei.toString() } : {}) }));
}

/**
 * MERD settles like any standard ERC-20 here, at 18 decimals. Null until MERD
 * has an address, which is also the reason this is a function: the token does
 * not exist yet, so there is nothing to describe until the operator says so.
 */
export function merdAsset(): SettlementAsset | null {
  const address = merdTokenAddress();
  return address ? { symbol: "MERD", address, decimals: 18 } : null;
}

/**
 * Can credits be bought with MERD at all?
 *
 * SHIPS DORMANT, same shape as the access gate: MERD is not deployed, so with
 * MERD_TOKEN_ADDRESS unset there is no token to receive and the option must not
 * be offered, quoted or accepted. A configured address with no pack price is
 * equally dormant: there would be nothing to charge.
 */
export function merdCreditsEnabled(): boolean {
  return merdTokenAddress() !== null && packs().some((p) => p.merdWei !== undefined);
}

/**
 * What a new wallet gets, free, before the credit system is ever mentioned.
 *
 * 50 rather than 20, because 20 is enough to try the product and not enough to
 * form a habit with it, and a habit is the thing this is buying. Everything
 * else on the platform (every /command, the whole live desk, and all three earn
 * features) is already free and unlimited, so this number only ever has to
 * cover CONVERSATION.
 *
 * It is not free to us. Measured against the provider, a message costs about
 * $0.0104 inside a warm conversation and about $0.024 on a cold start, and a
 * free allowance is spent across a few sittings, so 50 credits is roughly
 * $0.56 a signup, or $561 per thousand. That is a customer acquisition cost and
 * should be read as one.
 *
 * Two things bound it, and only one of them is real. CREDITS_FREE_MESSAGES
 * moves it without a deploy. And nothing whatsoever stops one person taking
 * this grant repeatedly from fresh wallets: wallets are free to make, we ask
 * for no proof of anything, and the only backstop is the global daily turn
 * ceiling. Raising this number raises that exposure proportionally.
 */
export const FREE_CREDITS = Number(process.env.CREDITS_FREE_MESSAGES ?? 50);

/** Escape hatch: MERIDIAN_CREDITS=off makes spending a no-op while balances
 *  still report, so the feature can ship dark or be yanked without a deploy
 *  breaking chat for anyone. */
export function creditsEnforced(): boolean {
  return (process.env.MERIDIAN_CREDITS ?? "on") !== "off";
}

/** One event applied to a running balance. Shared by the pure fold and the
 *  live in-memory updates so the two can never disagree. */
function applyEvent(balance: number, ev: CreditEvent): number {
  const n = Math.floor(ev.credits);
  if (!Number.isFinite(n) || n <= 0) return balance;
  return ev.kind === "spend" ? Math.max(0, balance - n) : balance + n;
}

/** Pure fold from event history to balance: grants + purchases minus spends,
 *  clamped at >= 0 at every step so a malformed history can never go negative. */
export function creditsFromEvents(events: CreditEvent[]): number {
  return events.reduce(applyEvent, 0);
}

// Per-wallet balances, replayed once from the file then kept current by the
// write path. A wallet PRESENT in the map at balance 0 is meaningfully
// different from one absent: presence means "has history", which is what
// decides whether the signup grant has already been given.
let balances: Map<string, number> | null = null;

function loadBalances(): Map<string, number> {
  if (balances) return balances;
  balances = new Map();
  if (existsSync(PATH)) {
    for (const line of readFileSync(PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as CreditEvent;
        if (typeof ev.wallet !== "string" || !ev.wallet) continue;
        const w = ev.wallet.toLowerCase();
        balances.set(w, applyEvent(balances.get(w) ?? 0, ev));
      } catch {}
    }
  }
  return balances;
}

function append(wallet: string, kind: CreditEvent["kind"], credits: number, extra?: { reason?: string; tx?: string }): number {
  const ev: CreditEvent = { wallet, kind, credits, ...extra, at: Date.now() };
  appendLedger(FILE, ev);
  // Every charged turn passes through here, so this is the one place the daily
  // spend ceiling can be told about a spend without a route being able to skip
  // it. The ledger stays the source of truth; this only keeps the cached fold
  // current between refolds.
  const map = loadBalances();
  const next = applyEvent(map.get(wallet) ?? 0, ev);
  map.set(wallet, next);
  return next;
}

/**
 * Current balance, granting the signup credits first if this wallet has no
 * event history at all. The grant is lazy on purpose: it covers brand-new
 * wallets AND wallets that created agents before credits existed, with one
 * mechanism and no backfill script. A wallet with ANY history never gets the
 * grant again, so spending to 0 stays 0.
 */
export function balanceOf(address: string): number {
  const w = address.toLowerCase();
  const map = loadBalances();
  if (!map.has(w)) return append(w, "grant", FREE_CREDITS, { reason: "signup" });
  return map.get(w) ?? 0;
}

/**
 * Debit n credits if the wallet can afford it. With enforcement off no spend row
 * is written: reporting a balance is fine, but charging while the switch is off
 * would bill users for messages the product said were free.
 *
 * The TURN is metered on both paths, and only once the turn is actually going to
 * happen. Metering is not billing: the daily ceilings in spendGuards bound model
 * spend, which we incur whether or not this wallet pays, so tying the meter to
 * the credits switch is what previously let MERIDIAN_CREDITS=off disarm it. A
 * wallet turned away for being broke is NOT metered, because no tokens are spent
 * on a turn that never reaches the gateway.
 */
export function trySpend(address: string, n = 1): { ok: boolean; balance: number } {
  const w = address.toLowerCase();
  if (!creditsEnforced()) {
    recordTurn(w);
    return { ok: true, balance: balanceOf(w) };
  }
  const balance = balanceOf(w);
  if (balance < n) return { ok: false, balance };
  const next = append(w, "spend", n);
  recordTurn(w);
  return { ok: true, balance: next };
}

/**
 * Give a credit back, used when a charged turn hard-fails so a user is never
 * charged for an error. No-op when enforcement is off: there was no spend to
 * undo, and refunding anyway would mint credits out of failures.
 */
export function refundCredit(address: string, n = 1, reason = "refund"): number {
  const w = address.toLowerCase();
  if (!creditsEnforced()) return balanceOf(w);
  return append(w, "grant", n, { reason });
}

/** Record a verified pack purchase. The tx hash ties the credits to the
 *  on-chain payment, so every purchase row is independently checkable. */
export function addPurchase(address: string, packId: string, credits: number, txHash?: string): number {
  const w = address.toLowerCase();
  return append(w, "purchase", credits, { reason: `pack:${packId}`, ...(txHash ? { tx: txHash } : {}) });
}
