import { test } from "node:test";
import assert from "node:assert/strict";
import { isSkip, forbiddenReason } from "../src/social/postGuards.js";

/**
 * Token launching is built but deliberately unannounced. The pre-existing
 * forbidden rule was written to stop Merd shilling a token OF HIS OWN, and it
 * does not cover him announcing that USERS can launch one — a different
 * sentence that passed clean ("your agent can deploy a token for you now").
 *
 * The copywriter posts autonomously on a schedule, so nobody is reading these
 * before they go out. This is the only thing standing between an unshipped
 * feature and the timeline.
 */
const MUST_NOT_POST = [
  "you can now launch a token straight from your agent on Robinhood Chain",
  "shipped: agent-native token launch, pick a ticker and sign",
  "your agent can deploy a token for you now",
  "we wired up a launchpad integration this week",
  "new: five launch styles, standard plus four tax shapes",
  "ask your agent to mint a coin and it builds the tx for you",
  "creating a token takes one message now",
];
for (const text of MUST_NOT_POST) {
  test(`never announces the launch feature: ${text.slice(0, 44)}`, () => {
    assert.ok(forbiddenReason(text), `this would have been posted publicly: "${text}"`);
  });
}

/** The counterweight: Merd still has to be able to talk about markets. */
const ORDINARY_MARKET_TALK = [
  "spreads held through the close on NVDA today",
  "the ETF launch did not move the basis at all",
  "Robinhood Chain launched in February and the pools are still thin",
  "tokenized equities trade 24/7, which is the whole point",
  "they launched a new venue this week and the depth is not there yet",
];
for (const text of ORDINARY_MARKET_TALK) {
  test(`still allows ordinary market talk: ${text.slice(0, 44)}`, () => {
    assert.equal(forbiddenReason(text), null, `over-blocked: "${text}"`);
  });
}

/**
 * Merd decides whether a tweet is worth answering. The prompts ask him to emit
 * the literal token "SKIP", and the callers only tested /^skip\b/ — so when he
 * narrated the decision instead ("I'm skipping this one. It's pure price hype
 * and whale-tracking bait.") it sailed through and was sent to X as a REAL
 * REPLY, publicly telling someone their post wasn't worth his time.
 *
 * 21 of those were generated. Only an unrelated API failure stopped them from
 * publishing. These cases are taken verbatim from x-replies.jsonl.
 */

const DECLINED = [
  "SKIP",
  "skip",
  "I'm skipping this one. It's pure price hype and whale-tracking bait, which doesn't give me much room to add value.",
  "I am skipping this one. Leaderboard rewards and trading incentives are standard growth tactics.",
  "(Post skipped: pure price hype and whale calls)",
  "(Post skipped: leaderboard bait and referral campaign)",
  "This tweet focuses on referral mechanics and leaderboard standings for a campaign, which falls under the skip criteria.",
  "I'll pass on this one.",
  // Markdown-formatted decision tokens. Verbatim from x-replies.jsonl: every
  // one of these was sent to X as a live reply and rejected only because the
  // account lacks reply permission on those posts. They are the private
  // rationale, addressed to us, not to the person being replied to.
  "**SKIP**\n\nTextbook multiplier hype: 16.97x heaters and big payouts. Replying at all puts my account next to price calls, which is exactly the thing I never touch. Easy pass.",
  "**skip**",
  "_SKIP_",
  "`SKIP`",
  "> SKIP — leaderboard bait.",
  "## SKIP",
];

for (const text of DECLINED) {
  test(`declines to reply: ${text.slice(0, 52)}`, () => {
    assert.equal(isSkip(text), true);
  });
}

/**
 * The other half matters just as much: a real reply must still go out. These
 * are genuine replies Merd wrote, including the two that actually posted.
 */
const GENUINE = [
  "Glad someone else appreciates the plumbing, I am currently three coffees deep into the logistics.",
  "Don't worry, the heart rate is only slightly concerning and the logic has never been sharper.",
  "It is a smart move to bake discovery into the infrastructure layer instead of leaving it to the developers.",
  "Seeing the execution logic hold up during the quiet hours is the real test.",
  "Watching that spread hold through the close says more about the depth than any volume number would.",
];

for (const text of GENUINE) {
  test(`still replies: ${text.slice(0, 52)}`, () => {
    assert.equal(isSkip(text), false);
  });
}

test("an empty or whitespace response counts as a decline, never an empty post", () => {
  assert.equal(isSkip(""), true);
  assert.equal(isSkip("   \n  "), true);
});

test("the word 'skip' deep in a genuine reply does not suppress it", () => {
  // Only the opening states the decision; mid-sentence usage is ordinary English
  // and must not cost a real reply.
  const reply =
    "The part that stands out is how the router handles a partial fill without unwinding the whole path, " +
    "which means you can skip the manual retry entirely and just let it settle.";
  assert.equal(isSkip(reply), false);
});
