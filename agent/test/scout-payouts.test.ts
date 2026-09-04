import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Merd-pays flow: the treasury key lives on the agent's machine, so the
// backend's job splits into a read (who is owed enough to pay) and a write
// (record a landed tx). The write is the dangerous half: a payout row REDUCES
// what a scout is owed, so recording one on the strength of a claim alone
// would let a buggy or hostile payer zero balances without money moving.
// Everything here exercises that boundary with an injected verifier; the real
// one reads the USDG Transfer out of the receipt.

const DIR = mkdtempSync(join(tmpdir(), "merd-payouts-"));
process.env.MERIDIAN_DATA_DIR = DIR;

const SCOUT_A = "0x00000000000000000000000000000000000000a1";
const SCOUT_B = "0x00000000000000000000000000000000000000b2";
const TX = (n: string): string => `0x${n.repeat(64).slice(0, 64)}`;

let pendingPayouts: typeof import("../src/earn/scout.js").pendingPayouts;
let recordExternalPayout: typeof import("../src/earn/scout.js").recordExternalPayout;
let HOUSE_WALLET: string;

before(async () => {
  // DATA_DIR resolves at import time, so the env must be set before the module
  // loads. Everything below shares one ledger fixture: A is owed $1.20 across
  // two finds, B is owed $0.10, which sits below the $0.50 minimum.
  const scout = await import("../src/earn/scout.js");
  pendingPayouts = scout.pendingPayouts;
  recordExternalPayout = scout.recordExternalPayout;
  ({ HOUSE_WALLET } = await import("../src/merd/wallets.js"));
  const rows = [
    { ts: 1, kind: "scout", wallet: SCOUT_A, status: "accrued", amountUsd: 0.6 },
    { ts: 2, kind: "scout", wallet: SCOUT_A, status: "accrued", amountUsd: 0.6 },
    { ts: 3, kind: "scout", wallet: SCOUT_B, status: "accrued", amountUsd: 0.1 },
  ];
  writeFileSync(join(DIR, "bounties.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});

test("pending payouts lists only balances that clear the minimum, and names its pins", () => {
  const out = pendingPayouts() as { payouts: Array<{ wallet: string; balanceUsd: number }>; treasury: string; usdg: string };
  assert.equal(out.payouts.length, 1, "the $0.10 balance must not be offered for payment");
  assert.equal(out.payouts[0].wallet, SCOUT_A);
  assert.equal(out.payouts[0].balanceUsd, 1.2);
  assert.equal(out.treasury, HOUSE_WALLET, "the payer hard-checks this before signing");
  assert.match(out.usdg, /^0x/, "and this");
});

test("malformed inputs are refused before any verification runs", async () => {
  const verify = async () => {
    throw new Error("must not be called");
  };
  assert.equal((await recordExternalPayout({ wallet: "nope", amountUsd: 1, txHash: TX("a") }, verify)).ok, false);
  assert.equal((await recordExternalPayout({ wallet: SCOUT_A, amountUsd: -1, txHash: TX("a") }, verify)).ok, false);
  assert.equal((await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 1, txHash: "0x123" }, verify)).ok, false);
});

test("a claim above the accrued balance is refused, protecting the scout", async () => {
  const out = await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 5, txHash: TX("b") }, async () => ({
    from: HOUSE_WALLET.toLowerCase(),
    to: SCOUT_A,
    amountUsd: 5,
  }));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /exceeds/);
});

test("a transfer from anywhere but the treasury is refused", async () => {
  const out = await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 1.2, txHash: TX("c") }, async () => ({
    from: SCOUT_B,
    to: SCOUT_A,
    amountUsd: 1.2,
  }));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /not from the treasury/);
});

test("an on-chain amount below the claim is refused", async () => {
  const out = await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 1.2, txHash: TX("d") }, async () => ({
    from: HOUSE_WALLET.toLowerCase(),
    to: SCOUT_A,
    amountUsd: 0.5,
  }));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /below the claimed/);
});

test("a verified payout lands, zeroes the balance, and its hash cannot be replayed", async () => {
  const good = async () => ({ from: HOUSE_WALLET.toLowerCase(), to: SCOUT_A, amountUsd: 1.2 });
  const first = await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 1.2, txHash: TX("e") }, good);
  assert.equal(first.ok, true);

  const after = pendingPayouts() as { payouts: Array<{ wallet: string }> };
  assert.equal(after.payouts.length, 0, "a paid scout leaves the settle-worthy set");

  const replay = await recordExternalPayout({ wallet: SCOUT_A, amountUsd: 1.2, txHash: TX("e") }, good);
  assert.equal(replay.ok, false);
  assert.match(String(replay.error), /already recorded/);
});
