// The bridge between an agent's tool call and the user's wallet.
//
// The chat is a TEXT stream; a transaction is structured data. When an agent
// prepares a launch, the tool's JSON gets flattened into the model's prose and
// streamed to the user as words — there is no channel for "here is a payload to
// sign". Parsing it back out of the stream would be brittle in the worst way:
// it works until the model paraphrases the JSON instead of quoting it, and then
// it silently stops offering the button.
//
// So the tool stashes the built transaction here, keyed by the creator wallet,
// and the frontend asks for it over an authenticated route. The prose stays
// prose; the payload travels as a payload.
//
// In-memory on purpose. This is a short-lived proposal, not a record: if the
// process restarts the user asks their agent again, which costs one message.
// Same reasoning as the ensure/session caches in deploy/myAgent.ts.

/**
 * Which launchpad the transaction goes to. The two venues behave differently
 * enough (bonding curve vs. a locked v3 position from block one) that a UI
 * showing "sign this launch" without naming the venue would be hiding the most
 * important thing about it.
 */
export type LaunchVenue = "pons" | "flap";

export interface PendingLaunch {
  /** Lowercased wallet that must sign. */
  creator: string;
  venue: LaunchVenue;
  chainId: number;
  network: string;
  name: string;
  symbol: string;
  style: string;
  /** Address the token will land at — deterministic, already simulated. */
  tokenAddress: string;
  explorer: string;
  /** Plain-language economics, so the UI can show what is being signed. */
  economics: unknown;
  transaction: { to: string; data: string; value: string };
  createdAt: number;
}

// Long enough to read the terms and think; short enough that a proposal from an
// hour ago doesn't reappear as a surprise "sign this" card. The calldata itself
// never expires on-chain, so this is a UX bound, not a safety one.
const TTL_MS = 30 * 60 * 1000;

const pending = new Map<string, PendingLaunch>();

const key = (address: string) => address.toLowerCase();

/**
 * Record a prepared launch for a wallet, replacing any earlier one.
 *
 * Replace rather than queue: a user who asks their agent to adjust the tax rate
 * means the previous proposal is dead, and showing them two sign buttons — one
 * of them stale — is how someone signs the wrong token.
 */
export function recordPendingLaunch(launch: Omit<PendingLaunch, "createdAt" | "venue"> & { venue?: LaunchVenue }): void {
  // Venue defaults to flap because that is the only venue that existed when
  // this record was introduced, so an older caller that omits it is describing
  // a Flap launch, not an unknown one. Every reader still sees a venue.
  pending.set(key(launch.creator), {
    ...launch,
    venue: launch.venue ?? "flap",
    creator: key(launch.creator),
    createdAt: Date.now(),
  });
}

/** The wallet's live proposal, or null. Expired entries are dropped on read. */
export function pendingLaunchFor(address: string): PendingLaunch | null {
  const k = key(address);
  const found = pending.get(k);
  if (!found) return null;
  if (Date.now() - found.createdAt > TTL_MS) {
    pending.delete(k);
    return null;
  }
  return found;
}

/** Clear after signing, or when the user declines. */
export function clearPendingLaunch(address: string): void {
  pending.delete(key(address));
}

/** Test seam + a guard against the map growing without bound in a long process. */
export function sweepExpiredLaunches(now = Date.now()): number {
  let dropped = 0;
  for (const [k, v] of pending) {
    if (now - v.createdAt > TTL_MS) {
      pending.delete(k);
      dropped++;
    }
  }
  return dropped;
}
