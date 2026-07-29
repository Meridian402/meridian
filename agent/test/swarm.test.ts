import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The modules under test resolve their data dir at import time, so the override
// and the fixture files must both be in place BEFORE the dynamic imports below.
// A fresh temp dir per run keeps this off the real ledgers.
const dir = mkdtempSync(join(tmpdir(), "meridian-swarm-test-"));
process.env.MERIDIAN_DATA_DIR = dir;
delete process.env.MERIDIAN_HOUSE_AGENT_ID;
delete process.env.SWARM_TAKEAWAYS_PER_AGENT;
delete process.env.SWARM_MAX_PER_DAY;

const OPTED_IN = "0x00000000000000000000000000000000000000c1";
const OPTED_OUT = "0x00000000000000000000000000000000000000c2";
const NEVER_ASKED = "0x00000000000000000000000000000000000000c3";
const FLIPPED = "0x00000000000000000000000000000000000000c4";

// Latest row wins per wallet, so FLIPPED opts in and then back out.
writeFileSync(
  join(dir, "agent-settings.jsonl"),
  [
    { address: OPTED_IN, settings: { name: "Atlas", joinSwarm: true }, at: 1 },
    { address: OPTED_OUT, settings: { name: "Bee", joinSwarm: false }, at: 2 },
    { address: NEVER_ASKED, settings: { name: "Cass" }, at: 3 },
    { address: FLIPPED, settings: { joinSwarm: true }, at: 4 },
    { address: FLIPPED, settings: { joinSwarm: false }, at: 5 },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);

const { SEGMENTS } = await import("../src/research/segments.js");
const { sanitizeSettings } = await import("../src/deploy/agentSettings.js");
const { listParticipants, houseParticipants, researchParticipants, userParticipants, userOptedIn, mainHouseParticipant } = await import(
  "../src/swarm/roster.js"
);
const { appendSwarmRow, exchangesSince, swarmTotals } = await import("../src/swarm/feed.js");
const { takeawaysFor, takeawayLimit, fitTakeaways, learningSection } = await import("../src/swarm/learning.js");
const { dailyBudget, swarmEnabled, swarmIntervalMs } = await import("../src/swarm/loop.js");
const { pickPair, turnCount } = await import("../src/swarm/exchange.js");

// ---- roster: who may speak --------------------------------------------------

test("house research agents are always eligible, one per segment", () => {
  const house = researchParticipants();
  assert.equal(house.length, SEGMENTS.length);
  assert.deepEqual(
    house.map((p) => p.id),
    SEGMENTS.map((s) => `rwa-research-${s.key}`),
  );
  assert.ok(house.every((p) => p.kind === "house" && p.displayName.endsWith("Desk")));
  assert.equal(house.find((p) => p.id === "rwa-research-equities")?.displayName, "Equities Desk");
  // The segment title rides along so the other agent knows who it is talking to.
  assert.equal(house.find((p) => p.id === "rwa-research-equities")?.expertise, SEGMENTS.find((s) => s.key === "equities")?.title);
});

test("main house agent is included only when the env names one", () => {
  assert.equal(mainHouseParticipant(), null);
  assert.equal(houseParticipants().length, SEGMENTS.length);
  process.env.MERIDIAN_HOUSE_AGENT_ID = "merd-house";
  try {
    assert.equal(mainHouseParticipant()?.id, "merd-house");
    assert.equal(houseParticipants().length, SEGMENTS.length + 1);
  } finally {
    delete process.env.MERIDIAN_HOUSE_AGENT_ID;
  }
  assert.equal(houseParticipants().length, SEGMENTS.length);
});

test("a user agent is eligible only when that wallet set joinSwarm true", () => {
  assert.equal(userOptedIn({ joinSwarm: true }), true);
  assert.equal(userOptedIn({ joinSwarm: false }), false);
  assert.equal(userOptedIn({}), false);
  assert.equal(userOptedIn(undefined), false);

  const users = userParticipants();
  assert.deepEqual(users.map((p) => p.address), [OPTED_IN]);
  assert.equal(users[0].kind, "user");
  assert.equal(users[0].displayName, "Atlas");
  // An opt-out that was once an opt-in is out: the latest row is the consent.
  assert.ok(!users.some((p) => p.address === FLIPPED));
});

test("the full roster is house agents plus opted-in users only", () => {
  const all = listParticipants();
  assert.equal(all.length, SEGMENTS.length + 1);
  assert.equal(all.filter((p) => p.kind === "user").length, 1);
  const addresses = all.map((p) => p.address).filter(Boolean);
  assert.deepEqual(addresses, [OPTED_IN]);
  for (const denied of [OPTED_OUT, NEVER_ASKED, FLIPPED]) assert.ok(!addresses.includes(denied));
});

test("joinSwarm is settable through the existing settings route, booleans only", () => {
  assert.deepEqual(sanitizeSettings({ joinSwarm: true }), { settings: { joinSwarm: true } });
  assert.deepEqual(sanitizeSettings({ joinSwarm: false }), { settings: { joinSwarm: false } });
  // Consent is never inferred from a truthy value.
  assert.ok("error" in sanitizeSettings({ joinSwarm: "true" }));
  assert.ok("error" in sanitizeSettings({ joinSwarm: 1 }));
});

// ---- pairing: rotation, never a coin flip -----------------------------------

test("pickPair rotates deterministically and never pairs an agent with itself", () => {
  const pool = listParticipants();
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const pair = pickPair(pool, i);
    assert.ok(pair);
    assert.notEqual(pair[0].id, pair[1].id);
    seen.add(`${pair[0].id}|${pair[1].id}`);
    assert.deepEqual(pickPair(pool, i)?.map((p) => p.id), pair.map((p) => p.id)); // same counter, same pair
  }
  assert.ok(seen.size > 10, "consecutive exchanges should not repeat the same pair");
  assert.equal(pickPair(pool.slice(0, 1), 0), null);
});

