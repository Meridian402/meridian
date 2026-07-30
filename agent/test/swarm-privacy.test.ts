import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same harness as swarm.test.ts: the data dir override and the settings fixture
// must be in place before the dynamic imports, and a fresh temp dir keeps this
// off the real ledgers.
const dir = mkdtempSync(join(tmpdir(), "meridian-swarm-privacy-"));
process.env.MERIDIAN_DATA_DIR = dir;

const IN = "0x00000000000000000000000000000000000000d1";
const OUT = "0x00000000000000000000000000000000000000d2";

writeFileSync(
  join(dir, "agent-settings.jsonl"),
  [
    { address: IN, settings: { name: "Atlas", joinSwarm: true }, at: 1 },
    { address: OUT, settings: { name: "Bee", joinSwarm: true }, at: 2 },
    // Bee changes their mind. Latest row wins.
    { address: OUT, settings: { name: "Bee", joinSwarm: false }, at: 3 },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);

const { publicIdForWallet, userParticipants, houseParticipantFor, rosterHealth, publicIdFor } = await import("../src/swarm/roster.js");
const { agentIdForWallet } = await import("../src/deploy/myAgent.js");
const { appendSwarmRow, publishableRows, swarmFeed, resetSwarmCache } = await import("../src/swarm/feed.js");
const { priorWith } = await import("../src/swarm/exchange.js");
type SwarmRow = import("../src/swarm/feed.js").SwarmRow;

const row = (exchangeId: string, seq: number, kind: SwarmRow["kind"], id: string, name: string, k: SwarmRow["speakerKind"], text: string): SwarmRow => ({
  exchangeId,
  seq,
  kind,
  speakerId: id,
  speakerName: name,
  speakerKind: k,
  text,
  at: Date.now(),
});

// ---- the wallet must never reach the public feed ----------------------------

test("a user agent's public id is not their wallet and does not contain it", () => {
  const pub = publicIdForWallet(IN);
  assert.ok(!pub.includes(IN.slice(2).toLowerCase()), "the address must not appear in the public id");
  assert.ok(!/^0x/.test(pub));
  assert.match(pub, /^agent-[0-9a-f]{12}$/);
  // Stable across calls, or a speaker's history would fragment every restart.
  assert.equal(pub, publicIdForWallet(IN));
  // Case-insensitive: the same wallet is the same speaker however it is written.
  assert.equal(pub, publicIdForWallet(IN.toUpperCase().replace("0X", "0x")));
});

test("the gateway id (which is the wallet) never equals the public id", () => {
  const p = userParticipants().find((x) => x.address === IN);
  assert.ok(p, "the opted-in wallet should be a participant");
  assert.ok(p!.id.includes(IN.slice(2).toLowerCase()), "the internal id is wallet-derived, which is exactly why it stays internal");
  assert.notEqual(p!.publicId, p!.id);
});

// ---- only Meridian's own agents may be house speakers -----------------------

test("agents belonging to other projects on the same gateway are never house speakers", () => {
  for (const foreign of ["Franky", "SolanaTradingAgent", "007", "main", "trader", "copywriter", "researcher"]) {
    assert.equal(houseParticipantFor(foreign), null, `${foreign} must not qualify`);
  }
  const fleet = houseParticipantFor("mrdn-fleet-5hge40-market-maker");
  assert.ok(fleet, "a Meridian fleet agent qualifies");
  assert.equal(fleet!.kind, "house");
  assert.equal(fleet!.publicId, fleet!.id);
});

// ---- turning the toggle off retracts what was already published -------------

test("opting out removes that agent's past conversations from the feed", () => {
  const inPub = publicIdForWallet(IN);
  const outPub = publicIdForWallet(OUT);
  resetSwarmCache();
  appendSwarmRow(row("x1", 0, "topic", "swarm", "Topic", "system", "a real question"));
  appendSwarmRow(row("x1", 1, "turn", "rwa-research-equities", "Equities Desk", "house", "house line"));
  appendSwarmRow(row("x1", 2, "turn", inPub, "Atlas", "user", "still opted in"));
  appendSwarmRow(row("x2", 0, "topic", "swarm", "Topic", "system", "another question"));
  appendSwarmRow(row("x2", 1, "turn", outPub, "Bee", "user", "spoken before opting out"));
  appendSwarmRow(row("x2", 2, "turn", "rwa-research-bonds", "Bonds Desk", "house", "replying to Bee"));

  const published = publishableRows();
  assert.ok(published.some((r) => r.speakerId === inPub), "an opted-in agent still appears");
  assert.ok(!published.some((r) => r.speakerId === outPub), "an opted-out agent is gone from the feed");
  // The whole exchange goes, not just their lines: half a conversation would
  // read as an agent talking to nobody.
  assert.ok(!published.some((r) => r.exchangeId === "x2"), "the exchange they were in is withdrawn entirely");
  assert.ok(published.some((r) => r.exchangeId === "x1"), "unaffected exchanges stay");

  const ids = swarmFeed(10).map((e) => e.exchangeId);
  assert.deepEqual(ids, ["x1"]);
});

// ---- context: agents remember what they concluded with THIS partner ---------

test("prior context is recalled per pair, and is empty for a first meeting", () => {
  const rows: SwarmRow[] = [
    row("e1", 0, "topic", "swarm", "Topic", "system", "first meeting"),
    row("e1", 1, "turn", "rwa-research-equities", "Equities Desk", "house", "a point"),
    row("e1", 2, "turn", "rwa-research-bonds", "Bonds Desk", "house", "a counterpoint"),
    row("e1", 3, "takeaway", "rwa-research-equities", "Equities Desk", "house", "depth matters more than spread"),
    row("e1", 4, "takeaway", "rwa-research-bonds", "Bonds Desk", "house", "I was wrong about duration"),
  ];
  const recall = priorWith("rwa-research-equities", "rwa-research-bonds", rows);
  assert.ok(recall, "two agents who have met before should have something to carry forward");
  assert.match(recall!, /what you took from it: depth matters more than spread/);
  assert.match(recall!, /what they took from it: I was wrong about duration/);

  // A pair that has never met carries nothing, so nothing is invented for them.
  assert.equal(priorWith("rwa-research-equities", "rwa-research-carbon", rows), null);
});

test("recall is bounded, so a long history cannot grow the prompt without limit", () => {
  const huge = "x".repeat(5000);
  const rows: SwarmRow[] = [
    row("e1", 0, "turn", "a", "A", "house", "hi"),
    row("e1", 1, "turn", "b", "B", "house", "hi"),
    row("e1", 2, "takeaway", "a", "A", "house", huge),
    row("e1", 3, "takeaway", "b", "B", "house", huge),
  ];
  const recall = priorWith("a", "b", rows);
  assert.ok(recall);
  assert.ok(recall!.length <= 401, `recall should be capped, got ${recall!.length}`);
});

// ---- the status endpoint is public, so its roster is held to the same rule ---

test("rosterHealth never carries anything address-shaped, on any path", async () => {
  // /api/swarm/status is unauthenticated with `*` CORS, and a user agent's
  // gateway id IS its owner's address: mrdn-u-<40 hex>. Projecting the obvious
  // field published every opted-in wallet, tied to the name its owner chose and
  // to everything that agent had said. It shipped that way. The property is the
  // shape of the whole object, not one field, because the next leak will be a
  // field nobody thought about.
  //
  // There is no gateway in a test, so `live` is empty and `missing` holds the
  // opted-in wallet. That is the path that matters: it is derived from settings
  // alone and needs no gateway to be served.
  const health = await rosterHealth();
  assert.ok(health.missing.length, "the fixture's opted-in wallet should show as missing here");
  const blob = JSON.stringify(health);
  assert.ok(!/[0-9a-fA-F]{40}/.test(blob), `roster health leaked something address-shaped: ${blob}`);
  assert.ok(!blob.toLowerCase().includes(IN.slice(2).toLowerCase()));
});

test("publicIdFor redacts a wallet id into the same speaker the feed publishes", () => {
  const redacted = publicIdFor(agentIdForWallet(IN));
  assert.ok(!redacted.includes(IN.slice(2).toLowerCase()));
  // Must equal the feed's id, or opting in would give one agent two identities
  // that no one could connect.
  assert.equal(redacted, publicIdForWallet(IN));
  // Case is not a way around it.
  assert.equal(publicIdFor(`mrdn-u-${IN.slice(2).toUpperCase()}`), publicIdForWallet(IN));
  // A house id names a desk, not a person, and passes through.
  assert.equal(publicIdFor("rwa-research-equities"), "rwa-research-equities");
});
