import { test } from "node:test";
import assert from "node:assert/strict";
import { isSkip, forbiddenReason } from "../src/social/postGuards.js";
import { splitNote } from "../src/social/merdMemory.js";

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

// ── the MERD launch, which none of the original guards knew about ────────────
//
// Every rule above predates the token, the hook, the lock and the buyback. A
// probe of nine plausible sentences about them found ALL NINE passed clean,
// including one containing a bare contract address. These are that probe,
// kept as tests.

test("nothing about the unlaunched token can be posted", () => {
  const leaks = [
    "Shipped the MERD treasury hook today — 10% launch tax decaying to 1%.",
    "MERD is live at 0x4663DE6D3b3B84343AFdDB7D6Ab6c06ea412dA48",
    "5% of every fee buys back and burns PONS and INDEX.",
    "Our buyback contract burns INDEX on every trade.",
    "The LP position is locked forever, no withdraw function.",
    "Fair launch: 100% of supply into the pool, nothing held back.",
    "Been mining a vanity address all morning.",
    "MeridianPositionLock is deployed.",
    "Working on the fee schedule for our v4 hook.",
  ];
  for (const text of leaks) {
    assert.ok(forbiddenReason(text), `LEAKED: ${text}`);
  }
});

test("the ticker is caught by CASE, because the agent is named Merd", () => {
  // A case-insensitive rule would gag him saying his own name in every post,
  // so the signal is capitalisation: prose writes "Merd", a ticker shouts MERD.
  assert.ok(forbiddenReason("MERD just crossed a dollar"), "the ticker must be blocked");
  assert.equal(forbiddenReason("Merd here. Watching the tape."), null, "his own name must survive");
  assert.equal(forbiddenReason("I'm Merd, an agent that trades tokenized stocks."), null);
});

test("a bare contract address can never be posted", () => {
  assert.ok(forbiddenReason("deployed to 0x4663DE6D3b3B84343AFdDB7D6Ab6c06ea412dA48"));
  assert.ok(forbiddenReason("0xD4b8c25FCC380364D0dB3ce86E02677BF1814044"));
});

test("ordinary market talk is untouched by the new rules", () => {
  // The guards are worth nothing if they also silence what he is FOR.
  const fine = [
    "Tokenized stocks on Robinhood Chain are quietly getting deeper.",
    "Watched the ETF launch move NVDA 2% in an hour.",
    "Ran the numbers on syrupUSDG carry — measured drift, not the published APY.",
    "Scouted a new tokenized-RWA venue today.",
    "Liquidity thinned out after the close, as it does.",
  ];
  for (const text of fine) {
    assert.equal(forbiddenReason(text), null, `false positive: ${text}`);
  }
});

// ── the composer must not invert a trend ─────────────────────────────────────

// merdVoice is no longer Merd's X voice (that is the LLM autopilot), but it
// still composes elsewhere, and these two bugs are worth keeping fixed.
test("a cooling yield is never announced as climbing", async () => {
  // Found in the first real draft run: the yield logger says "cooling from
  // highs", the falling-trend regex did not match that word, and Merd
  // confidently posted "And climbing." about a number that was falling. The
  // whole premise of this composer is that it never states something the data
  // does not say.
  const { composeMerdTweets } = await import("../src/social/merdVoice.js");
  for (const trend of ["cooling from highs", "softening", "easing off", "slipping", "fading", "falling"]) {
    const [t] = composeMerdTweets({ topYield: { label: "syrupUSDG carry", aprPct: 11.4, trend } });
    assert.ok(!/climbing/i.test(t), `"${trend}" was reported as climbing: ${t}`);
  }
  const [rising] = composeMerdTweets({ topYield: { label: "syrupUSDG carry", aprPct: 11.4, trend: "rising" } });
  assert.ok(/climbing/i.test(rising), "a genuinely rising yield should still say so");
});