test("turn count defaults to 4 and is hard-capped at 8", () => {
  assert.equal(turnCount(), 4);
  const cases: [string, number][] = [["2", 2], ["6", 6], ["99", 8], ["0", 4], ["nope", 4]];
  for (const [env, want] of cases) {
    process.env.SWARM_TURNS = env;
    assert.equal(turnCount(), want, `SWARM_TURNS=${env}`);
  }
  delete process.env.SWARM_TURNS;
});

// ---- takeaways: the cap ------------------------------------------------------

const AGENT = "rwa-research-equities";
const OTHER = "rwa-research-commodities";

test("takeaways keep only the most recent N for that agent, newest first", () => {
  for (let i = 1; i <= 8; i++) {
    appendSwarmRow({ exchangeId: `sx-t${i}`, seq: 1, kind: "takeaway", speakerId: AGENT, speakerName: "Equities Desk", speakerKind: "house", text: `lesson ${i}`, at: 1000 + i });
    appendSwarmRow({ exchangeId: `sx-t${i}`, seq: 2, kind: "turn", speakerId: AGENT, speakerName: "Equities Desk", speakerKind: "house", text: `turn ${i}`, at: 1000 + i });
  }
  appendSwarmRow({ exchangeId: "sx-t9", seq: 1, kind: "takeaway", speakerId: OTHER, speakerName: "Commodities Desk", speakerKind: "house", text: "not mine", at: 2000 });

  assert.equal(takeawayLimit(), 5);
  const mine = takeawaysFor(AGENT);
  assert.equal(mine.length, 5);
  assert.deepEqual(mine.map((t) => t.text), ["lesson 8", "lesson 7", "lesson 6", "lesson 5", "lesson 4"]);
  // Turns are not takeaways, and another agent's takeaway is not this one's.
  assert.ok(mine.every((t) => !t.text.startsWith("turn")));
  assert.deepEqual(takeawaysFor(OTHER).map((t) => t.text), ["not mine"]);
  assert.deepEqual(takeawaysFor("rwa-research-carbon"), []);
});

test("takeaway limit is env-tunable and bounded", () => {
  const cases: [string, number][] = [["3", 3], ["1", 1], ["500", 20], ["0", 5], ["junk", 5]];
  for (const [env, want] of cases) {
    process.env.SWARM_TAKEAWAYS_PER_AGENT = env;
    assert.equal(takeawayLimit(), want, `SWARM_TAKEAWAYS_PER_AGENT=${env}`);
  }
  process.env.SWARM_TAKEAWAYS_PER_AGENT = "3";
  assert.deepEqual(takeawaysFor(AGENT).map((t) => t.text), ["lesson 8", "lesson 7", "lesson 6"]);
  delete process.env.SWARM_TAKEAWAYS_PER_AGENT;
});

