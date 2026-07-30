import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meridian-persona-cache-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_LIVE_PRICES = "0";

const WALLET = "0x00000000000000000000000000000000000000c1";
writeFileSync(join(dir, "agent-settings.jsonl"), JSON.stringify({ address: WALLET, settings: { name: "Scout" }, at: 1 }) + "\n");

const sample = (volume: number) =>
  JSON.stringify({
    m: [
      ["BTC", 0, volume, 0, null, null],
      ["ETH", 0, volume * 0.6, 0, null, null],
      ["SOL", 0, volume * 0.3, 0, null, null],
      ["NVDA", 0, volume * 0.2, 0, null, null],
      ["AAPL", 0, volume * 0.1, 0, null, null],
    ],
  });

const LOG = join(dir, "lighter-log.jsonl");
writeFileSync(LOG, sample(41_200_000) + "\n");

const { personaFor } = await import("../src/deploy/myAgent.js");
const { resetSettingsCache } = await import("../src/deploy/agentSettings.js");

// The persona is a SYSTEM INSTRUCTION, so it is the cached prefix of every turn.
// Prompt caching is prefix-matched: rewrite it and the cache is discarded for
// the persona, the tool definitions AND the whole conversation behind them. On
// Haiku 4.5 that is $1.00/M rather than $0.10/M, on a prefix of ~4,100 tokens
// that grows with the length of the chat. So persona stability is not tidiness,
// it is the single biggest lever on what a message costs.

test("a routine move in live figures does not rewrite the persona", () => {
  const before = personaFor(WALLET);
  for (const pct of [0.4, 1, 2]) {
    writeFileSync(LOG, sample(41_200_000 * (1 + pct / 100)) + "\n");
    assert.equal(personaFor(WALLET), before, `a ${pct}% volume tick must not invalidate the cached prefix`);
  }
});

test("a real move still updates it, so the figures are not frozen", () => {
  const before = personaFor(WALLET);
  writeFileSync(LOG, sample(41_200_000 * 1.4) + "\n");
  assert.notEqual(personaFor(WALLET), before, "quantised is not the same as stale");
});

test("the persona says its figures are approximate, since they now are", () => {
  writeFileSync(LOG, sample(41_200_000) + "\n");
  const p = personaFor(WALLET);
  assert.match(p, /roughly \$\d+M a day/);
  assert.match(p, /approximate/i, "rounding the numbers obliges us to say they are rounded");
  // No per-book dollar figures: those moved on every sampler write.
  assert.ok(!/\$\d+k/.test(p), "per-book figures were the churn, and are gone");
});

test("the persona stays within its token budget", () => {
  // ~4 chars a token. This is paid on every uncached turn and cached on every
  // other one, so it is worth knowing when it grows.
  const chars = personaFor(WALLET).length;
  assert.ok(chars < 12_000, `persona is ${chars} chars (~${Math.round(chars / 4)} tokens), which is past its budget`);
});

test("a settings change DOES rewrite it, or customisation would not take", () => {
  const before = personaFor(WALLET);
  writeFileSync(join(dir, "agent-settings.jsonl"),
    JSON.stringify({ address: WALLET, settings: { name: "Scout", voice: "dry and skeptical" }, at: 2 }) + "\n");
  resetSettingsCache();
  const after = personaFor(WALLET);
  assert.notEqual(after, before);
  assert.match(after, /dry and skeptical/);
});
