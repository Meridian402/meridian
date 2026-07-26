import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPendingLaunch, pendingLaunchFor, clearPendingLaunch, sweepExpiredLaunches } from "../src/launch/pendingLaunches.js";

/**
 * The channel that carries a signable transaction from an agent's tool call to
 * the user's wallet, since the chat itself can only carry prose.
 *
 * The properties worth pinning are about who can see what. A launch proposal is
 * addressed to exactly one wallet, and the failure that matters is one wallet
 * being shown a transaction meant for another — at which point someone signs
 * something they never asked for.
 */

const A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";

const draft = (creator: string, symbol = "MERD") => ({
  creator,
  chainId: 46630,
  network: "robinhood-testnet",
  name: "Merd Coin",
  symbol,
  style: "marketing",
  tokenAddress: "0x0000000000000000000000000000000000007777",
  explorer: "https://explorer.testnet.chain.robinhood.com/address/0x0000000000000000000000000000000000007777",
  economics: { buyTax: "3%", sellTax: "3%" },
  transaction: { to: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09", data: "0xdeadbeef", value: "0" },
});

test("a launch is readable by the wallet it is addressed to", () => {
  recordPendingLaunch(draft(A));
  const got = pendingLaunchFor(A);
  assert.ok(got);
  assert.equal(got.symbol, "MERD");
  clearPendingLaunch(A);
});

test("one wallet never sees another wallet's launch", () => {
  recordPendingLaunch(draft(A));
  assert.equal(pendingLaunchFor(B), null);
  clearPendingLaunch(A);
});

test("addresses are matched case-insensitively", () => {
  // Wallets, sessions and tool arguments disagree about checksum casing all the
  // time. A case-sensitive key would silently hide the user's own launch.
  recordPendingLaunch(draft(A.toUpperCase()));
  assert.ok(pendingLaunchFor(A.toLowerCase()));
  clearPendingLaunch(A);
});

test("a new launch replaces the old one rather than queueing", () => {
  // Two live proposals means two sign buttons, one of them stale — which is how
  // someone signs the token they just asked to change.
  recordPendingLaunch(draft(A, "FIRST"));
  recordPendingLaunch(draft(A, "SECOND"));
  assert.equal(pendingLaunchFor(A)?.symbol, "SECOND");
  clearPendingLaunch(A);
});

test("clearing removes it — signed or declined, it stops being offered", () => {
  recordPendingLaunch(draft(A));
  clearPendingLaunch(A);
  assert.equal(pendingLaunchFor(A), null);
});

test("clearing a wallet with nothing pending is harmless", () => {
  clearPendingLaunch(B);
  assert.equal(pendingLaunchFor(B), null);
});

test("an expired proposal is not served", () => {
  recordPendingLaunch(draft(A));
  const stored = pendingLaunchFor(A);
  assert.ok(stored);
  // Age it past the TTL rather than waiting 30 real minutes.
  (stored as { createdAt: number }).createdAt = Date.now() - 31 * 60 * 1000;
  assert.equal(pendingLaunchFor(A), null, "a stale proposal must not resurface as a sign prompt");
});

test("the sweep drops expired entries so the map cannot grow forever", () => {
  recordPendingLaunch(draft(A));
  recordPendingLaunch(draft(B));
  assert.equal(sweepExpiredLaunches(Date.now()), 0, "fresh entries must survive");
  assert.equal(sweepExpiredLaunches(Date.now() + 31 * 60 * 1000), 2);
  assert.equal(pendingLaunchFor(A), null);
  assert.equal(pendingLaunchFor(B), null);
});
