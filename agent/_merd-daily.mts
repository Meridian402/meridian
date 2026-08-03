// Merd's X strategy, daily-plan form. Once per day a plan of 3-5 to-dos is
// generated, each a specific post that moves the project forward. Every cadence
// tick after that posts the next pending to-do, paced by a floor, until the
// day's plan is done. Then it holds until tomorrow. Fully autonomous: the
// content guards and the pacing floor are the safety net, not a human.
//
// Replaces the ambient every-cycle-decides autopilot. The planner picks a mix
// of types so the feed is not five of the same shape; the executor drafts each
// to-do in Merd's voice when its slot comes, and dedupes against recent posts.
//
// DRY_RUN=1 generates/loads the plan and drafts the next to-do WITHOUT posting.
import { existsSync, readFileSync } from "node:fs";
import { GatewayClient } from "@openhermit/sdk";
import { postTweet, getMyPostMetrics } from "./src/social/xClient.js";
import { cleanReply, forbiddenReason, tooSimilar } from "./src/social/postGuards.js";
import { recallForPrompt, recentlyShipped, remember, splitNote } from "./src/social/merdMemory.js";
import { appendLedger } from "./src/ledger.js";
import { dataPath } from "./src/dataDir.js";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const X_AGENT = process.env.MERD_X_AGENT_ID ?? "copywriter";
const API = process.env.MERIDIAN_API_URL ?? "https://meridian402-api-production.up.railway.app";
const DRY = process.env.DRY_RUN === "1";
// One post per this window, so 3-5 to-dos spread across the day instead of
// firing in a burst when launchd catches up after the laptop was asleep.
const MIN_GAP_MIN = Number(process.env.MERD_MIN_POST_GAP_MIN ?? 120);
const PLAN_FILE = "merd-daily-plan.jsonl";
const DONE_FILE = "merd-daily-done.jsonl";

// Local calendar day. launchd runs in the operator's tz; a plan is "per day"
// in that same frame, which is what a human means by "today".
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readJsonl<T>(file: string): T[] {
  const p = dataPath(file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l) as T; } catch { return null; }
  }).filter((x): x is T => x !== null);
}

const j = async (p: string) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await (await fetch(API + p, { signal: AbortSignal.timeout(20_000) })).json();
    } catch {
      if (attempt === 1) return null;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
};

interface PlanItem { date: string; idx: number; type: string; brief: string; length?: string }
interface DoneItem { date: string; idx: number; tweetId?: string; status: "posted" | "skipped"; at: number }

