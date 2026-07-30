import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meridian-ledger-view-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_LIVE_PRICES = "0";

const { ledgerView } = await import("../src/ledger.js");

const FILE = "view-test.jsonl";
const PATH = join(dir, FILE);
const write = (rows: object[]) => writeFileSync(PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// The point of the cache is that a hot read stops re-parsing the file. The point
// of these tests is that it never does so at the cost of serving a stale answer,
// because every one of these ledgers is append-only state that other processes
// also write (the swarm CLI, the autopilot), and a view that trusted only its
// own writes would go stale silently and stay that way.

test("a repeated read parses once, and a changed file is picked up", () => {
  let folds = 0;
  write([{ k: "a", v: 1 }]);
  const view = ledgerView<Record<string, number>>(FILE, (rows) => {
    folds++;
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ k: string; v: number }>) out[r.k] = r.v;
    return out;
  });

  assert.deepEqual(view.get(), { a: 1 });
  assert.deepEqual(view.get(), { a: 1 });
  assert.deepEqual(view.get(), { a: 1 });
  assert.equal(folds, 1, "three reads of an unchanged file must parse it once");

  // An append by anyone, including another process, must invalidate.
  appendFileSync(PATH, JSON.stringify({ k: "b", v: 2 }) + "\n");
  assert.deepEqual(view.get(), { a: 1, b: 2 }, "a stale view is worse than a slow one");
  assert.equal(folds, 2);
});

test("latest row wins, which is what every caller of this assumes", () => {
  write([{ k: "a", v: 1 }, { k: "a", v: 2 }, { k: "a", v: 3 }]);
  const view = ledgerView<Record<string, number>>(FILE, (rows) => {
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ k: string; v: number }>) out[r.k] = r.v;
    return out;
  });
  assert.deepEqual(view.get(), { a: 3 });
});

test("one corrupt line loses that line, not the ledger", () => {
  writeFileSync(PATH, [JSON.stringify({ k: "a", v: 1 }), "{ not json", JSON.stringify({ k: "b", v: 2 }), ""].join("\n"));
  const view = ledgerView<string[]>(FILE, (rows) => (rows as Array<{ k: string }>).map((r) => r.k));
  assert.deepEqual(view.get(), ["a", "b"]);
});

test("a missing file folds empty and is not cached as empty", () => {
  rmSync(PATH, { force: true });
  let folds = 0;
  const view = ledgerView<number>(FILE, (rows) => {
    folds++;
    return rows.length;
  });
  assert.equal(view.get(), 0);
  assert.equal(view.get(), 0);
  assert.equal(folds, 2, "absence must not be cached, or the first write would never be seen");

  // And the moment it exists, it is read.
  write([{ k: "a" }, { k: "b" }]);
  assert.equal(view.get(), 2);
});

test("reset forces a re-read, for tests and for anything that rewrites a file", () => {
  write([{ k: "a" }]);
  let folds = 0;
  const view = ledgerView<number>(FILE, (rows) => {
    folds++;
    return rows.length;
  });
  view.get();
  view.get();
  assert.equal(folds, 1);
  view.reset();
  view.get();
  assert.equal(folds, 2);
});

test("two views over the same file keep their own folds", () => {
  write([{ k: "a", v: 5 }]);
  const count = ledgerView<number>(FILE, (rows) => rows.length);
  const sum = ledgerView<number>(FILE, (rows) => (rows as Array<{ v: number }>).reduce((n, r) => n + r.v, 0));
  assert.equal(count.get(), 1);
  assert.equal(sum.get(), 5);
  appendFileSync(PATH, JSON.stringify({ k: "b", v: 7 }) + "\n");
  assert.equal(count.get(), 2);
  assert.equal(sum.get(), 12);
});