test("injected persona text is capped, and whole lines only", () => {
  const long = "x".repeat(200);
  const fitted = fitTakeaways([long, long, long, long, long], 600);
  assert.equal(fitted.length, 2); // "- " + 200 chars + newline = 203 each
  assert.ok(fitted.join("\n").length <= 600);
  assert.ok(fitted.every((l) => l === `- ${long}`)); // never a half sentence
  // A single line longer than the whole budget is dropped, not truncated.
  assert.deepEqual(fitTakeaways(["y".repeat(700)], 600), []);

  const section = learningSection(AGENT);
  assert.ok(section.includes("learned from talking to other agents"));
  assert.ok(section.includes("lesson 8"));
  assert.ok(section.length <= 800);
  assert.equal(learningSection("rwa-research-carbon"), ""); // never been in an exchange
});

// ---- daily cap: counted from the ledger, not from memory --------------------

test("daily cap counts distinct exchanges in the trailing 24h from the ledger", () => {
  const now = Date.now();
  const hoursAgo = (h: number) => now - h * 60 * 60 * 1000;
  const before = swarmTotals().exchanges;

  // Two rows of the same exchange count once; a 30h-old exchange is out of window.
  appendSwarmRow({ exchangeId: "sx-day-1", seq: 0, kind: "topic", speakerId: "swarm", speakerName: "Topic", speakerKind: "system", text: "q", at: hoursAgo(2) });
  appendSwarmRow({ exchangeId: "sx-day-1", seq: 1, kind: "turn", speakerId: AGENT, speakerName: "Equities Desk", speakerKind: "house", text: "a", at: hoursAgo(2) });
  appendSwarmRow({ exchangeId: "sx-day-2", seq: 0, kind: "topic", speakerId: "swarm", speakerName: "Topic", speakerKind: "system", text: "q", at: hoursAgo(20) });
  appendSwarmRow({ exchangeId: "sx-day-old", seq: 0, kind: "topic", speakerId: "swarm", speakerName: "Topic", speakerKind: "system", text: "q", at: hoursAgo(30) });

  // The fixture rows above this test all carry tiny `at` values, so only the
  // three written here fall inside the window.
  assert.equal(exchangesSince(hoursAgo(24)), 2);
  assert.equal(swarmTotals().exchanges, before + 3);

  process.env.SWARM_MAX_PER_DAY = "3";
  assert.deepEqual(dailyBudget(), { used: 2, max: 3, remaining: 1 });

  appendSwarmRow({ exchangeId: "sx-day-3", seq: 0, kind: "topic", speakerId: "swarm", speakerName: "Topic", speakerKind: "system", text: "q", at: now });
  assert.deepEqual(dailyBudget(), { used: 3, max: 3, remaining: 0 });

  // A cap of 0 stops it entirely; a bad value falls back to the default.
  process.env.SWARM_MAX_PER_DAY = "0";
  assert.equal(dailyBudget().remaining, 0);
  process.env.SWARM_MAX_PER_DAY = "junk";
  assert.deepEqual(dailyBudget(), { used: 3, max: 24, remaining: 21 });
  delete process.env.SWARM_MAX_PER_DAY;
});

test("the loop is off unless MERIDIAN_SWARM is exactly on, and has a floor interval", () => {
  assert.equal(swarmEnabled(), false);
  for (const v of ["1", "true", "ON", ""]) {
    process.env.MERIDIAN_SWARM = v;
    assert.equal(swarmEnabled(), false, `MERIDIAN_SWARM=${v}`);
  }
  process.env.MERIDIAN_SWARM = "on";
  assert.equal(swarmEnabled(), true);
  delete process.env.MERIDIAN_SWARM;

  assert.equal(swarmIntervalMs(), 30 * 60 * 1000);
  process.env.SWARM_INTERVAL_MS = "1000"; // below the floor
  assert.equal(swarmIntervalMs(), 5 * 60 * 1000);
  process.env.SWARM_INTERVAL_MS = "3600000";
  assert.equal(swarmIntervalMs(), 3600000);
  delete process.env.SWARM_INTERVAL_MS;
});