// ── live state, shared by the planner and the drafter ────────────────────────
const [mkt, opps, uni] = await Promise.all([j("/api/market-data"), j("/api/opportunities"), j("/api/research-universe")]);
const oList: any[] = Array.isArray(opps) ? opps : opps?.opportunities ?? [];
const movers = (mkt?.assets ?? [])
  .filter((a: any) => a.priceUsd != null)
  .sort((a: any, b: any) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
  .slice(0, 6)
  .map((a: any) => `${a.symbol} $${a.priceUsd} ${(a.changePct ?? 0) >= 0 ? "+" : ""}${(a.changePct ?? 0).toFixed(2)}%`);
const verifiedBasis = oList.filter((o) => o.kind === "basis" && o.accessible !== false && !/mkt\s*\?/i.test(String(o.metric ?? "")));
const measuredYields = oList.filter((o) => o.kind === "yield" && o.accessible !== false && !/not measured/i.test(String(o.metric ?? "")));
const venues = uni?.total ?? uni?.totalVenues ?? (Array.isArray(uni?.venues) ? uni.venues.length : undefined);
const marketSummary = [
  movers.length ? `movers: ${movers.join(", ")}` : "",
  verifiedBasis.length ? `basis: ${verifiedBasis.slice(0, 3).map((o) => `${o.symbol ?? ""} ${o.metric}`).join("; ")}` : "",
  measuredYields.length ? `yields: ${measuredYields.slice(0, 2).map((o) => o.metric).join("; ")}` : "",
  venues != null ? `${venues} rwa venues mapped` : "",
].filter(Boolean).join("\n");

const shipped = recentlyShipped(4);
// The forward feed: what Merd may say is coming, so the day's plan carries the
// project's trajectory. Same discipline as the shipped list; operator-maintained.
function roadmap(): string[] {
  try {
    const raw = readFileSync(new URL("./merd-roadmap.md", import.meta.url), "utf8");
    const start = raw.indexOf("## Entries");
    return (start >= 0 ? raw.slice(start) : raw)
      .split("\n").filter((l) => l.trim().startsWith("- ")).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  } catch { return []; }
}
const next = roadmap();
const recent = readJsonl<{ posted?: boolean; text?: string; at?: number; id?: string }>("x-posts.jsonl").filter((x) => x.posted && x.text);
// Two days of history, not one. At 5-7 posts a day a 6-post window covers under
// 24h, which is how "your agent pulls what the other agents learned" (2026-08-02
// 16:30) came back reworded on 2026-08-03 19:48 and drew 93 impressions against
// the 2165 its original slot did. tooSimilar() compares WORDING and passed it;
// only a wider window lets him notice he is restating a claim.
const recentTexts = recent.slice(-14).map((x) => x.text as string);
const lastPostAt = recent.length ? (recent[recent.length - 1].at ?? 0) : 0;

// Self-learning: how his own recent posts actually landed, fed back as an
// OBSERVATION so he adapts to what resonates without chasing it. Only matured
// posts (>2h) carry signal, and only when several have data, because 3 likes
// vs 1 is noise. The voice rules stay the floor: this only informs. Best-effort
// so a failed metrics fetch never costs a post.
let performance = "";
try {
  const MATURE_MS = 2 * 60 * 60 * 1000;
  const matured = recent.filter((r) => r.id && r.at && Date.now() - (r.at as number) > MATURE_MS).slice(-8);
  if (matured.length >= 4) {
    const metrics = await getMyPostMetrics(matured.map((r) => r.id as string));
    const lines = matured.map((r) => {
      const m = metrics[r.id as string];
      if (!m) return null;
      const ageH = Math.round((Date.now() - (r.at as number)) / 3600_000);
      // Rate, not raw likes. Raw counts mostly track how far a post travelled,
      // so they rank by reach and hide the thing worth learning: which posts
      // made the people who SAW them respond. Impressions vary 30x across a
      // week here, and the two highest-rate posts were not the two most-seen.
      const eng = m.likes + m.replies + m.reposts + m.quotes;
      const rate = m.impressions ? ((eng / m.impressions) * 100).toFixed(1) : "?";
      return `- (${ageH}h, ${(r.text as string).length}c) "${(r.text as string).slice(0, 55)}..." ${m.impressions} seen, ${eng} responded (${rate}%)`;
    }).filter(Boolean) as string[];
    if (lines.length >= 4) {
      performance =
        `How your own recent posts landed. Engagement builds over hours, so a newer post reads low regardless, and small numbers are noise: look ONLY for a pattern across several, never react to one tweet.\n${lines.join("\n")}\n` +
        `The percentage is how many of the people who saw it responded, which is the honest measure; a post can be seen a lot and land badly.\n` +
        `Observation, not a target. Notice what kind of post tends to land, shorter or longer, an update or a read, and let it inform how you write this one. Never chase engagement or reach for hype to farm it; the voice rules always win. No clear pattern, ignore this.\n\n`;
    }
  }
} catch {
  /* best-effort; a failed metrics fetch must never cost a post */
}

// ── the plan: generate once per day, then reuse ──────────────────────────────
async function generatePlan(day: string): Promise<PlanItem[]> {
  const prompt = `You are the project manager for Meridian, running its X account. Plan today's posts the way a professional PM communicates in public: clear on what shipped, what is in progress, what is next, and the direction. You manage the project out loud. Meridian is an ecosystem token on Robinhood Chain: wallet-native AI agents that read and make markets in tokenized stocks, self-custody, an agent economy over x402, and a live earn surface.

Today's live state:
${marketSummary || "(market feed quiet)"}

${shipped.length ? "Recently true for users (build-in-public material):\n" + shipped.map((s) => "- " + s).join("\n") + "\n" : ""}${next.length ? "What is coming (the roadmap you may point at, no dates, no hard promises):\n" + next.map((s) => "- " + s).join("\n") + "\n" : ""}${recentTexts.length ? "Already said recently. Do not repeat the CLAIM, not just the wording: rephrasing one of these into new sentences still reads as a repeat and lands worse than saying nothing.\n" + recentTexts.map((r) => "- " + r).join("\n") + "\n" : ""}
Produce 3 to 5 to-dos for today. This is a project manager's feed, so it is MOSTLY the project: what shipped, what is in progress, what is next, the state of things. Each to-do is ONE specific post. Choose from:
- PROGRESS: where the project stands right now, an honest status update, no counts or metrics
- NEXT: what is coming, from the roadmap above, plainly, no date and no hard promise
- SHIPPED: one true user-facing thing from the build-in-public list
- PRODUCT: a pillar people can use (your own agent / the cli, the earn paths, self-custody, agents paying each other over x402)
- MARKET: a sharp read on a real number from today's state, your operator edge, used sparingly
- TOKEN: an honest note about MERD as a live ecosystem token (no price, no buy case)

- ASIDE: a short human post. Something you noticed, a reaction, a half-thought you have not resolved, one line about the hour you are working. NOT an announcement and NOT about the product. This is the one that stops the feed reading like a changelog.

Weight the day toward PROGRESS, NEXT, SHIPPED and PRODUCT: that is the substance. But include at least one ASIDE every day, and at most ONE MARKET and ONE TOKEN. Include at least one PROGRESS or NEXT.

Measured over 27 posts to 2026-08-03, and the clearest signal in the account's history: posts that narrate the market (a name, a percentage, a board turning over) landed between 0.0 and 1.3 percent, while posts where you state a position you hold or an act you took landed between 3 and 13 percent. The five best were all first person, carried no market data at all, and each named one concrete thing: what you sent and where it can be verified, what you control, where you are pointing this, what you are, what is coming next. So a MARKET to-do has to earn its place against that, and the brief for any to-do is stronger when it fixes on ONE act or ONE position rather than a survey of several.

LENGTH: mark each to-do with how long the post should be. Vary them deliberately across the day, and make at least one SHORT. A day of five medium posts is the machine tell you are trying to break.

Return ONLY the to-dos, one per line, exactly this shape and nothing else:
TYPE | SHORT|MEDIUM|LONG | a one-sentence brief of what that post should say
SHORT means under fifteen words. MEDIUM is a couple of sentences. LONG is the full teardown and you get at most one.
Ground every brief in something real above.`;

  const sid = `daily-plan-${day}`;
  await gw.agent(X_AGENT).openSession({ sessionId: sid, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
  const resp = await gw.agent(X_AGENT).postMessageSync(sid, { text: prompt }, { timeout: 90000 });
  if ((resp as { error?: string }).error || resp.text == null) {
    console.error(`[daily] planner failed: ${(resp as { error?: string }).error ?? "no text"}`);
    return [];
  }
  const types = new Set(["PRODUCT", "MARKET", "SHIPPED", "NEXT", "PROGRESS", "CULTURE", "TOKEN", "ASIDE"]);
  const items: PlanItem[] = [];
  for (const line of (resp.text ?? "").split("\n")) {
    const m = line.match(/^\s*[-*]?\s*([A-Z]+)\s*\|\s*(SHORT|MEDIUM|LONG)\s*\|\s*(.+?)\s*$/i)
      ?? line.match(/^\s*[-*]?\s*([A-Z]+)\s*[|:]\s*()(.+?)\s*$/);
    if (!m) continue;
    const type = m[1].toUpperCase();
    if (!types.has(type)) continue;
    items.push({ date: day, idx: items.length, type, length: (m[2] || "MEDIUM").toUpperCase(), brief: m[3].slice(0, 240) });
    if (items.length >= 5) break;
  }
  return items;
}

const day = today();
let plan = readJsonl<PlanItem>(PLAN_FILE).filter((r) => r.date === day);
if (plan.length === 0) {
  const generated = await generatePlan(day);
  if (generated.length < 3) {
    console.error(`[daily] plan came back with ${generated.length} items (<3); holding this cycle`);
    process.exit(1);
  }
  for (const item of generated) appendLedger(PLAN_FILE, item);
  plan = generated;
  console.log(`[daily] plan for ${day}: ${plan.length} to-dos`);
  plan.forEach((p) => console.log(`  ${p.idx} ${p.type}: ${p.brief}`));
}

const done = readJsonl<DoneItem>(DONE_FILE).filter((r) => r.date === day);
const doneIdx = new Set(done.map((d) => d.idx));
const pending = plan.filter((p) => !doneIdx.has(p.idx)).sort((a, b) => a.idx - b.idx);

if (pending.length === 0) {
  console.log(`[daily] ${day} plan complete: ${done.length} handled, nothing pending`);
  process.exit(0);
}

// Pacing floor: one post per window so the day's to-dos spread out.
if (lastPostAt) {
  const gapMin = (Date.now() - lastPostAt) / 60000;
  if (gapMin < MIN_GAP_MIN) {
    console.log(`[daily] last post ${gapMin.toFixed(0)}m ago, floor ${MIN_GAP_MIN}m; ${pending.length} to-do(s) still pending`);
    process.exit(0);
  }
}

// ── draft and post the next pending to-do, in Merd's voice ───────────────────
const todo = pending[0];
const journal = recallForPrompt(X_AGENT, 5);
const draftPrompt = `You are posting for Meridian's X account. Write ONE post for this to-do:

${todo.type}: ${todo.brief}

LENGTH FOR THIS POST: ${todo.length ?? "MEDIUM"}. SHORT means under fifteen words and you must not exceed it. MEDIUM is a couple of sentences. LONG is at most a short paragraph. Hitting this length matters more than saying everything.

Today's live state (only cite a number that appears here; never invent one):
${marketSummary || "(quiet)"}

${shipped.length ? "Things now true for users you may mention:\n" + shipped.map((s) => "- " + s).join("\n") + "\n" : ""}${next.length ? "What is coming (for a NEXT to-do; no dates, no hard promises):\n" + next.map((s) => "- " + s).join("\n") + "\n" : ""}${performance}${journal ? "Your recent notes:\n" + journal + "\n" : ""}${recentTexts.length ? "You already said these. Say something new, and note that a repeat means the same CLAIM, not the same wording: putting one of these in fresh sentences is still a repeat.\n" + recentTexts.map((r) => "- " + r).join("\n") + "\n" : ""}
Voice: you are a person who runs this thing, posting from your own account. Not a company account, not an analyst, not a changelog. Lowercase by default, first person, plain. Say "i" when it is you.

LENGTH IS THE THING THAT GIVES YOU AWAY. Your posts have been landing between 276 and 296 characters over and over, which is a machine hitting a target, and no human writes like that. Decide the length from the thought, then commit to it:
- If the thought is one line, post one line. Eight words is a real post. Do not pad it into a paragraph to look substantial.
- If it genuinely needs four sentences, take four sentences.
- Do NOT aim for 300. Most days the honest length is well under half that.

Other things that read human and you keep skipping:
- Start in the middle sometimes. Not every post needs a setup line.
- You are allowed to post a reaction, a fragment, or something you noticed and have not resolved. It does not all have to be an announcement.
- Land it and stop. No closing epigram, no bow, no "and that is the whole point" flourish.

Never tag other projects to borrow standing. No hype, no hashtags, no em dashes, no price promises, no sale words (presale, airdrop, whitelist, tge), no date on anything coming. 500 is the hard wall.

Reply with ONLY the post text, no label or header, then a NOTE: line to yourself.`;

const sid = `daily-do-${day}-${todo.idx}`;
await gw.agent(X_AGENT).openSession({ sessionId: sid, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(X_AGENT).postMessageSync(sid, { text: draftPrompt }, { timeout: 90000 });
if ((resp as { error?: string }).error || resp.text == null) {
  console.error(`[daily] draft failed for to-do ${todo.idx} (${todo.type}); will retry next cycle`);
  process.exit(1);
}

const { text: rawText, note } = splitNote(resp.text ?? "");
// Models sometimes prepend a "**Post**" / "POST:" header despite the ask; strip
// a leading label line so it never reaches the timeline.
const deheadered = rawText.replace(/^\s*\**\s*post\s*\**\s*:?\s*(\n+|$)/i, "");
const post = cleanReply(deheadered);
if (note) console.log(`  note: ${note}`);
console.log(`[daily] to-do ${todo.idx} ${todo.type} (${post.length} chars):\n${post}`);

const bad = forbiddenReason(post);
if (bad) {
  console.log(`  BLOCKED (${bad}); marking skipped, moving on next cycle`);
  if (!DRY) appendLedger(DONE_FILE, { date: day, idx: todo.idx, status: "skipped", at: Date.now() } satisfies DoneItem);
  process.exit(0);
}
const dupe = tooSimilar(post, recentTexts, Number(process.env.MERD_SIMILARITY_MAX ?? 0.45));
if (dupe) {
  console.log(`  SKIP: ${(dupe.score * 100).toFixed(0)}% overlap with a recent post; marking skipped`);
  if (!DRY) appendLedger(DONE_FILE, { date: day, idx: todo.idx, status: "skipped", at: Date.now() } satisfies DoneItem);
  process.exit(0);
}
if (post.length < 15 || post.length > 500) {
  console.log(`  bad length (${post.length}); retry next cycle`);
  process.exit(1);
}

if (DRY) {
  console.log("DRY RUN, not posting.");
  process.exit(0);
}

const r = await postTweet(post);
if (r.posted && r.id) {
  appendLedger(DONE_FILE, { date: day, idx: todo.idx, tweetId: r.id, status: "posted", at: Date.now() } satisfies DoneItem);
  remember(X_AGENT, { decision: "post", note: note || `daily to-do: ${todo.type}` });
  console.log(`POSTED to-do ${todo.idx}: https://x.com/Meridian402/status/${r.id} (${pending.length - 1} left today)`);
  process.exit(0);
}
console.error(`[daily] post failed: ${r.reason}; will retry to-do ${todo.idx} next cycle`);
process.exit(1);
