import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * THE GAP THAT LOOKS LIKE COVERAGE.
 *
 * There are two lists. ledger.ts LEDGER_FILES decides what is mirrored into
 * Postgres row by row. backup.ts FILES decides what can actually be RESTORED,
 * because restoreMissing reads only the snapshot table and skips any filename
 * it does not recognise.
 *
 * A file in the first list and not the second is the worst case available: it
 * is copied every five minutes, it appears in the backup status, and it can
 * never come back. Nothing fails until a volume resets, and then the loss is
 * silent and total.
 *
 * Audited 2026-08-09 and three files were exposed:
 *
 *   meme-rotations.jsonl   in NEITHER list. The desk's own record of every
 *                          re-quote, stop, sweep, collect and expansion, and
 *                          the sole input to the daily consistency record.
 *   book-snapshots.jsonl   mirrored, unrestorable. The equity curve itself.
 *   turns.jsonl            mirrored, unrestorable.
 *
 * This test is the audit, run every time, so the next file added to one list
 * and forgotten in the other fails here instead of during a restore.
 */

const parseList = (src: string, marker: string): string[] => {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker}`);
  const end = src.indexOf("];", start);
  assert.notEqual(end, -1, `could not find the end of ${marker}`);
  return [...src.slice(start, end).matchAll(/"([A-Za-z0-9.\-_]+\.(?:jsonl|json))"/g)].map((m) => m[1]);
};

const backupFiles = parseList(readFileSync(new URL("../src/backup.ts", import.meta.url), "utf8"), "const FILES");
const ledgerFiles = parseList(readFileSync(new URL("../src/ledger.ts", import.meta.url), "utf8"), "const LEDGER_FILES");

test("every mirrored file is also restorable", () => {
  const orphans = ledgerFiles.filter((f) => !backupFiles.includes(f));
  assert.deepEqual(
    orphans,
    [],
    `these are mirrored row-by-row but cannot be restored, so they look backed up and are not: ${orphans.join(", ")}`,
  );
});

test("the desk's own journal is durable", () => {
  // consistency.ts derives the entire daily record from this one file, and the
  // weekend diagnosis was cross-checked against on-chain skims using it. Losing
  // it does not lose money, it loses the ability to prove anything happened.
  assert.ok(backupFiles.includes("meme-rotations.jsonl"), "meme-rotations.jsonl must be restorable");
});

test("the equity curve is durable", () => {
  assert.ok(backupFiles.includes("book-snapshots.jsonl"), "book-snapshots.jsonl must be restorable");
});

test("neither list has duplicates, which would hide a name behind itself", () => {
  for (const [name, list] of [["FILES", backupFiles], ["LEDGER_FILES", ledgerFiles]] as const) {
    assert.equal(new Set(list).size, list.length, `${name} contains a duplicate entry`);
  }
});

test("the lists are non-trivial, so a parse failure cannot pass as coverage", () => {
  // Guards the test itself: if the regex ever stops matching, both lists go
  // empty and every assertion above would pass vacuously.
  assert.ok(backupFiles.length >= 25, `parsed only ${backupFiles.length} backup files`);
  assert.ok(ledgerFiles.length >= 15, `parsed only ${ledgerFiles.length} ledger files`);
});
