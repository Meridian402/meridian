// X (Twitter) posting client for @Meridian402 — Merd's account. DRAFT-FIRST by
// design: it only posts for real when X_LIVE === "true". Anything else (unset,
// "false", "draft") logs the tweet to a ledger and returns without posting, so
// the voice can be reviewed before a single autonomous tweet goes out.
//
// Auth: OAuth 1.0a user context (the 4 keys below) — required to POST as the
// account. A bearer token is app-only/read and CANNOT post.
import { TwitterApi } from "twitter-api-v2";
import { appendLedger } from "../ledger.js";
import { stripDashes } from "./postGuards.js";

export interface XConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

function readConfig(): XConfig | null {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;
  return { appKey, appSecret, accessToken, accessSecret };
}

export function xConfigured(): boolean {
  return readConfig() !== null;
}

export function xLive(): boolean {
  return process.env.X_LIVE === "true";
}

export interface PostResult {
  posted: boolean; // true only if it actually hit X
  reason?: string; // why it didn't post (draft mode, not configured, error)
  id?: string; // tweet id when posted
  text: string;
}

/**
 * Post a tweet — or, in draft mode, record what WOULD be posted. Every call is
 * logged to x-posts.jsonl either way, so there's a full audit trail.
 */
export async function postTweet(text: string, mediaPath?: string): Promise<PostResult> {
  // Last line of defence on the house no-dash rule. cleanReply strips these,
  // but a caller that hands us text directly (an operator-authored post, a
  // thread item) skips that entirely, so the only reliable place to enforce it
  // is the moment before it publishes.
  const trimmed = stripDashes(text).trim();
  // @Meridian402 is X Premium, so it can post long-form. Cap generously to allow
  // Merd's natural 2-3 sentence voice while still blocking runaway walls of text.
  const MAX = Number(process.env.X_MAX_TWEET_CHARS ?? 500);
  if (!trimmed || trimmed.length > MAX) {
    return { posted: false, reason: `bad length (${trimmed.length}/${MAX})`, text: trimmed };
  }
  const cfg = readConfig();
  if (!cfg) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "unconfigured", posted: false, text: trimmed });
    return { posted: false, reason: "X keys not configured", text: trimmed };
  }
  if (!xLive()) {
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "draft", posted: false, text: trimmed });
    return { posted: false, reason: "draft mode (set X_LIVE=true to post)", text: trimmed };
  }
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    // Media goes up through v1.1 (v2 has no upload endpoint) and is then
    // referenced by id on the v2 post. Uploading is the step that fails on a
    // bad path or an unsupported type, so it happens before the post and any
    // failure means nothing is published rather than a bare text tweet going
    // out where an image was the point.
    let mediaIds: [string] | undefined;
    if (mediaPath) {
      const id = await client.v1.uploadMedia(mediaPath);
      mediaIds = [id];
    }
    const res = await client.v2.tweet(trimmed, mediaIds ? { media: { media_ids: mediaIds } } : undefined);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: true, id: res.data.id, text: trimmed, media: mediaPath ?? null });
    return { posted: true, id: res.data.id, text: trimmed };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: false, error: message.slice(0, 200), status, detail, text: trimmed });
    console.error(`[x] post failed: ${status ?? "?"} ${detail ?? message}`.slice(0, 300));
    return { posted: false, reason: `post failed: ${(detail ?? message).slice(0, 160)}`, text: trimmed };
  }
}

/**
 * Delete a tweet this account posted. Exists for the case a guard defect ships
 * something broken (the "meridian402. xyz" link): the repair is delete and
 * repost, and both halves belong in the same audited client.
 */
export async function deleteTweet(id: string): Promise<{ deleted: boolean; reason?: string }> {
  if (!/^\d{5,25}$/.test(id)) return { deleted: false, reason: "not a tweet id" };
  const cfg = readConfig();
  if (!cfg) return { deleted: false, reason: "X keys not configured" };
  if (!xLive()) return { deleted: false, reason: "draft mode (set X_LIVE=true)" };
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    await client.v2.deleteTweet(id);
    appendLedger("x-posts.jsonl", { at: Date.now(), mode: "live", posted: false, deletedId: id });
    return { deleted: true };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    return { deleted: false, reason: `delete failed: ${(detail ?? message).slice(0, 160)} (${status ?? "?"})` };
  }
}

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string;
  createdAt: string;
  /** The tweet this one replies to, when there is one. Usually Merd's own. */
  parentText?: string;
  parentIsMine?: boolean;
  conversationId?: string;
}

/**
 * Fetch mentions newer than `sinceId` (exclusive), oldest-first. Read-only —
 * used by the engagement job to find things Merd might reply to.
 */
