import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meridian-topics-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_LIVE_PRICES = "0";

// Real state, or every assertion below passes vacuously: with an empty universe
// buildTopic correctly returns null and the tests prove nothing. Several venues
// across two segments, so the builder has more than one question available.
const venues = [
  { name: "Alpha T-Bills", segment: "treasuries", tokenizes: "US Treasury bills", confidence: "high", updatedAt: "2026-07-30T10:00:00Z" },
  { name: "Beta Equities", segment: "equities", tokenizes: "tokenized stocks", confidence: "medium", updatedAt: "2026-07-30T11:00:00Z" },
  { name: "Gamma Credit", segment: "treasuries", tokenizes: "private credit", confidence: "low", updatedAt: "2026-07-30T12:00:00Z" },
  { name: "Delta Fund", segment: "equities", tokenizes: "index fund shares", confidence: "high", updatedAt: "2026-07-30T13:00:00Z" },
];
process.env.MERIDIAN_UNIVERSE_PATH = join(dir, "rwa-universe.json");
writeFileSync(process.env.MERIDIAN_UNIVERSE_PATH, JSON.stringify({ venues, updatedAt: "2026-07-30T13:00:00Z" }));

const { buildTopic } = await import("../src/swarm/topics.js");

// If the fixture did not take, say so loudly rather than reporting green.
test("the fixture actually produces topics, or nothing below means anything", () => {
  assert.ok(buildTopic(0, []), "buildTopic returned null: the rest of this file would assert nothing");
});

// Production ran 29 exchanges on 8 distinct topics: 21 exact repeats, and one
// question asked ELEVEN times word for word. Agents share a durable session, so
// they watch the duplicates accumulate, and one of them eventually spends its
// paid turn replying "you have sent me this prompt twice, identically".
//
// The cause was not the rotation. The rotation walks the SOURCES, and a source
// that has not changed hands back the same question however far the seed moves:
// the desk holds no capital, so all twenty of its recent decisions were the
// identical "hold / scanning the market for opportunities" row.

test("a topic already asked is not asked again while another is available", () => {
  const first = buildTopic(0, []);
  const second = buildTopic(0, [first.text]);
  assert.ok(second, "asking again must still produce something");
  assert.notEqual(second!.text, first!.text, "the seed is unchanged, so only the exclusion can do this");
});

test("when everything has been asked, it says so rather than repeating silently", () => {
  const seeds = [0, 1, 2, 3, 4, 5, 6, 7];
  const all = seeds.map((s) => buildTopic(s, [])).filter(Boolean).map((t) => t!.text);
  const exhausted = buildTopic(0, all);
  assert.ok(exhausted, "an exhausted pool must not stop the swarm entirely");
  // The premise is still live state, it is just not new, so the agents are
  // asked to move it on instead of restating a position they already hold.
  assert.match(exhausted!.text, /asked about this before/i);
  assert.match(exhausted!.text, /change your mind|cannot check/i);
});

test("a topic always carries the facts it was built from", () => {
  // The feed's claim is that a premise is checkable. A question with no facts
  // behind it would be an invented one.
  for (const seed of [0, 1, 2, 3]) {
    const t = buildTopic(seed, []);
    if (!t) continue;
    assert.ok(Array.isArray(t.facts), "facts must be present");
    assert.ok(t.text.trim().length > 40, "a premise should actually say something");
  }
});

test("the seeded venues are the ones it talks about, never invented ones", () => {
  // The feed's whole claim is that a premise is real. Every venue named in a
  // topic must be one that is actually in the universe.
  const named = new Set(venues.map((v) => v.name));
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const t = buildTopic(seed, []);
    if (!t) continue;
    const mentions = venues.filter((v) => t.text.includes(v.name)).map((v) => v.name);
    for (const m of mentions) assert.ok(named.has(m), `${m} is not in the universe`);
    // And it never invents a venue that looks plausible but was never seeded.
    assert.ok(!/Acme|Example Venue|Foo/i.test(t.text), "a topic must not contain a made-up venue");
  }
});
