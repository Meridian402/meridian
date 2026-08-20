// One global mutex serializing every operation that signs with the house wallet:
// the LP guard's 5-min tick, the operator's lp-open / lp-close / index-trade
// endpoints, and (if ever enabled) the agent loop's execution. Without it two
// paths could either submit txs concurrently on the same nonce (collision /
// silent replacement) OR interleave a multi-step op — a retile's
// withdraw -> swap -> mint — with an outside swap that shifts the balances
// mid-flight, so the mint prices against a wallet that changed under it.
//
// Operation-level, NOT per-send: each entry point wraps its WHOLE operation.
// The correctness rule is that a locked operation must never itself call another
// locked entry point — a nested acquire would chain behind the op that is
// awaiting it and deadlock forever, freezing all wallet activity. Rather than
// trust that invariant silently, an AsyncLocalStorage flag detects re-entry and
// throws immediately (fail loud, not hang). FIFO ordering via a promise chain; a
// rejection never breaks the chain (the next waiter still runs).
import { AsyncLocalStorage } from "node:async_hooks";

const inLock = new AsyncLocalStorage<string>();
let tail: Promise<unknown> = Promise.resolve();
let holder: string | null = null;
let heldSince = 0;

// A HELD LOCK IS UNRECOVERABLE IN-PROCESS. THE ONLY SAFE EXIT IS TO RESTART.
//
// This lock is a serial promise chain: `tail = run.then(...)`. If a locked
// operation never settles, `tail` never settles, and EVERY future wallet
// operation queues behind it forever. That is the four-hour freeze of
// 2026-07-27, and it is still reachable: 22 of the 34 waitForTransactionReceipt
// calls in this codebase are unbounded, and a transaction that never mines on
// any of them hangs its caller for good.
//
// The obvious fix is wrong. Racing fn() against a timeout and releasing the
// lock does NOT cancel the hung operation, because a JS promise cannot be
// cancelled: the original waiter is still live and may still be mid-transaction.
// Releasing would let the next operation sign against the same nonce while the
// first is in flight, which is the exact collision this mutex exists to prevent.
// A timeout that swaps a freeze for a nonce race is a worse bug than the freeze.
//
// So the honest recovery is to stop the process and let the supervisor restart
// it. That is safe here specifically, and worth stating why:
//   · rotor risk state persists to meme-rotor-state.json and reloads on boot,
//     verified live on the 2026-08-09 deploy ("risk state restored")
//   · on restart the desk re-reads on-chain state, so whatever the pending
//     transaction actually did is simply observed rather than assumed
//   · the queue of stale operations built up behind the stuck lock dies with
//     the process instead of firing all at once on hours-old prices, which is
//     the second half of this failure mode
//
// The ceiling is deliberately far above any legitimate operation. The longest
// real one is an inventory liquidation whose chunked sells could plausibly
// stack several 90-second receipt waits, so anything under ten minutes risks
// killing healthy work. Fifteen bounds the freeze at fifteen minutes instead of
// four hours, without ever firing on a desk that is merely slow.
const LOCK_WARN_MS = 5 * 60 * 1000;
const LOCK_CEILING_MS = Number(process.env.HOUSE_LOCK_CEILING_MS ?? 15 * 60 * 1000);

export type LockVerdict = "idle" | "healthy" | "stuck" | "unrecoverable";

/** Pure so the escalation is testable without hanging a lock or killing a process. */
export function lockVerdict(heldMs: number | null, ceilingMs = LOCK_CEILING_MS): LockVerdict {
  if (heldMs == null) return "idle";
  if (heldMs > ceilingMs) return "unrecoverable";
  if (heldMs > LOCK_WARN_MS) return "stuck";
  return "healthy";
}

setInterval(() => {
  const heldMs = holder ? Date.now() - heldSince : null;
  const verdict = lockVerdict(heldMs);
  if (verdict === "stuck") {
    console.error(`[houseLock] STUCK: "${holder}" has held the house lock for ${Math.round(heldMs! / 60000)}m`);
  } else if (verdict === "unrecoverable") {
    console.error(
      `[houseLock] UNRECOVERABLE: "${holder}" has held the house lock for ${Math.round(heldMs! / 60000)}m, past the ${Math.round(LOCK_CEILING_MS / 60000)}m ceiling. ` +
        `The operation cannot be cancelled and the lock cannot be released safely, so every wallet operation is queued behind it. ` +
        `Exiting so the supervisor restarts: rotor state is persisted and on-chain state is re-read on boot.`,
    );
    process.exit(1);
  }
}, 60 * 1000).unref?.();

// OPERATOR PRIORITY (2026-08-21, built at the operator's midnight question
// "why do we always wait"). The lock is FIFO, and the guards' ticks hold it
// for minutes of RPC-heavy scanning, so an operator's lp-open kept queueing
// behind them until Railway's HTTP edge gave up. Operator-tagged acquisitions
// raise a flag while they wait; every guard checks the flag BEFORE starting
// its next tick and yields the turn. Nothing about safety changes: the FIFO
// chain still serializes every wallet op, the guards just stop starting
// multi-minute holds in front of a queued human.
let operatorWaitingCount = 0;

/** True while an operator-priority request is queued for or holding the lock. */
export function operatorWaiting(): boolean {
  return operatorWaitingCount > 0;
}

export function withHouseWalletLock<T>(label: string, fn: () => Promise<T>, opts?: { operator?: boolean }): Promise<T> {
  const outer = inLock.getStore();
  if (outer) {
    // Called from within an already-locked operation: this would deadlock
    // (it queues behind the op currently awaiting it). Fail loud instead.
    return Promise.reject(
      new Error(
        `house-wallet lock re-entered: "${label}" acquired from inside "${outer}" — this would deadlock. Refactor so locked entry points do not nest.`,
      ),
    );
  }
  if (opts?.operator) operatorWaitingCount += 1;
  const run = tail.then(() =>
    inLock.run(label, async () => {
      holder = label;
      heldSince = Date.now();
      try {
        return await fn();
      } finally {
        holder = null;
        if (opts?.operator) operatorWaitingCount -= 1;
      }
    }),
  );
  tail = run.then(
    () => {},
    () => {},
  );
  return run as Promise<T>;
}

/** The label of the operation currently holding the wallet, or null if idle. */
export function houseWalletHolder(): string | null {
  return holder;
}
