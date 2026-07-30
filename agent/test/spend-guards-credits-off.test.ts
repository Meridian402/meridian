import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The regression this file exists for: the daily spend ceilings used to be folded
// from credits.jsonl spend rows, so MERIDIAN_CREDITS=off wrote no rows, the fold
// saw an empty window, and both ceilings went inert. The kill switch and the
// escape hatch cancelled each other out, which meant the one setting an operator
// would reach for during an incident was the setting that removed the backstop.
//
// Credits OFF is the whole point of these tests. The modules resolve their data
// dir at import time, so the env and the temp dir must both be set before the
// dynamic imports below.
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "merd-spend-off-"));
process.env.MERIDIAN_CREDITS = "off";
process.env.CHAT_SPEND_CACHE_MS = "0"; // refold every call, so assertions see the file
delete process.env.CHAT_MAX_TURNS_PER_DAY;
delete process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY;

const { trySpend, creditsEnforced, balanceOf } = await import("../src/credits.js");
const { spendWindow, resetSpendWindow, foldSpend } = await import("../src/spendGuards.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

test("enforcement really is off in this file, so the regression is under test", () => {
  assert.equal(creditsEnforced(), false);
});

test("a turn with credits OFF still lands in the spend window", () => {
  resetSpendWindow();
  const before = spendWindow().total;
  const r = trySpend(WALLET);
  assert.equal(r.ok, true, "credits off must never block a turn");
  resetSpendWindow();
  assert.equal(spendWindow().total, before + 1, "the ceiling would be inert if this failed");
});

test("the turn is attributed to the wallet, so the per-wallet ceiling still bites", () => {
  resetSpendWindow();
  const mine = spendWindow().byWallet.get(WALLET.toLowerCase()) ?? 0;
  trySpend(WALLET);
  trySpend(WALLET);
  resetSpendWindow();
  assert.equal(spendWindow().byWallet.get(WALLET.toLowerCase()), mine + 2);
});

test("metering does not mint credits: balance is untouched by turns", () => {
  // The reason turns live in their own file. credits.jsonl's fold treats any kind
  // other than "spend" as credits coming IN, so a turn row written there would
  // hand out free balance on every message.
  const before = balanceOf(OTHER);
  trySpend(OTHER);
  trySpend(OTHER);
  assert.equal(balanceOf(OTHER), before, "a metered turn must not change the balance");
});

test("the fold counts turn rows and ignores money rows", () => {
  const since = 1_000;
  const rows = [
    { wallet: "0xa", kind: "turn", at: 2_000 },
    { wallet: "0xa", kind: "spend", at: 2_000 }, // legacy row, still counted
    { wallet: "0xa", kind: "grant", at: 2_000 }, // money in, never a turn
    { wallet: "0xa", kind: "purchase", at: 2_000 }, // money in, never a turn
    { wallet: "0xb", kind: "turn", at: 500 }, // before the window
  ];
  const w = foldSpend(rows, since);
  assert.equal(w.total, 2, "grant and purchase must not count as model spend");
  assert.equal(w.byWallet.get("0xa"), 2);
  assert.equal(w.byWallet.get("0xb"), undefined, "outside the window");
});