export async function getMentions(sinceId?: string): Promise<Mention[]> {
  const cfg = readConfig();
  if (!cfg) return [];
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    const me = await client.v2.me();
    // referenced_tweets.id pulls the parent INLINE, so thread context costs no
    // extra request. Without it every mention is judged in isolation and a
    // follow-up like "why though?" is unanswerable.
    const page = await client.v2.userMentionTimeline(me.data.id, {
      max_results: 30,
      since_id: sinceId,
      "tweet.fields": ["author_id", "created_at", "text", "conversation_id", "referenced_tweets"],
      expansions: ["author_id", "referenced_tweets.id"],
    });
    const users: Record<string, string> = {};
    for (const u of page.includes?.users ?? []) users[u.id] = u.username;
    const byId: Record<string, { text: string; authorId?: string }> = {};
    for (const t of page.includes?.tweets ?? []) byId[t.id] = { text: t.text, authorId: t.author_id };

    const list = (page.data?.data ?? []).filter((t) => t.author_id !== me.data.id);
    return list
      .map((t) => {
        const parentId = (t.referenced_tweets ?? []).find((r) => r.type === "replied_to")?.id;
        const parent = parentId ? byId[parentId] : undefined;
        return {
          id: t.id,
          text: t.text,
          authorId: t.author_id ?? "",
          authorHandle: users[t.author_id ?? ""] ?? "unknown",
          createdAt: t.created_at ?? "",
          parentText: parent?.text,
          parentIsMine: parent?.authorId === me.data.id,
          conversationId: t.conversation_id,
        };
      })
      .reverse(); // oldest-first
  } catch {
    return [];
  }
}

export interface FoundTweet extends Mention {
  followers: number;
  likes: number;
  replies: number;
  isReply: boolean;
}

/**
 * Recent-search for conversations worth joining. Read-only. Mentions alone are
 * not enough to be part of a community: a small account gets roughly one a day,
 * so without this the agent has nothing to engage WITH.
 *
 * Returns author follower counts and engagement so callers can filter before
 * spending a model call, and marks replies so a caller can prefer top-level
 * posts over jumping into the middle of someone else's thread.
 */
export async function searchTweets(query: string, maxResults = 25): Promise<FoundTweet[]> {
  const cfg = readConfig();
  if (!cfg) return [];
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    const me = await client.v2.me();
    const page = await client.v2.search(query, {
      max_results: Math.min(100, Math.max(10, maxResults)),
      "tweet.fields": ["author_id", "created_at", "text", "public_metrics", "referenced_tweets", "lang"],
      "user.fields": ["username", "public_metrics"],
      expansions: ["author_id"],
    });
    const users: Record<string, { handle: string; followers: number }> = {};
    for (const u of page.includes?.users ?? []) {
      users[u.id] = { handle: u.username, followers: u.public_metrics?.followers_count ?? 0 };
    }
    return (page.data?.data ?? [])
      .filter((t) => t.author_id !== me.data.id && (t.lang ?? "en") === "en")
      .map((t) => {
        const u = users[t.author_id ?? ""];
        return {
          id: t.id,
          text: t.text,
          authorId: t.author_id ?? "",
          authorHandle: u?.handle ?? "unknown",
          createdAt: t.created_at ?? "",
          followers: u?.followers ?? 0,
          likes: t.public_metrics?.like_count ?? 0,
          replies: t.public_metrics?.reply_count ?? 0,
          isReply: (t.referenced_tweets ?? []).some((r) => r.type === "replied_to"),
        };
      });
  } catch {
    return [];
  }
}

export interface PostMetric {
  id: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  impressions: number;
}

/**
 * Engagement on Merd's OWN recent posts, keyed by tweet id. Read-only.
 *
 * This is the performance-feedback half of self-learning: the autopilot hands
 * these numbers back to him as an OBSERVATION of what tends to land, never as a
 * target to chase. Engagement on crypto X rewards the hype the voice doc bans,
 * so the discipline stays the floor and this is only ever one input. Fails soft
 * to an empty map, in which case he composes from the market and his journal
 * exactly as before. v2 tweet-lookup caps at 100 ids; he posts far fewer than
 * that per window.
 */
