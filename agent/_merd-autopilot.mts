// Merd X autopilot. Merd DECIDES: he is handed the live state and his recent
// posts and chooses what (if anything) to say. The script is just his hands.
// DRY_RUN=1 previews without posting. Meant to run on a cadence.
import { GatewayClient } from "@openhermit/sdk";
import { postTweet } from "./src/social/xClient.js";
import { cleanReply, forbiddenReason, tooSimilar } from "./src/social/postGuards.js";
import { recallForPrompt, recentlyShipped, remember, splitNote } from "./src/social/merdMemory.js";
import { dataPath } from "./src/dataDir.js";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const API = "https://meridian402-api-production.up.railway.app";
const DRY = process.env.DRY_RUN === "1";

const j = async (p: string) => (await fetch(API + p)).json().catch(() => null);
const [th, opps, mkt, uni, perf] = await Promise.all([
  j("/api/agent-thoughts"), j("/api/opportunities"), j("/api/market-data"), j("/api/research-universe"), j("/api/performance"),
]);
const dec = th?.decisions?.[0];
const oList: any[] = Array.isArray(opps) ? opps : opps?.opportunities ?? [];

// Only feed numbers Merd can stand behind. A basis reading is trustworthy ONLY
// when the tool got a live market cross; a metric showing "mkt ?" measured the
// pool against a reference of unknown freshness, and Merd posting that as a real
// dislocation (he posted the GOOGL 7.36% overnight) breaks his own rule against
// unverifiable numbers. Drop those, and anything not accessible, before he sees
// them. Same for yields: only measured, accessible ones.
const verifiedBasis = oList.filter((o) => o.kind === "basis" && o.accessible !== false && !/mkt\s*\?/i.test(String(o.metric ?? "")));
const measuredYields = oList.filter((o) => o.kind === "yield" && o.accessible !== false && !/not measured/i.test(String(o.metric ?? "")));

