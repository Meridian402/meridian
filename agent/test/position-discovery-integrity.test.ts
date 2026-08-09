import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * THE DAY A DISPLAY PATH ORPHANED $385 OF THE BOOK.
 *
 * discoverOwnedPositions reads ownership from Transfer logs behind an
 * incremental cursor. A log scan can SOFT-FAIL: answer with fewer events than
 * exist, and no error. The old code then committed the cursor unconditionally,
 * so the truncated set was written down as the truth and every later call
 * started after the gap. The loss was permanent for the life of the process,
 * and completely silent.
 *
 * 2026-08-09, measured end to end:
 *   16:44Z  rotor: 9 band(s), $504 working
 *   16:58Z  a deploy restarts the process, clearing the in-memory cursor
 *   16:58Z  the resulting from-genesis scan truncates
 *   16:58Z  /api/proof shows 2 bands worth $121.62
 *   17:0xZ  monitor: "BOOK SHRANK: 9 -> 2 bands, ids now [577897, 577920]"
 *
 * The other seven were still owned on-chain with live liquidity. Nothing could
 * see them, so nothing re-quoted them, collected their fees, or stopped them
 * out. A read bug became a risk bug.
 *
 * There WAS a guard for this, and it only fired when discovery returned exactly
 * zero. Two is not zero, so a 78% loss sailed through a check written for
 * precisely this failure. That is the lesson worth keeping: a guard placed at
 * the boundary instead of on the invariant catches only the tidiest version of
 * the bug.
 *
 * These are source-level assertions rather than behavioural ones because the
 * function is a thin wrapper over RPC calls. They pin the three properties that
 * failed, so a refactor cannot quietly undo them.
 */

const src = readFileSync(new URL("../src/venues/lpPositions.ts", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("export async function discoverOwnedPositions"));
const body = fn.slice(0, fn.indexOf("\nexport ", 1) === -1 ? fn.length : fn.indexOf("\nexport ", 1));

test("the ownership set is verified against balanceOf, the answer that cannot truncate", () => {
  assert.match(body, /balanceOf/, "discovery must cross-check against the chain's own count");
  assert.match(body, /owned\.size\) < heldOnChain|owned\.size < Number\(heldOnChain\)/, "must compare the discovered count to the held count");
});

test("THE REGRESSION: an incomplete scan throws instead of returning a short book", () => {
  const check = body.indexOf("heldOnChain");
  const thrown = body.indexOf("throw new Error", check);
  const committed = body.indexOf("scanCursor.set", check);
  assert.ok(thrown > -1, "an incomplete scan must throw");
  assert.ok(committed > thrown, "the cursor must only be committed AFTER the integrity check passes");
});

test("the guard is on the invariant, not on the zero boundary", () => {
  // The old guard was `if (positions.length === 0)`. A partial result of 2 out
  // of 9 walked straight past it. Any check that only fires at zero is the bug.
  assert.doesNotMatch(
    body,
    /if \(owned\.size === 0\)[\s\S]{0,200}throw/,
    "a zero-only guard cannot catch a partial scan",
  );
});

test("the working set is a copy, so a failed scan cannot half-mutate the cursor", () => {
  assert.match(body, /new Map\(cur\.owned\)/, "must build into a copy of the cursor's set, not mutate it in place");
});

test("the cold scan is chunked, so the response cannot outgrow the client", () => {
  assert.match(src, /SCAN_CHUNK_BLOCKS/, "the from-genesis scan must be chunked");
  assert.match(body, /for \(let from = fromBlock; from <= head/, "the scan must iterate block ranges");
});

test("the chunk size is bounded and sane", () => {
  const m = src.match(/const SCAN_CHUNK_BLOCKS = ([\d_]+)n;/);
  assert.ok(m, "chunk size must be declared");
  const n = Number(m![1].replace(/_/g, ""));
  assert.ok(n >= 100_000, `chunk of ${n} blocks would make a cold scan take forever`);
  assert.ok(n <= 5_000_000, `chunk of ${n} blocks risks the same oversized response it exists to prevent`);
});
