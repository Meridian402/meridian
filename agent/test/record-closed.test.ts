import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClosedAt, closedRecord } from "../src/recordClosed.js";

/**
 * THE CLOSED RECORD (2026-09-07): when the desk is wound down, the env value
 * closes the record and the shipped final figures are what the site shows.
 */
test("parseClosedAt: empty or garbage leaves the record open; a date closes it in ISO form", () => {
  assert.equal(parseClosedAt(undefined), null);
  assert.equal(parseClosedAt(""), null);
  assert.equal(parseClosedAt("   "), null);
  assert.equal(parseClosedAt("not a date"), null);
  assert.equal(parseClosedAt("2026-09-07T11:11:43Z"), "2026-09-07T11:11:43.000Z");
  assert.equal(parseClosedAt("2026-09-07"), new Date("2026-09-07").toISOString());
});

test("the shipped final figures load and carry the numbers the site showed at close", () => {
  const r = closedRecord();
  assert.ok(r, "record-closed.json ships with the agent");
  assert.equal(r!.closedAt, "2026-09-07T11:11:43Z");
  assert.equal(r!.book.capitalInUsd, 997);
  assert.equal(r!.book.workingUsd, 0);
  assert.ok(r!.book.bookUsd > 3900 && r!.book.bookUsd < 4100, "the book closed near $4,000");
  assert.ok(Math.abs(r!.book.bookUsd - r!.book.capitalInUsd - r!.book.profitUsd) < 0.01, "profit is book minus capital in");
  assert.equal(r!.record.daysLive, 33);
  assert.equal(r!.wallets.house, "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe");
});
