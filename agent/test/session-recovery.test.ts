import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingSession } from "../src/deploy/myAgent.js";

// A user's chat thread is one long-lived session on the gateway, and this
// process only remembers which sessions IT opened. When that memory and the
// gateway disagree, every message dies on a 404 and the agent simply stops
// answering, which is what a real user hit. The recovery turns on recognising
// that specific failure, so the recogniser is pinned here: too narrow and the
// thread stays dead, too broad and we retry failures that will never succeed.

test("the gateway's missing-session errors are recognised", () => {
  for (const msg of [
    'Stream request failed (404): {"error":{"code":"not_found","message":"Session not found: chat-0xabc"}}',
    "Session not found: chat-0xabc",
    "session not found",
    "Request failed (404): session missing for agent",
  ]) {
    assert.ok(isMissingSession(new Error(msg)), msg);
  }
});

test("everything else is left alone rather than retried", () => {
  // Retrying these would double the spend on a paid turn, or hammer a provider
  // that has already said no.
  for (const msg of [
    "402 This request requires more credits, or fewer max_tokens",
    "Request failed (500): internal error",
    "Request failed (404): agent not found",
    "The operation was aborted",
    "gateway_unconfigured",
    "timed out",
  ]) {
    assert.ok(!isMissingSession(new Error(msg)), msg);
  }
});

test("a non-Error rejection is still classified, not thrown on", () => {
  assert.ok(isMissingSession("Session not found: chat-0xabc"));
  assert.ok(!isMissingSession({ weird: true }));
  assert.ok(!isMissingSession(null));
});
