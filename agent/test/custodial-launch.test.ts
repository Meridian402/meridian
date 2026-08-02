import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Custodial launch spends Meridian's own money on a PUBLIC trigger (anyone can
// tweet). The tests are about the guardrails that keep that from being a
// wallet-drain: it must be OFF unless deliberately enabled, it must refuse past
// its caps BEFORE touching the chain, and a bad key must leave it dormant rather
// than crash a public feature.

const dir = mkdtempSync(join(tmpdir(), "meridian-launch-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_LIVE_PRICES = "0";

const FEE_WALLET = "0x00000000000000000000000000000000000000f1";
const OTHER_WALLET = "0x00000000000000000000000000000000000000f2";
// A throwaway test key (well-known, never funded). Only used to prove the
// wallet loads and the enabled/dormant switch works.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function load() {
  return import(`../src/launch/custodialLaunch.js?t=${Math.random()}`);
}

const writeLaunches = (rows: object[]) =>
  writeFileSync(join(dir, "custodial-launches.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

test("dormant by default: no key means no launching", async () => {
  delete process.env.MERD_LAUNCH_WALLET_KEY;
  const { custodialLaunchEnabled, launchWallet, executeCustodialLaunch } = await load();
  assert.equal(custodialLaunchEnabled(), false);
  assert.equal(launchWallet(), null);
  const r = await executeCustodialLaunch({ symbol: "DOGE", name: "Doge", feeWallet: FEE_WALLET, requester: "x1" });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "disabled" });
});

test("a malformed key leaves it OFF, it does not crash the feature", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = "not-a-key";
  const { custodialLaunchEnabled } = await load();
  assert.equal(custodialLaunchEnabled(), false, "a bad key is dormant, never a throw");
});

test("a real key enables it and loads a wallet", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  const { custodialLaunchEnabled, launchWallet } = await load();
  assert.equal(custodialLaunchEnabled(), true);
  assert.match(launchWallet()!.address, /^0x[0-9a-fA-F]{40}$/);
});

test("a bad fee wallet is refused before any chain work", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  writeLaunches([]);
  const { executeCustodialLaunch } = await load();
  const r = await executeCustodialLaunch({ symbol: "DOGE", name: "Doge", feeWallet: "0xnope", requester: "x1" });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "invalid" });
});

test("no requester identity, no launch: a wallet fallback would let one person rotate wallets past the cap", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  writeLaunches([]);
  const { executeCustodialLaunch } = await load();
  const r = await executeCustodialLaunch({ symbol: "DOGE", name: "Doge", feeWallet: FEE_WALLET });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "invalid" });
  assert.match(r.error, /requester identity/);
});

test("the per-launch spend ceiling has a sane default and survives a garbage env value", async () => {
  const { maxLaunchSpendWei } = await load();
  delete process.env.MERD_LAUNCH_MAX_ETH;
  assert.equal(maxLaunchSpendWei(), 20_000_000_000_000_000n, "default is 0.02 ETH");
  process.env.MERD_LAUNCH_MAX_ETH = "not-a-number";
  assert.equal(maxLaunchSpendWei(), 20_000_000_000_000_000n, "garbage falls back, never throws");
  process.env.MERD_LAUNCH_MAX_ETH = "0.005";
  assert.equal(maxLaunchSpendWei(), 5_000_000_000_000_000n);
  delete process.env.MERD_LAUNCH_MAX_ETH;
});

test("caps count attempts, not just landed launches, so a mid-flight death still consumed its slot", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  const now = Date.now();
  writeLaunches([
    { requester: "x9", at: now - 1000, status: "attempt" },
    { requester: "x9", at: now - 900, status: "landed", txHash: "0xabc" }, // outcome row for the same launch
    { requester: "x9", at: now - 500, status: "attempt" },
    { requester: "x9", at: now - 400, status: "reverted", txHash: "0xdef" }, // outcome row, gas spent, no token
  ]);
  const { launchCapStatus } = await load();
  assert.equal(launchCapStatus("x9").requesterToday, 2, "two attempts, two slots consumed; outcome rows do not double-count");
});

test("the global daily cap stops a launch before it spends", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  process.env.LAUNCH_MAX_PER_DAY = "3";
  process.env.LAUNCH_MAX_PER_REQUESTER_PER_DAY = "99";
  // Three launches today by other people fills the global allowance.
  const now = Date.now();
  writeLaunches([
    { requester: OTHER_WALLET, at: now - 1000 },
    { requester: OTHER_WALLET, at: now - 2000 },
    { requester: OTHER_WALLET, at: now - 3000 },
  ]);
  const { executeCustodialLaunch, launchCapStatus } = await load();
  assert.equal(launchCapStatus().globalToday, 3);
  const r = await executeCustodialLaunch({ symbol: "DOGE", name: "Doge", feeWallet: FEE_WALLET, requester: "x1" });
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: "capped" });
  delete process.env.LAUNCH_MAX_PER_DAY;
  delete process.env.LAUNCH_MAX_PER_REQUESTER_PER_DAY;
});

test("the per-requester cap stops a repeat launcher while others can still go", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  process.env.LAUNCH_MAX_PER_DAY = "99";
  process.env.LAUNCH_MAX_PER_REQUESTER_PER_DAY = "1";
  const now = Date.now();
  writeLaunches([{ requester: FEE_WALLET.toLowerCase(), at: now - 1000 }]);
  const { executeCustodialLaunch, launchCapStatus } = await load();
  // The repeat requester is capped...
  assert.equal(launchCapStatus(FEE_WALLET).requesterToday, 1);
  const capped = await executeCustodialLaunch({ symbol: "DOGE", name: "Doge", feeWallet: FEE_WALLET, requester: FEE_WALLET });
  assert.deepEqual({ ok: capped.ok, code: capped.code }, { ok: false, code: "capped" });
  // ...but a different requester is not (they will fail later on the chain, not
  // the cap: the wallet is unfunded, so this proves the cap PASSED, not the send).
  assert.equal(launchCapStatus(OTHER_WALLET).requesterToday, 0);
  delete process.env.LAUNCH_MAX_PER_DAY;
  delete process.env.LAUNCH_MAX_PER_REQUESTER_PER_DAY;
});

test("yesterday's launches do not count against today", async () => {
  process.env.MERD_LAUNCH_WALLET_KEY = TEST_KEY;
  const now = Date.now();
  writeLaunches([
    { requester: FEE_WALLET.toLowerCase(), at: now - 25 * 60 * 60 * 1000 }, // 25h ago
    { requester: OTHER_WALLET, at: now - 26 * 60 * 60 * 1000 },
  ]);
  const { launchCapStatus } = await load();
  assert.equal(launchCapStatus(FEE_WALLET).globalToday, 0, "a day-old launch is outside the window");
});
