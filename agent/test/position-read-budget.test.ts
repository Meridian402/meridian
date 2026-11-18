import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liquidityReadsDue, recordLiquidity, EMPTY_RECHECK_MS, EMPTY_CONFIRMATIONS } from "../src/venues/lpPositions.js";

/**
 * THE CLOSED DESK THAT COST EIGHT DOLLARS A DAY TO LOOK AT.
 *
 * Position discovery made two reads for every position NFT the house wallet
 * holds, on every call. The desk never burns a band it empties, so by the close
 * the wallet held 1,574 of them, nearly all empty: 3,148 reads a call. The
 * narrate-only agent loop called it every 30 seconds, and the site's Home page
 * called it again for every open browser tab.
 *
 * 2026-11-16/17, on the provider's own meter, with the record closed and
 * nothing deployed:
 *   376,000 compute units an hour from the loop alone
 *   about 750,000 with one browser tab open on the site
 * A public page that any visitor can use to run up the bill is a fault.
 *
 * The fix reads only what can have changed: a position's pool and range are
 * fixed at mint, and a position this desk has emptied stays empty. The danger
 * in that second sentence is the one this desk has already paid for once
 * (2026-08-09, seven live bands invisible, about $385 unmanaged): a band that
 * is skipped is a band nothing manages. So the tests below are mostly about
 * what must NEVER be skipped.
 */

const HOUR = 3600_000;
const T0 = 1_800_000_000_000;

test("a token never seen before is always read", () => {
  assert.deepEqual(liquidityReadsDue(["1", "2"], new Map(), T0), ["1", "2"]);
});

test("a position that holds liquidity is read on every call: nothing about a live band is cached", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  for (let call = 0; call < 5; call++) {
    assert.deepEqual(liquidityReadsDue(["7"], emptied, T0 + call * 30_000), ["7"]);
    recordLiquidity("7", 123n, T0 + call * 30_000, streak, emptied);
  }
  assert.equal(emptied.has("7"), false);
});

test("ONE zero is not believed: a single wrong answer from one node cannot hide a band", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  recordLiquidity("7", 0n, T0, streak, emptied);
  assert.equal(emptied.has("7"), false, "one zero reading must not mark the token empty");
  assert.deepEqual(liquidityReadsDue(["7"], emptied, T0 + 30_000), ["7"], "so it is read again on the next call");
});

test("a zero followed by liquidity wipes the slate, so the count starts again", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  recordLiquidity("7", 0n, T0, streak, emptied);
  recordLiquidity("7", 500n, T0 + 30_000, streak, emptied);
  recordLiquidity("7", 0n, T0 + 60_000, streak, emptied);
  assert.equal(emptied.has("7"), false, "zero, live, zero is one zero in a row, not two");
});

test("two zeros in a row and the token stops being read, until the recheck window passes", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  assert.equal(EMPTY_CONFIRMATIONS, 2);
  recordLiquidity("7", 0n, T0, streak, emptied);
  recordLiquidity("7", 0n, T0 + 30_000, streak, emptied);
  assert.equal(emptied.get("7"), T0 + 30_000);
  assert.deepEqual(liquidityReadsDue(["7"], emptied, T0 + 60_000), []);
  assert.deepEqual(liquidityReadsDue(["7"], emptied, T0 + 30_000 + EMPTY_RECHECK_MS - 1), []);
  assert.deepEqual(liquidityReadsDue(["7"], emptied, T0 + 30_000 + EMPTY_RECHECK_MS), ["7"], "an emptied token is never trusted for longer than the window");
});

test("the recheck window is short enough to matter and long enough to pay", () => {
  assert.ok(EMPTY_RECHECK_MS <= HOUR, "a refilled position must not go unseen for more than an hour");
  assert.ok(EMPTY_RECHECK_MS >= 10 * 60_000, "rechecking every few minutes would bring the bill back");
});

test("a recheck that finds liquidity puts the token back on every call", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  recordLiquidity("7", 0n, T0, streak, emptied);
  recordLiquidity("7", 0n, T0 + 30_000, streak, emptied);
  const later = T0 + 30_000 + EMPTY_RECHECK_MS;
  recordLiquidity("7", 9n, later, streak, emptied);
  assert.equal(emptied.has("7"), false);
  assert.deepEqual(liquidityReadsDue(["7"], emptied, later + 30_000), ["7"]);
  // and it needs two fresh zeros to be skipped again
  recordLiquidity("7", 0n, later + 30_000, streak, emptied);
  assert.equal(emptied.has("7"), false);
});

