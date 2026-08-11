// Talk-about-Merd bounties: the scout-to-earn machinery pointed at X posts.
//
// The logic is DELIBERATELY the scout system's, not a parallel one: same
// bounties.jsonl ledger, same accrue-then-operator-settles flow, same USDG
// rail, same knob-tunable caps. A post about Merd is validated the way a
// scouted venue is validated (real, novel, substantive), accrues the same way,
// and settles through the same reviewed payout run. Nothing here pays
// automatically; settlement stays an operator action, which is the review
// gate.
//
// What "validated" means for a post, every gate checkable by anyone:
//   - the tweet exists, is public, and actually mentions merd or the site
//   - it carries some substance beyond a bare link or tag
//   - it is recent, so an old back-catalog cannot be farmed
//   - one bounty per tweet, ever
//   - one X account per wallet and one wallet per X account, bound on first
//     accrual, so a sybil ring cannot fan one voice across many wallets
//   - the author is not one of our own accounts
import { appendLedger } from "../ledger.js";
import { dataPath } from "../dataDir.js";
import { existsSync, readFileSync } from "node:fs";
import { knobValue } from "../platformKnobs.js";
import { config } from "../config.js";

const LOG = "bounties.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_AGE_MS = 7 * DAY_MS;
/** Substance floor, measured on the text with links and handles stripped. */
const MIN_SUBSTANCE_CHARS = 40;
/** Our own voices, which do not get paid for talking about themselves. */
const SELF_HANDLES = new Set(["meridian402"]);

interface XRow {
  ts: number;
  kind: string;
  wallet: string;
  status: string;
  amountUsd: number;
  name?: string;
  url?: string;
  segment?: string;
  authorId?: string;
}

function readRows(): XRow[] {
  const p = dataPath(LOG);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as XRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is XRow => !!r);
}

// ── pure pieces, exported for tests ──────────────────────────────────────────

/** Tweet id + handle from an x.com/twitter.com status URL, or null. */
export function parseXPostUrl(url: string): { handle: string; id: string } | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{10,25})\b/i);
  return m ? { handle: m[1], id: m[2] } : null;
}

export interface TweetFacts {
  text: string;
  screenName: string;
  authorId: string;
  createdAtMs: number;
}

/** Every content gate in one pure function. Returns null when the post
 *  qualifies, otherwise the human-readable refusal. */
export function postRefusal(t: TweetFacts, nowMs: number): string | null {
  if (SELF_HANDLES.has(t.screenName.toLowerCase())) return "posts from Meridian's own accounts do not earn";
  if (nowMs - t.createdAtMs > MAX_POST_AGE_MS) return "that post is older than a week; bounties are for fresh posts";
  if (!/merd|meridian402/i.test(t.text)) return "the post has to actually mention merd or meridian402";
  const stripped = t.text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[@#]\w+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < MIN_SUBSTANCE_CHARS) {
    return "a bare tag or link is not a post; say something (a sentence or two of your own)";
  }
  return null;
}

/** First accrual binds wallet and X account to each other, both directions.
 *  Pure over the ledger rows so the rule is testable. */
export function bindingRefusal(rows: readonly XRow[], wallet: string, authorId: string): string | null {
  const w = wallet.toLowerCase();
  for (const r of rows) {
    if (r.kind !== "xpost" || r.status !== "accrued" || !r.authorId) continue;
    if (r.authorId === authorId && r.wallet !== w) return "that X account already earns to a different wallet";
    if (r.wallet === w && r.authorId !== authorId) return "your wallet already earns for a different X account";
  }
  return null;
}

// ── caps, same shape as scoutAllowed ─────────────────────────────────────────

export function xPostAllowed(wallet: string): { ok: boolean; reason?: string } {
  const rows = readRows();
  const cutoff = Date.now() - DAY_MS;
  const w = wallet.toLowerCase();
  const today = rows.filter((r) => r.kind === "xpost" && r.ts >= cutoff);
  const mine = today.filter((r) => r.wallet === w);
  const spent = mine.filter((r) => r.status === "attempt").length - mine.filter((r) => r.status === "voided").length;
  if (spent >= knobValue("xPostMaxPerWalletPerDay")) {
    return { ok: false, reason: `you have used today's ${knobValue("xPostMaxPerWalletPerDay")} submissions. post again tomorrow.` };
  }
  // One global daily pool across BOTH earn surfaces, so total bounty spend per
  // day is bounded no matter how the mix shifts.
  const rowsToday = rows.filter((r) => (r.kind === "xpost" || r.kind === "scout") && r.status === "accrued" && r.ts >= cutoff);
  if (rowsToday.reduce((s, r) => s + r.amountUsd, 0) >= config.scoutMaxDailyTotalUsd) {
    return { ok: false, reason: "today's global bounty pool is spent, post again tomorrow" };
  }
  return { ok: true };
}

// ── the submission itself ────────────────────────────────────────────────────

