import { test } from "node:test";
import assert from "node:assert/strict";
import {
  staleAfterMs,
  exitAfterMs,
  judgeLoops,
  exitCandidate,
  registerLoop,
  beat,
  livenessSnapshot,
  _resetLiveness,
  type LoopEntry,
} from "../src/liveness.js";

const MIN = 60_000;
const entry = (over: Partial<LoopEntry>): LoopEntry => ({
  name: "lpGuard",
  everyMs: 5 * MIN,
  money: true,
  registeredAt: 1_000_000,
  lastBeat: null,
  beats: 0,
  ...over,
});

test("stale threshold is several periods with a floor for fast loops", () => {
  assert.equal(staleAfterMs(5 * MIN), 15 * MIN, "a 5-minute loop is stale after three missed ticks");
  assert.equal(staleAfterMs(90_000), 10 * MIN, "a 90-second loop gets the 10-minute floor, not 4.5 minutes");
});

test("exit threshold sits above the stale threshold and above the house-lock ceiling", () => {
  assert.equal(exitAfterMs(5 * MIN, 30 * MIN), 30 * MIN);
  assert.ok(exitAfterMs(90_000, 30 * MIN) > 15 * MIN, "the lock watchdog (15m) must always fire first when the lock is the cause");
  assert.equal(exitAfterMs(60 * MIN, 30 * MIN), 240 * MIN, "an hourly loop gets four periods");
  assert.equal(exitAfterMs(5 * MIN, 0), Infinity, "a zero floor disables the exit");
});

test("a loop that has never beaten is judged from registration, not treated as dead at boot", () => {
  const [v] = judgeLoops([entry({ registeredAt: 1_000_000 })], 1_000_000 + 2 * MIN);
  assert.equal(v.stale, false, "two minutes after boot is grace, not death");
  const [late] = judgeLoops([entry({ registeredAt: 1_000_000 })], 1_000_000 + 16 * MIN);
  assert.equal(late.stale, true, "sixteen minutes without a first tick is a loop that never started");
});

test("a fresh beat clears staleness; age is measured from the last completed tick", () => {
  const [v] = judgeLoops([entry({ lastBeat: 5_000_000, beats: 3 })], 5_000_000 + 4 * MIN);
  assert.equal(v.stale, false);
  assert.equal(v.ageMs, 4 * MIN);
});

test("only a money loop past the exit threshold is fatal", () => {
  const now = 10_000_000;
  const report = entry({ name: "bookSnapshot", everyMs: 2 * MIN, money: false, lastBeat: now - 60 * MIN });
  const fine = entry({ name: "pilotGuard", everyMs: 150_000, lastBeat: now - 20 * MIN });
  const dead = entry({ name: "lpGuard", lastBeat: now - 31 * MIN });
  const verdicts = judgeLoops([report, fine, dead], now);
  assert.equal(exitCandidate(judgeLoops([report, fine], now), 30 * MIN), null, "a dead report-only loop and a merely stale money loop do not exit");
  assert.equal(exitCandidate(verdicts, 30 * MIN)?.name, "lpGuard");
  assert.equal(exitCandidate(verdicts, 0), null, "exit disabled: nothing is fatal");
});

test("the snapshot fails only on a stale money loop and names every stale loop", () => {
  _resetLiveness();
  registerLoop("lpGuard", 5 * MIN, { money: true });
  registerLoop("bookSnapshot", 2 * MIN);
  beat("lpGuard");
  beat("bookSnapshot");
  const fresh = livenessSnapshot();
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.stale, []);
  assert.equal(fresh.loops.find((l) => l.name === "lpGuard")?.beats, 1);

  const later = Date.now() + 11 * MIN;
  const snap = livenessSnapshot(later);
  assert.deepEqual(snap.stale, ["bookSnapshot"], "the 2-minute loop hit its 10-minute floor; the 5-minute loop has 15");
  assert.equal(snap.ok, true, "a stale report-only loop does not fail health");

  const muchLater = Date.now() + 16 * MIN;
  const bad = livenessSnapshot(muchLater);
  assert.equal(bad.ok, false, "a stale money loop fails health");
  assert.ok(bad.stale.includes("lpGuard"));
  _resetLiveness();
});

test("a beat for an unregistered name invents nothing", () => {
  _resetLiveness();
  beat("ghost");
  assert.deepEqual(livenessSnapshot().loops, []);
});

test("re-registering keeps the history rather than resetting the clock", () => {
  _resetLiveness();
  registerLoop("lpGuard", 5 * MIN, { money: true });
  beat("lpGuard");
  registerLoop("lpGuard", 5 * MIN, { money: true });
  assert.equal(livenessSnapshot().loops[0].beats, 1);
  _resetLiveness();
});