test("a recheck that still finds zero renews the skip without needing two more reads", () => {
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  recordLiquidity("7", 0n, T0, streak, emptied);
  recordLiquidity("7", 0n, T0 + 30_000, streak, emptied);
  const later = T0 + 30_000 + EMPTY_RECHECK_MS;
  recordLiquidity("7", 0n, later, streak, emptied);
  assert.equal(emptied.get("7"), later);
  assert.deepEqual(liquidityReadsDue(["7"], emptied, later + 30_000), []);
});

test("THE BUDGET: the closed desk's wallet settles at no per-token reads at all", () => {
  // 1,574 emptied tokens, as the house wallet held on 2026-11-17.
  const ids = Array.from({ length: 1574 }, (_, i) => String(i + 1));
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  const reads: number[] = [];
  for (let call = 0; call < 6; call++) {
    const now = T0 + call * 30_000;
    const due = liquidityReadsDue(ids, emptied, now);
    reads.push(due.length);
    for (const id of due) recordLiquidity(id, 0n, now, streak, emptied);
  }
  assert.deepEqual(reads, [1574, 1574, 0, 0, 0, 0], "two full passes to confirm, then nothing");
});

test("...and one live band among them is still read every single time", () => {
  const ids = Array.from({ length: 50 }, (_, i) => String(i + 1));
  const streak = new Map<string, number>(), emptied = new Map<string, number>();
  for (let call = 0; call < 6; call++) {
    const now = T0 + call * 30_000;
    const due = liquidityReadsDue(ids, emptied, now);
    assert.ok(due.includes("17"), `call ${call}: the live band was skipped`);
    for (const id of due) recordLiquidity(id, id === "17" ? 1000n : 0n, now, streak, emptied);
  }
});

// ---- the properties of the code itself -------------------------------------------------------

const lpSrc = readFileSync(new URL("../src/venues/lpPositions.ts", import.meta.url), "utf8");
const fnStart = lpSrc.indexOf("export async function discoverOwnedPositions");
const fnBody = lpSrc.slice(fnStart, lpSrc.indexOf("\nexport ", fnStart + 1));

test("discovery decides its liquidity reads through the budget, and records what it reads", () => {
  assert.match(fnBody, /liquidityReadsDue\(/);
  assert.match(fnBody, /recordLiquidity\(/);
});

test("the liquidity read is pinned to the same height as the ownership scan", () => {
  const read = fnBody.slice(fnBody.indexOf("getPositionLiquidity"));
  assert.match(read.slice(0, 200), /blockNumber: head/, "an unpinned read lets a lagging node answer 0 for a band minted this block");
});

test("the position's NAME is never cached: the guards pick their positions by it", () => {
  const facts = lpSrc.slice(lpSrc.indexOf("async function factsFor"));
  const body = facts.slice(0, facts.indexOf("\n}\n") + 3);
  assert.doesNotMatch(body, /symbolForToken|SYMBOL_BY_TOKEN/, "a name worked out while the qualifier was cold would stick for the life of the process");
  assert.match(fnBody, /symbolForToken\(stock\)/, "the name is worked out on every call");
});

test("ownership is still checked against balanceOf on every call, before any read is skipped", () => {
  const check = fnBody.indexOf("heldOnChain");
  const budget = fnBody.indexOf("liquidityReadsDue(");
  assert.ok(check > -1 && budget > check, "the read budget must come after the integrity check, never instead of it");
});

test("TRIPWIRE: nothing in src adds liquidity to an existing position", () => {
  // "An emptied position stays empty" holds only because every band is a fresh
  // mint. The day a path increases an existing position, it must call
  // forgetEmptiedPositions() (or stop skipping), and this test is where that
  // conversation starts.
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /INCREASE_LIQUIDITY|increaseLiquidity/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  assert.deepEqual(hits, [], "a path that refills an existing position makes the emptied-position skip unsafe: see src/venues/lpPositions.ts");
});
