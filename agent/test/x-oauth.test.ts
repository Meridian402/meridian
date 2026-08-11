import { test } from "node:test";
import assert from "node:assert/strict";
import { pkceChallenge, consumeState, _seedState, linkRefusal, beginLink, type XLinkRow } from "../src/social/xOAuth.js";

/**
 * X ACCOUNT LINKING: the properties that make self-hosted OAuth safe to run.
 *
 * The flow exists so the earn surface can trust who authored a post without a
 * third party in the identity path. What can go wrong is well-mapped: a
 * replayed callback, a stolen state used after expiry, a second wallet
 * claiming a verified account, a challenge that silently degrades to plain.
 * Each has a test aimed at it.
 */

test("PKCE challenge matches the RFC 7636 reference vector", () => {
  // If this breaks, every code exchange fails against X's server, and worse,
  // a homegrown replacement might quietly downgrade to the plain method.
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("a state is single-use: the second redemption gets nothing", () => {
  _seedState("s1", { wallet: "0xabc", verifier: "v", at: Date.now() });
  const first = consumeState("s1");
  assert.ok(first, "first redemption succeeds");
  assert.equal(first!.wallet, "0xabc");
  assert.equal(consumeState("s1"), null, "a replayed callback must get nothing");
});

test("an expired state is dead even on first use, and stays consumed", () => {
  const old = Date.now() - 11 * 60 * 1000;
  _seedState("s2", { wallet: "0xabc", verifier: "v", at: old });
  assert.equal(consumeState("s2"), null, "expired means expired");
  _seedState("s2b", { wallet: "0xabc", verifier: "v", at: old });
  consumeState("s2b");
  assert.equal(consumeState("s2b"), null, "expiry does not make a state replayable");
});

test("an unknown state gets nothing", () => {
  assert.equal(consumeState("never-issued"), null);
});

test("the authorize URL carries S256, never plain, and a fresh state each time", () => {
  process.env.X_OAUTH_CLIENT_ID = "test-client";
  const a = beginLink("0xAAA", "https://api.example/cb");
  const b = beginLink("0xAAA", "https://api.example/cb");
  assert.match(a.url, /code_challenge_method=S256/);
  assert.doesNotMatch(a.url, /code_challenge_method=plain/);
  const state = (u: string) => new URL(u).searchParams.get("state");
  assert.notEqual(state(a.url), state(b.url), "states must never repeat");
  assert.match(a.url, /scope=tweet\.read\+users\.read|scope=tweet\.read%20users\.read/, "read-only scopes, nothing that can act");
});

// ── the sybil rule at link time ──────────────────────────────────────────────

const link = (wallet: string, xId: string): XLinkRow => ({ ts: 1, kind: "x-link", wallet, xId, handle: "h" });

test("an X account verifies to at most one wallet, ever", () => {
  const rows = [link("0xaaa", "42")];
  assert.equal(linkRefusal(rows, "0xaaa", "42"), null, "re-linking the same pair is idempotent");
  assert.match(linkRefusal(rows, "0xbbb", "42")!, /different wallet/, "a second wallet is refused");
});

test("a wallet may re-verify a new X account (people do lose accounts)", () => {
  // The tight direction is account->wallet. Wallet->account may move, because
  // the earn-side authorship check always follows the LATEST link, so an old
  // link cannot be farmed after moving.
  const rows = [link("0xaaa", "42")];
  assert.equal(linkRefusal(rows, "0xaaa", "43"), null);
});

test("the wallet comparison is case-insensitive", () => {
  const rows = [link("0xaaa", "42")];
  assert.equal(linkRefusal(rows, "0xAAA", "42"), null, "checksum casing must not fork an identity");
});
