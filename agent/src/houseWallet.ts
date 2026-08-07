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

// The stuck-holder watchdog: when the desk freezes behind this lock, the one
// fact that matters is WHO is holding it. Names the holder and its age every
// minute once it passes five, loudly.
setInterval(() => {
  if (holder && Date.now() - heldSince > 5 * 60 * 1000) {
    console.error(`[houseLock] STUCK: "${holder}" has held the house lock for ${Math.round((Date.now() - heldSince) / 60000)}m`);
  }
}, 60 * 1000).unref?.();

export function withHouseWalletLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
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
  const run = tail.then(() =>
    inLock.run(label, async () => {
      holder = label;
      heldSince = Date.now();
      try {
        return await fn();
      } finally {
        holder = null;
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