export interface XPostResult {
  ok: boolean;
  accrued?: boolean;
  bountyUsd?: number;
  balanceUsd?: number;
  message: string;
}

async function fetchTweet(id: string): Promise<TweetFacts | null> {
  try {
    const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      __typename?: string;
      text?: string;
      created_at?: string;
      user?: { screen_name?: string; id_str?: string };
    };
    if (d.__typename !== "Tweet" || !d.text || !d.user?.screen_name || !d.user.id_str) return null;
    const createdAtMs = Date.parse(d.created_at ?? "");
    if (!Number.isFinite(createdAtMs)) return null;
    return { text: d.text, screenName: d.user.screen_name, authorId: d.user.id_str, createdAtMs };
  } catch {
    return null;
  }
}

function balanceUsd(rows: XRow[], wallet: string): number {
  const w = wallet.toLowerCase();
  let bal = 0;
  for (const r of rows) {
    if (r.wallet !== w) continue;
    if ((r.kind === "scout" || r.kind === "xpost") && r.status === "accrued") bal += r.amountUsd;
    if (r.kind === "payout" && r.status === "paid") bal -= r.amountUsd;
  }
  return Math.round(bal * 100) / 100;
}

export async function submitXPost(wallet: string, url: string): Promise<XPostResult> {
  const w = wallet.toLowerCase();
  const parsed = parseXPostUrl(url ?? "");
  if (!parsed) return { ok: false, message: "that is not a link to an X post (expected x.com/yourname/status/...)" };

  const canonical = `https://x.com/${parsed.handle}/status/${parsed.id}`;
  const rows = readRows();
  // One bounty per tweet, ever, checked before the attempt row so a duplicate
  // does not burn a submission slot.
  if (rows.some((r) => r.kind === "xpost" && r.status === "accrued" && r.url?.endsWith(`/status/${parsed.id}`))) {
    return { ok: false, message: "that post already earned its bounty" };
  }

  appendLedger(LOG, { ts: Date.now(), kind: "xpost", wallet: w, status: "attempt", amountUsd: 0, url: canonical });

  const tweet = await fetchTweet(parsed.id);
  if (!tweet) {
    // Our read failed or the post is gone: void the attempt, do not bill the slot.
    appendLedger(LOG, { ts: Date.now(), kind: "xpost", wallet: w, status: "voided", amountUsd: 0, url: canonical });
    return { ok: false, message: "could not read that post right now (it may be private, deleted, or X is slow). the try was not counted." };
  }

  const refusal = postRefusal(tweet, Date.now()) ?? bindingRefusal(rows, w, tweet.authorId);
  if (refusal) {
    appendLedger(LOG, { ts: Date.now(), kind: "xpost", wallet: w, status: "invalid", amountUsd: 0, url: canonical, authorId: tweet.authorId });
    return { ok: false, message: refusal };
  }

  const bountyUsd = knobValue("xPostBountyUsd");
  appendLedger(LOG, {
    ts: Date.now(),
    kind: "xpost",
    wallet: w,
    status: "accrued",
    amountUsd: bountyUsd,
    name: `@${tweet.screenName}`,
    url: canonical,
    authorId: tweet.authorId,
  });
  const bal = balanceUsd(readRows(), w);
  return {
    ok: true,
    accrued: true,
    bountyUsd,
    balanceUsd: bal,
    message: `validated. $${bountyUsd.toFixed(2)} accrued for @${tweet.screenName} (your balance: $${bal.toFixed(2)}). payouts settle in USDG once you clear $${knobValue("scoutMinPayoutUsd").toFixed(2)}.`,
  };
}

/** Board stats for the site, same shape philosophy as the scout board. */
export function xTalkBoard(address?: string): Record<string, unknown> {
  const rows = readRows();
  const accrued = rows.filter((r) => r.kind === "xpost" && r.status === "accrued");
  const board: Record<string, unknown> = {
    bountyUsd: knobValue("xPostBountyUsd"),
    maxPerWalletPerDay: knobValue("xPostMaxPerWalletPerDay"),
    minPayoutUsd: knobValue("scoutMinPayoutUsd"),
    posts: accrued.length,
    voices: new Set(accrued.map((r) => r.authorId ?? r.wallet)).size,
    totalAccruedUsd: Math.round(accrued.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
    recent: accrued
      .slice(-12)
      .reverse()
      .map((r) => ({ ts: r.ts, name: r.name, url: r.url, amountUsd: r.amountUsd })),
  };
  if (address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
    const w = address.toLowerCase();
    const mine = accrued.filter((r) => r.wallet === w);
    const cutoff = Date.now() - DAY_MS;
    board.me = {
      posts: mine.length,
      accruedUsd: Math.round(mine.reduce((s, r) => s + r.amountUsd, 0) * 100) / 100,
      balanceUsd: balanceUsd(rows, w),
      todayCount: rows.filter((r) => r.kind === "xpost" && r.wallet === w && r.status === "attempt" && r.ts >= cutoff).length,
    };
  }
  return board;
}
