// Operator-commissioned post: engineering supplies a brief on stdin, the
// copywriter writes the post in his own voice, and it ships only if it clears
// the same guards every autonomous post clears.
//
// This exists because the alternative is an operator writing tweets and
// signing the agent's name to them. The split everywhere else in this repo
// holds here too: we say what is true and worth saying; he says it.
//
//   printf '%s' "$BRIEF" | ./node_modules/.bin/tsx _merd-commission.mts
//
// DRY_RUN=1 previews without posting.
import { readFileSync, existsSync } from "node:fs";
import { GatewayClient } from "@openhermit/sdk";
import { postTweet } from "./src/social/xClient.js";
import { cleanReply, forbiddenReason, tooSimilar } from "./src/social/postGuards.js";
import { remember, splitNote } from "./src/social/merdMemory.js";
import { dataPath } from "./src/dataDir.js";

const gw = new GatewayClient({ baseUrl: process.env.OPENHERMIT_GATEWAY_URL, token: process.env.GATEWAY_ADMIN_TOKEN });
const X_AGENT = process.env.MERD_X_AGENT_ID ?? "copywriter";
const DRY = process.env.DRY_RUN === "1";
// Optional image. Path is ours, never the model's: a post that carries a
// picture must carry the one we chose.
const MEDIA = (process.env.MEDIA_PATH ?? "").trim() || undefined;

const brief = readFileSync(0, "utf8").trim();
if (brief.length < 40) {
  console.log("no brief on stdin. pipe the brief in.");
  process.exit(1);
}

// Recent posts, so a commission cannot restate what he just said in his own
// cycle. The autonomous job dedupes; a hand-ordered post must too.
let recent: string[] = [];
const ledger = dataPath("x-posts.jsonl");
if (existsSync(ledger)) {
  recent = readFileSync(ledger, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l) as { posted?: boolean; text?: string }; } catch { return null; } })
    .filter((x): x is { posted?: boolean; text?: string } => !!x?.posted && !!x?.text)
    .map((x) => x.text as string)
    .slice(-12);
}

const prompt = `COMMISSION (one post, outside your usual cycle).

${brief}

Hard rules, same as always: only what you were told here, no numbers you were not given, no promise or prediction about a price, no sale vocabulary (presale, airdrop, whitelist, TGE, listing), no hype, no hashtags, no em dashes, never the words "fully decentralized". You may name MERD and point at its published contract, but never make a case for buying it. Do not narrate how anything is built.

Voice: you are an ecosystem token in the Robinhood Chain timeline, not an analyst outside it. Crisp and declarative for a real update or the token; looser and native for a culture beat. Lead with the point, short lines, land it and stop, no closing epigram. Under 300 characters if you can; 500 is the wall.

Reply:
POST: <the post>
NOTE: <one line to yourself>`;

// A FRESH session per commission. A fixed id meant every brief inherited the
// previous one: a brief that died mid-run (the gateway 402'd on an empty
// OpenRouter balance) stayed in the history, and the next commission opened
// with "two commissions landed in one message" and merged them into one
// unusable post. Each commission is a standalone instruction, so it gets a
// standalone session.
const sessionId = `commission-${Date.now().toString(36)}`;
await gw.agent(X_AGENT).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
const resp = await gw.agent(X_AGENT).postMessageSync(sessionId, { text: prompt }, { timeout: 90000 });
const gwError = (resp as { error?: string }).error;
if (gwError || resp.text == null) {
  console.log(`could not write this one: ${gwError ?? "gateway returned no text"}`);
  process.exit(1);
}

const { text: rawText, note } = splitNote(resp.text ?? "");
const post = cleanReply(rawText);
if (note) console.log(`  note to self: ${note}`);
console.log(`the post (${post.length} chars):\n${post}\n`);

if (post.length < 30 || post.length > 500) {
  console.log("SKIP: outside sane length, not posting");
  process.exit(1);
}
const bad = forbiddenReason(post);
if (bad) {
  console.log(`BLOCKED (${bad}). Not posting.`);
  process.exit(1);
}
const dupe = tooSimilar(post, recent, Number(process.env.MERD_SIMILARITY_MAX ?? 0.45));
if (dupe) {
  console.log(`SKIP: ${(dupe.score * 100).toFixed(0)}% word overlap with a recent post:\n  ${dupe.hit.slice(0, 90)}`);
  process.exit(1);
}
if (DRY) {
  console.log("DRY RUN, not posting.");
  process.exit(0);
}

remember(X_AGENT, { decision: "post", note: note || "commissioned post" });
const r = await postTweet(post, MEDIA);
console.log(r.posted ? `POSTED: https://x.com/Meridian402/status/${r.id}` : `not posted: ${r.reason}`);
process.exit(r.posted ? 0 : 1);
