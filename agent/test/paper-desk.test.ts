import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE PAPER DESK PAYLOAD.
 *
 * This is the one piece of the paper work the public sees, so what it must
 * never do is pinned here: claim to be live, leak anything that looks like a
 * wallet or a provider URL, or fall over on an empty record (a fresh server
 * has no ledgers for its first hour, and the page must say so, not 500).
 */

const dir = mkdtempSync(join(tmpdir(), "paper-desk-"));
process.env.MERIDIAN_DATA_DIR = dir;
const { buildPaperDesk } = await import("../src/signals/paperDesk.js");

const H = 3600;
const T0 = 1_800_000_000 - (1_800_000_000 % H);
const hour = (i: number, id: string, symbol: string) => ({
  ts: (T0 + (i + 1) * H) * 1000, kind: "hour", id, symbol, quote: "USDG", feePct: 1, enterable: true, hour: new Date((T0 + i * H) * 1000).toISOString().slice(0, 13) + ":00Z", hourStart: T0 + i * H,
  swaps: 40, traders: 12, volumeUsd: 200_000, feesUsd: 200, markoutUsd: 20, lpNetUsd: 180, pxOpen: 1, pxClose: 1, pxHigh: 1.01, pxLow: 0.99, sqrtPClose: 1, liquidity: 1e18, depth2pctUsd: 4000, seatSharePct: 2, seatNetUsd: 3.6,
});

test("an empty record is a valid answer, not an error", () => {
  const s = buildPaperDesk(false);
  assert.equal(s.paper, true);
  assert.equal(s.record.hours, 0);
  assert.equal(s.record.from, null);
  assert.equal(s.ranking.length, 0);
  assert.ok(s.ruleSets.length >= 4 && s.ruleSets.every((r) => r.seats === 0 && r.netUsd === 0));
  assert.equal(s.collecting, false);
});

test("with hours on record it carries the ranking, every rule set and the baseline, and says it is paper", () => {
  writeFileSync(join(dir, "pool-watch.jsonl"), Array.from({ length: 12 }, (_, i) => JSON.stringify(hour(i, "0xaaa", "FOO"))).join("\n") + "\n");
  const s = buildPaperDesk(true, 1600);
  assert.equal(s.paper, true);
  assert.equal(s.collecting, true);
  assert.equal(s.record.hours, 12);
  assert.deepEqual(s.record.byChain, [{ chain: "robinhood", pools: 1, hours: 12 }]);
  assert.equal(s.ranking.length, 1);
  assert.equal(s.ranking[0].chain, "robinhood");
  assert.ok(s.ranking[0].seatPerDayUsd > 0);
  assert.equal(s.baseline.length, 1);
  const closed = s.ruleSets[0];
  assert.equal(closed.name, "desk rules as closed");
  assert.equal(closed.seats, 1, "this pool clears every one of the desk's bars");
  assert.ok(closed.feesUsd > 0);
  assert.ok(Math.abs(closed.endBookUsd - (1600 + closed.netUsd)) < 0.02);
  assert.ok(closed.refusals.some((r) => r.gate === "book fully deployed"), "the internal wording is translated for the page");
  assert.match(s.notes[0], /^Paper only/);
});

test("nothing in the payload looks like a wallet, a key or a provider URL", () => {
  const text = JSON.stringify(buildPaperDesk(true));
  assert.ok(!/https?:\/\//.test(text), "no URLs");
  assert.ok(!/alch_/i.test(text) && !/private|secret/i.test(text));
  assert.ok(!/0x[0-9a-fA-F]{40}/.test(text), "pool and wallet addresses stay on the server");
});