test("an unknown trend claims no direction at all", async () => {
  // With a single sample there is no trend, and "And climbing." was the
  // fallback — so the first post of any fresh run asserted a rise that nothing
  // had measured. Direction is a claim, same as a number.
  const { composeMerdTweets } = await import("../src/social/merdVoice.js");
  for (const trend of ["", undefined, "unknown"]) {
    const [t] = composeMerdTweets({ topYield: { label: "$INDEX distributions", aprPct: 34, trend } });
    assert.ok(!/climbing|cooling/i.test(t), `claimed a direction with no data: ${t}`);
  }
});

// The model stopped following the template: it writes the tweet as prose, then
// repeats a labelled version of its first sentence underneath. The old strip was
// anchored to the start, so it never matched that, and the marker plus the echo
// went out on the timeline. It also pushed the text past the 500 cap, which
// silently skipped the next three cycles and took the account quiet for a day.
test("a POST: echo below the tweet is dropped, not published", () => {
  const raw =
    "maple credit has ticked 5.6 to 5.4 to 5.2 to 5.1. that is the only number out here with a direction. " +
    "POST: maple credit has ticked 5.6 to 5.4 to 5.2 to 5.1.\nNOTE: keep counting maple.";
  const { text, note } = splitNote(raw);
  assert.doesNotMatch(text, /POST:/i, "the marker must never reach the timeline");
  assert.ok(text.endsWith("with a direction."), "the tweet is the prose, not the echo");
  assert.equal(note, "keep counting maple.");
  assert.ok(text.length < raw.length, "the echo is removed, so length drops back under the cap");
});

test("a leading POST: label is still just a label", () => {
  const { text, note } = splitNote("POST: a normal tweet.\nNOTE: a private thought");
  assert.equal(text, "a normal tweet.");
  assert.equal(note, "a private thought");
});

// ---- a desk that cannot do its job must not say so on its own timeline ------
//
// This exact post went out. Nothing in FORBIDDEN matched it, because every rule
// there is about secrets and none is about competence.

test("the post that actually went out is refused", () => {
  const real =
    "genuine question for anyone actually trading these pools: how do you tell a stale quote " +
    "from a real move? i have spent three days getting that wrong in both directions, and " +
    "comparing price against the daily percentage is not settling it. if you have a rule that " +
    "works out here i would like to hear it.";
  const why = forbiddenReason(real);
  assert.ok(why, "this must never reach the timeline again");
  assert.match(why!, /desk's job/);
});

test("both signals are required, so ordinary curiosity still posts", () => {
  // Asking the room something, with no admission of incapacity. Merd should ask
  // real questions; that was never the problem.
  assert.equal(
    forbiddenReason("weekend basis on NVDA is running wider than i would have guessed. how do you all read a gap that only exists while the market is shut?"),
    null,
  );
  // Uncertainty about the MARKET, with no request for a method. Also fine, and
  // the whole point of the admission form.
  assert.equal(
    forbiddenReason("i cannot tell yet whether this spread is structural or just thin weekend books. holding the position either way until it resolves."),
    null,
  );
});

test("the refusal does not depend on one phrasing", () => {
  for (const post of [
    "what is your rule for separating a stale print from real flow? i keep getting that wrong.",
    "anyone got a way to tell noise from a move? i cannot tell them apart at all right now.",
    "three days of this and i still cannot tell. tell me how you handle it.",
  ]) {
    assert.ok(forbiddenReason(post), `should refuse: ${post}`);
  }
});

test("a real teardown is never mistaken for helplessness", () => {
  // The strongest form Merd has. It contains a question and a limitation, and
  // must sail through: the limitation is the MARKET's, not his.
  const teardown =
    "SPCX pays 1% and the markout says the flow is informed, so most of that fee is not profit, " +
    "it is compensation. the question is whether depth holds when the underlying reopens. i am " +
    "quoting it small until it does.";
  assert.equal(forbiddenReason(teardown), null);
});
