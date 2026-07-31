import { test } from "node:test";
import assert from "node:assert/strict";
import { routeCli } from "../src/cli/commands.js";
import type { AgentSettings } from "../src/deploy/agentSettings.js";

// The business model has exactly one paywall, and where it sits is a promise:
// credits buy CONVERSATION with your agent. Earning is not conversation.
//
// Scouting used to take a credit, which inverted the whole proposition: it
// asked somebody to spend money for the chance to be paid $0.10, and put the
// paywall in front of the one surface whose point is that value flows the other
// way. It is still a real model turn, so it is still metered against the global
// runaway ceiling and still capped at three runs per wallet per day, but it
// never reads a balance.

const empty: AgentSettings = {};

test("help states the split, including that earning is never paywalled", () => {
  // Stated in both helps: the short one a newcomer reads, and the full index.
  const short = routeCli("/help", empty).lines.join("\n");
  assert.match(short, /cost/i, "the price of a message must be visible");
  assert.match(short, /earn/i, "and that earning is not part of it");

  const all = routeCli("/help all", empty).lines.join("\n");
  assert.match(all, /one credit each/i);
  assert.match(all, /never behind the paywall/i, "the promise has to be written down to be a promise");
});

test("commands stay free, so exploring never costs anything", () => {
  // Every command routes locally or delegates to a read. None of them may
  // become a chat turn, because that is the only thing that spends.
  for (const cmd of ["/help", "/whoami", "/credits", "/status", "/pnl", "/explore", "/swarm", "/buy"]) {
    const r = routeCli(cmd, empty);
    assert.notEqual(r.effect.kind, "chat", `${cmd} must never route to a paid turn`);
  }
});

test("a plain message is the one thing that routes to a paid turn", () => {
  assert.equal(routeCli("what is the basis on NVDA?", empty).effect.kind, "chat");
});
