import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The daily scout cap exists to bound model spend, not to punish a user for
// our own outage. A live 429 storm on the search provider made every run die
// at the gateway timeout, and because the attempt is recorded BEFORE the model
// runs, three failures locked the wallet out for the day having earned nothing.

const DIR = mkdtempSync(join(tmpdir(), "merd-scout-cap-"));
process.env.MERIDIAN_DATA_DIR = DIR;

const W = "0x00000000000000000000000000000000000000aa";
let scoutAllowed: typeof import("../src/earn/scout.js").scoutAllowed;

const write = (rows: object[]) =>
  writeFileSync(join(DIR, "bounties.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

before(async () => {
  ({ scoutAllowed } = await import("../src/earn/scout.js"));
});

const now = () => Date.now();

test("three real attempts uses up the day", () => {
  write([
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
  ]);
  assert.equal(scoutAllowed(W).ok, false, "the cap must still bind on genuine runs");
});

test("attempts voided by an infrastructure failure are given back", () => {
  // Same three attempts, but every one died before reaching the model.
  write([
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "voided", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "voided", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "voided", amountUsd: 0 },
  ]);
  assert.equal(scoutAllowed(W).ok, true, "a user must not be locked out by our own outage");
});

test("a mix counts only the runs that actually reached the model", () => {
  write([
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "accrued", amountUsd: 0.1, name: "Real Find" },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "voided", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
  ]);
  // Three attempts, one voided, so two count and one run is left.
  assert.equal(scoutAllowed(W).ok, true);
});

test("another wallet's voids never top up your allowance", () => {
  const other = "0x00000000000000000000000000000000000000bb";
  write([
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: other, status: "voided", amountUsd: 0 },
    { ts: now(), kind: "scout", wallet: other, status: "voided", amountUsd: 0 },
  ]);
  assert.equal(scoutAllowed(W).ok, false, "voids are per wallet, never a shared pool");
});

test("yesterday's exhausted allowance does not follow you into today", () => {
  const old = Date.now() - 25 * 60 * 60 * 1000;
  write([
    { ts: old, kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: old, kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
    { ts: old, kind: "scout", wallet: W, status: "attempt", amountUsd: 0 },
  ]);
  assert.equal(scoutAllowed(W).ok, true);
});