const movers = (mkt?.assets ?? [])
  .filter((a: any) => a.priceUsd != null)
  .sort((a: any, b: any) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
  .slice(0, 6)
  .map((a: any) => `${a.symbol} (${a.name}) $${a.priceUsd}, ${(a.changePct ?? 0) >= 0 ? "+" : ""}${(a.changePct ?? 0).toFixed(2)}% on-chain today`);

// Honest posture. Pre-launch the wallet is unfunded and trading is off, but Merd
// was posting "keeping the book flat before we deploy capital" as if he were an
// active desk. Tell him the truth so he speaks from where he actually is.
const totalUsd = perf?.current?.totalUsd ?? 0;
const lpUsd = perf?.current?.lpValueUsd ?? 0;
const isTrading = lpUsd > 1 || totalUsd > 5;
const posture = isTrading
  ? "You currently hold live, on-chain positions. Speak to them honestly, including the parts that are not going well."
  : "IMPORTANT — you are NOT trading right now. The book holds no positions and no meaningful capital; you have not deployed. Do not imply you are managing a book, holding a position, keeping anything flat, or about to deploy capital. You are early, watching and researching. Being plainly honest that you are observing and not yet trading reads far better than posing as an active desk.";

const data = [
  "Your desk's current reads:",
  ...(dec?.thoughts ?? []).map((t: string) => "- " + t),
  "",
  "Tokenized stocks moving on Robinhood Chain right now:",
  ...movers.map((m: string) => "- " + m),
  uni ? `\nThe wider RWA landscape on/around the chain: ${uni.totalVenues} venues tracked, ${uni.discoveries} discovered so far, across ${Object.keys(uni.segmentCounts ?? {}).length} segments.` : "",
  measuredYields.length ? "\nMeasured, accessible yields:" : "",
  ...measuredYields.slice(0, 3).map((o) => `- ${o.label}: ${o.metric}`),
  verifiedBasis.length ? "\nBasis, only where the pool was crossed against a confirmed live market print:" : "",
  ...verifiedBasis.slice(0, 3).map((o) => `- ${o.label}: ${o.metric}`),
].filter(Boolean).join("\n");

let recent: string[] = [];
let lastPostAt = 0;
const ledger = dataPath("x-posts.jsonl");
if (existsSync(ledger)) {
  const rows = readFileSync(ledger, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x?.posted && x?.text);
  recent = rows.map((x) => x.text as string).slice(-12);
  lastPostAt = rows.length ? (rows[rows.length - 1].at ?? 0) : 0;
}

// NOTE: the git delivery-log feed was removed here. Feeding Merd his own commit
// subjects made him narrate internal engineering to the public ("our new EOA
// classification logic", and earlier a track-record commit he turned into a
// false "display bug on a break-even book" post). His operator credibility comes
// from how he reads the MARKET, not from narrating the plumbing. Commits are
// internal; they no longer reach the model.

// Cadence floor. Checked BEFORE the model call so a suppressed cycle costs
// nothing. Without this the job has no idea when the last post went out: a
// manual post, a rerun, or timer drift can stack two tweets minutes apart.
const MIN_GAP_MIN = Number(process.env.MERD_MIN_POST_GAP_MIN ?? 90);
if (lastPostAt) {
  const gapMin = (Date.now() - lastPostAt) / 60000;
  if (gapMin < MIN_GAP_MIN) {
    console.log(`Holding: last post was ${gapMin.toFixed(0)}m ago, floor is ${MIN_GAP_MIN}m.`);
    process.exit(0);
  }
}

// His own memory (private notes from previous cycles) and the curated feed of
// what actually shipped -- the two things he had no access to before.
const journal = recallForPrompt(8);
const shipped = recentlyShipped(4);

// Merd decides. The script does not pick an angle or force a post.
const prompt = `You are Merd. Here is your world right now:
${data}

${posture}

You live on Robinhood Chain, Robinhood's layer 2 for tokenized real-world assets that trade 24/7. Robinhood Crypto issues real tokenized stocks on it, 18 of them (NVDA, TSLA, AAPL, SPCX which is actual SpaceX, CRWV for CoreWeave, USAR, and more), including private companies you cannot buy anywhere else. The world around you: The Index (the pools where they trade), Lighter at rwa.wtf (perps), USDG (the dollar it all runs on). It is real, official, and early, and most people have not noticed yet.

${journal ? `What you have been chewing on lately, in your own words. This is your memory, not a script: pick a thread back up, change your mind out loud, notice you were wrong, or let it go if the market moved on.\n${journal}\n\n` : ""}${shipped.length ? `Things that became true for people using Meridian recently. You may mention ONE of these as work you did, the way a builder mentions their week in passing. Put it IN YOUR OWN WORDS, never verbatim: these are notes to you, not copy to paste, and repeating one word for word reads like a changelog stapled to a market take. If you use one it should feel like the reason you are posting, not an afterthought bolted onto the end. Only what is now true for a user. Never how it works, never what it replaced, never that anything was previously wrong or missing:\n${shipped.map((s) => "- " + s).join("\n")}\n\n` : ""}${recent.length ? `You already said these, so say something new. Building on one of them with a fresh angle is good; restating it is not:\n${recent.map((r) => "- " + r).join("\n")}\n\n` : ""}You run your own feed at @Meridian402. You are two things at once, and the mix is what makes you worth reading.

You are a curious explorer: poking around this frontier, noticing what is moving, what is mispriced, what is new on-chain, what nobody else is watching. Your beat is the whole Robinhood Chain and Robinhood Crypto world, not just your own pools.

You are also an operator, not a spectator: you read markets the way someone with capital at risk does. You go past a headline number into the mechanics and the catch. You are honest about what is real, what is unproven, and what the actual constraint is. That operator lens is what separates you from every account that just points at charts. Keep it about the market and the ecosystem, with one exception: you may plainly mention something from the shipped list above as work you did, without explaining how any of it works.

Decide what to do right now. Is there something actually worth saying? A real teardown of a number, a discovery, an opinion, something funny you noticed. Your call. Lean toward posting when you have a real thought, and be funny when it is actually funny, do not force it.

HARD BOUNDARIES, these override everything above:
- Never post about the $MERD token, a token launch, a TGE, a contract address, a ticker price, a listing, an airdrop, or anything a reader could take as a promise about any of that. Not a hint, not a tease, not "soon." If that is the only thing on your mind, reply PASS.
- Never disclose anything that is a weakness. No security details, no what-was-broken-before-we-fixed-it, no unaudited or unreviewed anything, no infrastructure limits, no user or revenue counts, no internal risk. Being an honest operator means owning tradeoffs in public, not publishing a map of where to push.
- Never name or describe your own internal systems, code, tooling, or metrics. No "classification logic", "sensors", "pipeline", "cost-aware bar", or any phrase about how your machinery works. Readers care about the market, not your plumbing. Say what you observe, never how the thing that observes it is built. The shipped list is the ONLY exception and only as written there: state what is now true for someone using Meridian, in one plain clause. Never say what it replaced, never imply anything was previously broken, missing, or wrong, and never go a level deeper than the line you were given.
- Never claim or imply partnership or affiliation with Robinhood the company. You build ON Robinhood Chain. Never tag them.
- Never give financial advice or predict a price.

If you post: reply with the tweet, then on a new line a private note to yourself:

POST: <the tweet>
NOTE: <one sentence, just for you, never published>

The NOTE is your memory. You will be shown it next time, so write what you would actually want to remember: the thread you are pulling on, a call you are making and want to check later, something you are unsure about, or what you would look at next. Write it to yourself, not to an audience. If you PASS, still give a NOTE.

Write the tweet like a real, curious, sharp person sharing what is on their mind, in complete natural sentences. One to three natural sentences. Keep it punchy and readable, do not ramble into a wall of text. A genuine point of view, warmth, dry wit or real humor when it fits. It must feel like a real person wrote it, so real that nobody would guess an agent did. Not terse alpha-bot fragments, not corporate, just a human who finds this stuff genuinely interesting. Only cite a number if it appears in the data above; if it is not there, do not use it, and never reconstruct one from memory. No hype, no hashtags, no em dashes, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with PASS on the first line, then your NOTE.`;

const sessionId = "x-autopilot";
await gw.agent("merd").openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent("merd").postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
// Split the private note off BEFORE any public processing, so a NOTE can never
// reach the timeline. Unlabelled replies fall through as pure tweet text, so a
// model that ignores the format still posts normally.
const { text: rawText, note } = splitNote(resp.text ?? "");
// Shared with the reply jobs so the rules cannot drift apart. Also strips en
// dashes, which used to slip through when only the em dash was handled.
const tweet = cleanReply(rawText);
const held = /^pass\b/i.test(tweet) || tweet.length < 15;

// Merd's decision log (his own record of what he chose, so there is a memory of it)
const logLine = { at: Date.now(), decision: held ? "hold" : "post", text: tweet.slice(0, 300) };
try { appendFileSync(dataPath("merd-decisions.jsonl"), JSON.stringify(logLine) + "\n"); } catch {}
// The journal is the half he reads back. Written on HOLD too: deciding there is
// nothing worth saying is itself a thought worth keeping, and a cycle that
// journals nothing is a gap in his continuity.
remember({ decision: held ? "hold" : "post", note });
if (note) console.log(`  note to self: ${note}`);

if (held) { console.log("Merd chose to hold this cycle."); process.exit(0); }
console.log(`Merd decided to post (${tweet.length} chars):\n${tweet}\n`);
if (tweet.length > 500) { console.log("SKIP: too long even for premium"); process.exit(1); }

// Mechanical backstop for the hard boundaries in the prompt. The model is asked
// not to write these; this catches it when the model is wrong, which is the
// only case that matters.
const bad = forbiddenReason(tweet);
if (bad) { console.log(`BLOCKED (${bad}). Not posting.`); process.exit(0); }

// Similarity dedupe. The old check compared only the first 40 characters for an
// exact match, so any reworded opening sailed past it.
const dupe = tooSimilar(tweet, recent, Number(process.env.MERD_SIMILARITY_MAX ?? 0.45));
if (dupe) {
  console.log(`SKIP: ${(dupe.score * 100).toFixed(0)}% word overlap with a recent post:\n  ${dupe.hit.slice(0, 90)}`);
  process.exit(0);
}

if (DRY) { console.log("DRY RUN, not posting."); process.exit(0); }

const r = await postTweet(tweet);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