export async function getMyPostMetrics(ids: string[]): Promise<Record<string, PostMetric>> {
  const cfg = readConfig();
  if (!cfg || !ids.length) return {};
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    const res = await client.v2.tweets(ids.slice(0, 100), { "tweet.fields": ["public_metrics"] });
    const out: Record<string, PostMetric> = {};
    for (const t of res.data ?? []) {
      const m = t.public_metrics as
        | { like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; impression_count?: number }
        | undefined;
      if (!m) continue;
      out[t.id] = {
        id: t.id,
        likes: m.like_count ?? 0,
        replies: m.reply_count ?? 0,
        reposts: m.retweet_count ?? 0,
        quotes: m.quote_count ?? 0,
        impressions: m.impression_count ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * X's real explanation for a failed write.
 *
 * `err.message` from twitter-api-v2 is just "Request failed with code 403",
 * which is why 165 consecutive reply failures were logged with no way to tell
 * WHICH 403 it was — a duplicate, a reply-restricted tweet, a suspended target,
 * a missing scope, and a rate cap all look identical. The API's actual payload
 * lives on `err.data` (title/detail/errors) and the HTTP status on `err.code`;
 * capture both so a repeat failure is diagnosable from the ledger alone.
 */
function describeXError(err: unknown): { message: string; status?: number; detail?: string } {
  const e = err as { message?: string; code?: number; data?: unknown; rateLimit?: { reset?: number } };
  const message = e?.message ?? String(err);
  let detail: string | undefined;
  try {
    const d = e?.data as { title?: string; detail?: string; reason?: string; errors?: Array<{ message?: string }> } | undefined;
    if (d) {
      const parts = [d.title, d.detail, d.reason, ...(d.errors ?? []).map((x) => x?.message)].filter(Boolean);
      detail = parts.length ? parts.join(" | ") : JSON.stringify(d);
    }
  } catch {
    /* non-serialisable payload — the message and status still tell us something */
  }
  return { message, status: e?.code, detail: detail?.slice(0, 400) };
}

/**
 * Reply to a specific tweet. Same draft-first gate as postTweet: only
 * actually posts when X_LIVE === "true", otherwise logs what would have
 * been said and returns without posting.
 */
/**
 * The account is not ALLOWED to reply to strangers, as opposed to this one
 * tweet refusing this one reply.
 *
 * X answers a proactive reply with "You can only reply to or quote posts where
 * you are mentioned or are the author" when the app's access tier does not
 * include it. That is an account-level fact, not a per-tweet one, so a caller
 * that treats it as a normal failure will keep composing replies (a model call
 * each) that can never post: 313 written, 0 delivered, before this existed.
 */
export function isReplyPermissionError(reason: string | undefined): boolean {
  return /only reply to or quote posts where you are mentioned/i.test(reason ?? "");
}

export async function postReply(text: string, inReplyToId: string, mediaPath?: string): Promise<PostResult> {
  // Last line of defence on the house no-dash rule. cleanReply strips these,
  // but a caller that hands us text directly (an operator-authored post, a
  // thread item) skips that entirely, so the only reliable place to enforce it
  // is the moment before it publishes.
  const trimmed = stripDashes(text).trim();
  const MAX = Number(process.env.X_MAX_TWEET_CHARS ?? 500);
  if (!trimmed || trimmed.length > MAX) {
    return { posted: false, reason: `bad length (${trimmed.length}/${MAX})`, text: trimmed };
  }
  const cfg = readConfig();
  if (!cfg) {
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "unconfigured", posted: false, inReplyToId, text: trimmed });
    return { posted: false, reason: "X keys not configured", text: trimmed };
  }
  if (!xLive()) {
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "draft", posted: false, inReplyToId, text: trimmed });
    return { posted: false, reason: "draft mode (set X_LIVE=true to post)", text: trimmed };
  }
  try {
    const client = new TwitterApi({
      appKey: cfg.appKey,
      appSecret: cfg.appSecret,
      accessToken: cfg.accessToken,
      accessSecret: cfg.accessSecret,
    });
    // Same order as postTweet: upload first so a media failure aborts the reply
    // rather than posting a bare-text link in a chain that was meant to carry a
    // picture.
    let mediaIds: [string] | undefined;
    if (mediaPath) {
      const mid = await client.v1.uploadMedia(mediaPath);
      mediaIds = [mid];
    }
    const res = await client.v2.reply(trimmed, inReplyToId, mediaIds ? { media: { media_ids: mediaIds } } : undefined);
    appendLedger("x-replies.jsonl", { at: Date.now(), mode: "live", posted: true, id: res.data.id, inReplyToId, text: trimmed, media: mediaPath ?? null });
    return { posted: true, id: res.data.id, text: trimmed };
  } catch (err) {
    const { message, status, detail } = describeXError(err);
    appendLedger("x-replies.jsonl", {
      at: Date.now(),
      mode: "live",
      posted: false,
      error: message.slice(0, 200),
      status,
      detail, // X's own words — the difference between a diagnosable failure and 165 identical mysteries
      inReplyToId,
      text: trimmed,
    });
    console.error(`[x] reply to ${inReplyToId} failed: ${status ?? "?"} ${detail ?? message}`.slice(0, 300));
    return { posted: false, reason: `reply failed: ${(detail ?? message).slice(0, 160)}`, text: trimmed };
  }
}

/** Verify the configured credentials can authenticate + read the account (no post). */
export async function verifyX(): Promise<{ ok: boolean; handle?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: "X keys not configured" };
  try {
    const client = new TwitterApi({ appKey: cfg.appKey, appSecret: cfg.appSecret, accessToken: cfg.accessToken, accessSecret: cfg.accessSecret });
    const me = await client.v2.me();
    return { ok: true, handle: me.data.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
}
