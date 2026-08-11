import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXPostUrl, postRefusal, bindingRefusal, type TweetFacts } from "../src/earn/xTalk.js";

/**
 * TALK-ABOUT-MERD BOUNTIES: the gates that keep a paid surface honest.
 *
 * Paying people to post is a reputational landmine for a brand built on
 * anti-hype: the failure mode is a timeline of bare tags and sybil rings
 * farming the pool. Every gate here exists to make the cheap version of
 * gaming it not pay:
 *
 *   substance floor  a bare tag or link earns nothing
 *   freshness        the back catalog cannot be resubmitted
 *   one per tweet    a post pays once, ever
 *   account binding  one X account per wallet, one wallet per X account,
 *                    bound at first accrual, both directions
 *   self exclusion   our own accounts do not get paid to talk about us
 */

const NOW = 1_786_600_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const tweet = (over: Partial<TweetFacts> = {}): TweetFacts => ({
  text: "been watching merd run its own market making desk on robinhood chain and posting every trade on chain. genuinely new thing.",
  screenName: "sometrader",
  authorId: "111",
  createdAtMs: NOW - 2 * HOUR,
  ...over,
});

// ── URL parsing ──────────────────────────────────────────────────────────────

test("accepts x.com and twitter.com status links, with or without query junk", () => {
  assert.deepEqual(parseXPostUrl("https://x.com/Octo402/status/2086916623898931216?s=20"), { handle: "Octo402", id: "2086916623898931216" });
  assert.deepEqual(parseXPostUrl("https://twitter.com/some_one/status/1234567890123"), { handle: "some_one", id: "1234567890123" });
  assert.deepEqual(parseXPostUrl("http://www.x.com/a/status/9999999999"), { handle: "a", id: "9999999999" });
});

test("rejects everything that is not a status link", () => {
  for (const bad of [
    "https://x.com/someone",
    "https://x.com/someone/likes",
    "https://example.com/x.com/a/status/1234567890",
    "not a url at all",
    "https://x.com//status/1234567890",
    "",
  ]) {
    assert.equal(parseXPostUrl(bad), null, `should reject: ${bad}`);
  }
});

// ── content gates ────────────────────────────────────────────────────────────

test("a genuine post about merd qualifies", () => {
  assert.equal(postRefusal(tweet(), NOW), null);
});

test("the substance floor: a bare tag, link, or handle-spray earns nothing", () => {
  assert.match(postRefusal(tweet({ text: "@Meridian402 merd" }), NOW)!, /bare tag/);
  assert.match(postRefusal(tweet({ text: "merd https://meridian402.xyz" }), NOW)!, /bare tag/);
  assert.match(postRefusal(tweet({ text: "@Meridian402 @RobinhoodApp #merd #rwa gm" }), NOW)!, /bare tag/);
});

test("links and handles do not count toward substance", () => {
  // 100+ chars of URL wrapped around a tag must not pass the floor.
  const padded = "merd https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa @a @b @c";
  assert.match(postRefusal(tweet({ text: padded }), NOW)!, /bare tag/);
});

test("the post has to mention merd at all", () => {
  assert.match(postRefusal(tweet({ text: "great day trading tokenized stocks on robinhood chain, love the future of finance" }), NOW)!, /mention merd/);
});

test("mentioning the site counts as mentioning us", () => {
  assert.equal(postRefusal(tweet({ text: "meridian402.xyz has an agent trading tokenized equities in public and showing every transaction" }), NOW), null);
});

test("freshness: the week-old back catalog cannot be farmed", () => {
  assert.equal(postRefusal(tweet({ createdAtMs: NOW - 6 * DAY }), NOW), null, "six days old is fine");
  assert.match(postRefusal(tweet({ createdAtMs: NOW - 8 * DAY }), NOW)!, /older than a week/);
});

test("our own account does not get paid to talk about itself", () => {
  assert.match(postRefusal(tweet({ screenName: "Meridian402" }), NOW)!, /own accounts/);
});

// ── the sybil binding ────────────────────────────────────────────────────────

const accrued = (wallet: string, authorId: string) =>
  ({ ts: NOW - HOUR, kind: "xpost", wallet, status: "accrued", amountUsd: 0.1, authorId }) as const;

test("first accrual binds both directions", () => {
  const rows = [accrued("0xaaa", "111")];
  assert.equal(bindingRefusal(rows, "0xaaa", "111"), null, "same pair keeps earning");
  assert.match(bindingRefusal(rows, "0xbbb", "111")!, /different wallet/, "second wallet cannot claim the same X account");
  assert.match(bindingRefusal(rows, "0xaaa", "222")!, /different X account/, "the wallet cannot fan out across X accounts");
});

test("failed and invalid rows do not bind", () => {
  const rows = [
    { ts: NOW, kind: "xpost", wallet: "0xaaa", status: "invalid", amountUsd: 0, authorId: "111" } as const,
    { ts: NOW, kind: "xpost", wallet: "0xaaa", status: "attempt", amountUsd: 0, authorId: "111" } as const,
  ];
  assert.equal(bindingRefusal(rows, "0xbbb", "111"), null, "a rejected submission must not squat the X account");
});

test("scout rows never interfere with the binding", () => {
  const rows = [{ ts: NOW, kind: "scout", wallet: "0xaaa", status: "accrued", amountUsd: 0.1 } as const];
  assert.equal(bindingRefusal(rows, "0xbbb", "999"), null);
});

test("binding is case-insensitive on the wallet", () => {
  const rows = [accrued("0xaaa", "111")];
  assert.equal(bindingRefusal(rows, "0xAAA", "111"), null, "checksum casing must not fork an identity");
});

// ── the holder gate ──────────────────────────────────────────────────────────

import { holdGateRefusal, merdPerWeth } from "../src/merd/merdSpot.js";

test("holding the floor or more passes, holding less names both numbers", () => {
  assert.equal(holdGateRefusal(100, 100), null, "exactly the floor is enough");
  assert.equal(holdGateRefusal(250.5, 100), null);
  const r = holdGateRefusal(12.34, 100)!;
  assert.match(r, /\$100/, "the requirement is named");
  assert.match(r, /\$12\.34/, "and so is what they actually hold");
});

test("a zero requirement disables the gate entirely", () => {
  assert.equal(holdGateRefusal(0, 0), null, "knob at zero means no gate, even for empty wallets");
});

test("an empty wallet is refused when the gate is on", () => {
  assert.match(holdGateRefusal(0, 100)!, /at least \$100 of MERD/);
});

test("the pool price math round-trips a known sqrtPrice", () => {
  // sqrtPriceX96 = 2^96 means price exactly 1 token1 per token0.
  assert.equal(merdPerWeth(2n ** 96n), 1);
  // Doubling sqrt quadruples price, the v3 invariant this must preserve.
  assert.equal(merdPerWeth(2n ** 97n), 4);
});
