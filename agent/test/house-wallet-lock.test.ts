import { test } from "node:test";
import assert from "node:assert/strict";
import { withHouseWalletLock, houseWalletHolder } from "../src/houseWallet.js";

/**
 * withHouseWalletLock is the only thing between two concurrent signers and a
 * nonce collision: every path that moves house-wallet money (the LP guard's
 * 5-minute tick, lp-open, lp-close, index trades) funnels through it. Three
 * properties carry all of that weight. Operations must run one at a time in
 * submission order, a thrown operation must still release the lock (or one
 * bad RPC call freezes every later money movement forever), and a nested
 * acquire must throw instead of queueing behind the op that is awaiting it
 * (the documented fail-loud contract). None of these regress visibly in dev;
 * they regress as a hung wallet in production, so they are pinned here.
 *
 * Every test carries a timeout because the failure mode under test IS a hang:
 * a regression should fail the run, not freeze it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "operations submitted together run one at a time, in submission order",
  { timeout: 5000 },
  async () => {
    // The first-submitted op is deliberately the slowest and the last is
    // instantaneous: any concurrent or last-in-first-out implementation would
    // interleave the log, so passing here requires strict FIFO serialization.
    const log: string[] = [];
    const a = withHouseWalletLock("a", async () => {
      log.push("a:start");
      assert.equal(houseWalletHolder(), "a", "the holder label must name the running op");
      await sleep(25);
      log.push("a:end");
    });
    const b = withHouseWalletLock("b", async () => {
      log.push("b:start");
      await sleep(10);
      log.push("b:end");
    });
    const c = withHouseWalletLock("c", async () => {
      log.push("c:start");
      log.push("c:end");
    });
    await Promise.all([a, b, c]);
    assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    assert.equal(houseWalletHolder(), null, "an idle lock must report no holder");
  },
);

test(
  "a thrown operation rejects its own caller but releases the lock for the next",
  { timeout: 5000 },
  async () => {
    const boom = new Error("rpc fell over mid-operation");
    // The follow-up is queued BEFORE the failure lands, so this pins the
    // stronger claim: a waiter already chained behind a rejecting op still runs.
    const doomed = withHouseWalletLock("doomed", async () => {
      throw boom;
    });
    const queued = withHouseWalletLock("queued-behind-the-failure", async () => "still alive");
    await assert.rejects(doomed, (err: unknown) => err === boom, "the caller must see its own error, unswallowed");
    assert.equal(await queued, "still alive");
    assert.equal(houseWalletHolder(), null);
  },
);

test(
  "re-entering the lock from inside a held operation throws instead of deadlocking",
  { timeout: 5000 },
  async () => {
    let innerRan = false;
    await withHouseWalletLock("outer-op", async () => {
      // This await completing at all is the point: a nested acquire that
      // queued instead of throwing would chain behind outer-op, which is
      // awaiting it, and hang here forever.
      await assert.rejects(
        withHouseWalletLock("inner-op", async () => {
          innerRan = true;
        }),
        (err: unknown) =>
          err instanceof Error &&
          /re-entered/.test(err.message) &&
          /inner-op/.test(err.message) &&
          /outer-op/.test(err.message),
        "the error must say re-entry happened and name both operations",
      );
    });
    assert.equal(innerRan, false, "the nested operation must never execute");
    // The refused re-entry must not have poisoned the chain for later money movement.
    assert.equal(await withHouseWalletLock("after-re-entry", async () => "ran"), "ran");
    assert.equal(houseWalletHolder(), null);
  },
);
