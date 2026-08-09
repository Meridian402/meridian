import { test } from "node:test";
import assert from "node:assert/strict";
import { lockVerdict, withHouseWalletLock, houseWalletHolder } from "../src/houseWallet.js";

/**
 * THE FREEZE THAT IS STILL ARMED.
 *
 * withHouseWalletLock is a serial promise chain: `tail = run.then(...)`. If a
 * locked operation never settles, tail never settles, and every future wallet
 * operation queues behind it forever. That is the four-hour freeze of
 * 2026-07-27, and as of the 2026-08-09 audit it was still reachable: 22 of the
 * 34 waitForTransactionReceipt calls in this codebase are unbounded, so one
 * transaction that never mines hangs its caller for good.
 *
 * The obvious fix is wrong and these tests exist partly to record why. Racing
 * fn() against a timeout and releasing the lock does not cancel the hung
 * operation, because a JS promise cannot be cancelled. The original waiter is
 * still live and possibly mid-transaction, so releasing would let the next
 * operation sign against the same nonce — the exact collision this mutex exists
 * to prevent. A timeout that trades a freeze for a nonce race is worse than the
 * freeze.
 *
 * The recovery is therefore to stop the process and let the supervisor restart
 * with persisted state. What is tested here is the ESCALATION decision, kept
 * pure so it can be checked without hanging a lock or killing a test runner.
 */

const MIN = 60 * 1000;
const CEILING = 15 * MIN;

test("an idle lock is idle, and never escalates", () => {
  assert.equal(lockVerdict(null), "idle");
});

test("normal operations do not trip anything", () => {
  assert.equal(lockVerdict(0), "healthy");
  assert.equal(lockVerdict(30 * 1000), "healthy");
  assert.equal(lockVerdict(4 * MIN), "healthy");
});

test("the warning fires before the kill, so a human sees it coming", () => {
  assert.equal(lockVerdict(5 * MIN + 1), "stuck");
  assert.equal(lockVerdict(10 * MIN), "stuck");
  assert.equal(lockVerdict(14 * MIN), "stuck");
});

test("past the ceiling it is unrecoverable", () => {
  assert.equal(lockVerdict(CEILING + 1), "unrecoverable");
  assert.equal(lockVerdict(60 * MIN), "unrecoverable");
  assert.equal(lockVerdict(4 * 60 * MIN), "unrecoverable", "the 2026-07-27 freeze");
});

test("THE HEADROOM INVARIANT: the longest legitimate operation must survive", () => {
  // An inventory liquidation chunks its sells and each chunk can stack a
  // 90-second receipt wait. Six of those back to back is nine minutes of
  // entirely healthy work, and it must never be killed.
  const worstLegitimate = 6 * 90 * 1000;
  assert.notEqual(lockVerdict(worstLegitimate), "unrecoverable");
  // And there must be real daylight between "slow" and "dead", or the ceiling
  // becomes a coin flip on a busy day.
  assert.ok(CEILING > worstLegitimate * 1.5, "ceiling leaves less than 50% headroom over legitimate work");
});

test("escalation is monotonic: it can never de-escalate as time passes", () => {
  const rank = { idle: 0, healthy: 1, stuck: 2, unrecoverable: 3 } as const;
  let prev = 0;
  for (let m = 0; m <= 60; m++) {
    const r = rank[lockVerdict(m * MIN)];
    assert.ok(r >= prev, `verdict went backwards at ${m}m`);
    prev = r;
  }
});

test("the ceiling is configurable, so an incident can widen it without a deploy", () => {
  assert.equal(lockVerdict(20 * MIN, 60 * MIN), "stuck");
  assert.equal(lockVerdict(70 * MIN, 60 * MIN), "unrecoverable");
});

// ── the lock's own guarantees, which the ceiling must not have broken ────────

test("the lock still serializes: a second op waits for the first", async () => {
  const order: string[] = [];
  const a = withHouseWalletLock("first", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
  });
  const b = withHouseWalletLock("second", async () => {
    order.push("b-start");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"], "operations interleaved on the wallet");
});

test("a rejection does not break the chain for the next waiter", async () => {
  await assert.rejects(withHouseWalletLock("boom", async () => { throw new Error("nope"); }));
  const ran = await withHouseWalletLock("after", async () => "ok");
  assert.equal(ran, "ok", "one failed op must not wedge every later one");
  assert.equal(houseWalletHolder(), null, "the holder must be cleared even on failure");
});

test("re-entry still fails loud rather than deadlocking", async () => {
  await assert.rejects(
    withHouseWalletLock("outer", async () => withHouseWalletLock("inner", async () => "never")),
    /re-entered/,
  );
});
