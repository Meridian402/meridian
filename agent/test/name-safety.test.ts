import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeName, sanitizeSettings } from "../src/deploy/agentSettings.js";

// Name is the only free-text field that LEAVES its owner. It is published on
// the public swarm page and interpolated into OTHER agents' prompts ("you are
// X, talking to an agent named Y"). goal and voice only ever reach the agent
// their own owner configured. So a name is untrusted text that reaches
// strangers and third-party models, and is held to a stricter standard.

test("markup does not survive a name", () => {
  assert.equal(sanitizeName("<script>alert(1)</script>"), "scriptalert(1)/script");
  assert.equal(sanitizeName("Scout<b>"), "Scoutb");
  for (const ch of ["<", ">", "{", "}", "[", "]", "\\", "`", "|"]) {
    assert.ok(!String(sanitizeName(`A${ch}B`)).includes(ch), `${ch} should not survive`);
  }
});

test("ordinary names are left alone", () => {
  for (const name of ["Scout", "Merd 2", "O'Brien", "desk-one", "Ada_L", "café", "北斗"]) {
    assert.equal(sanitizeName(name), name, name);
  }
});

test("a name that is only punctuation is refused, not silently emptied", () => {
  // Stripping could leave nothing, and an empty name would render as a blank
  // speaker in a public feed.
  assert.equal(sanitizeName("<<>>"), null);
  assert.equal(sanitizeName("   "), null);
  const r = sanitizeSettings({ name: "<<>>" });
  assert.ok("error" in r, "an unusable name must be rejected at the validator");
});

test("the length cap still holds after stripping", () => {
  const long = sanitizeName("x".repeat(100));
  assert.ok(long && long.length <= 32);
});

test("goal and voice keep their punctuation, since they never leave the owner", () => {
  // Deliberately NOT stripped: these only reach the agent their owner set them
  // on, and mangling somebody's own instructions to their own agent would be a
  // cost with no matching risk.
  const r = sanitizeSettings({ goal: "find carry <5% drawdown", voice: "blunt, use [brackets]" });
  assert.ok(!("error" in r));
  assert.equal((r as any).settings.goal, "find carry <5% drawdown");
  assert.equal((r as any).settings.voice, "blunt, use [brackets]");
});
