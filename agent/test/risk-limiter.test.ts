import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The RiskLimiter and the wallet-op circuit breaker are the only things that
 * bound what a buggy loop can spend: the clamp caps a single trade, the
 * rolling-24h ledger caps a day, and the breaker halts ALL money movement when
 * op count or notional runs away. The old in-memory counter reset on every
 * restart, which is exactly how a redeploy-happy day escapes a "daily" cap, so
 * the property under test throughout is that the LEDGER FILE is the memory and
 * the process is disposable.
 *
 * Caps and the data dir are read at module load, so they are pinned in the
 * environment before the dynamic import below. The subprocess test at the
 * bottom exists because "0" is a real value for every knob here (Number(...),
 * not ||), and treating 0 as "unset" is the documented footgun.
 */
process.env.AGENT_MAX_TRADE_USD = "100";
process.env.AGENT_MAX_DAILY_USD = "250";
process.env.MERIDIAN_MAX_DAILY_WALLET_OPS = "5";
process.env.MERIDIAN_MAX_DAILY_NOTIONAL_USD = "1000";
const dataDir = mkdtempSync(join(tmpdir(), "risk-limiter-"));
process.env.MERIDIAN_DATA_DIR = dataDir;
const { RiskLimiter, guardWalletOp, recordWalletOp } = await import("../src/risk.js");

const LEDGER = join(dataDir, "wallet-ledger.jsonl");
const clearLedger = () => writeFileSync(LEDGER, "");
const HOUR = 60 * 60 * 1000;

test("the per-trade clamp holds, and a missing size means the maximum, never zero", () => {
  const risk = new RiskLimiter();
  assert.equal(risk.size(50), 50);
  assert.equal(risk.size(500), 100);
  // 0 and negative mean "no size given": the caller gets the maximum trade,
  // not a zero-dollar no-op that would read as success.
  assert.equal(risk.size(0), 100);
  assert.equal(risk.size(-25), 100);
});

test("the daily cap refuses strictly over the line, not at it", () => {
  clearLedger();
  const risk = new RiskLimiter();
  risk.record(100);
  risk.record(100);
  assert.equal(risk.check(50).ok, true, "exactly at the $250 cap is still allowed");
  const over = risk.check(51);
  assert.equal(over.ok, false);
  assert.match(over.reason ?? "", /daily trade limit reached/);
});

test("spend survives an instance swap, because the ledger is the memory", () => {
  // Continues from the $200 recorded above: a brand-new limiter over the same
  // data dir must see it. This is the property the old in-memory counter broke.
  assert.equal(new RiskLimiter().spentTodayUsd, 200);
});

test("the window rolls: a 25-hour-old trade is forgotten, a 23-hour-old one counts", () => {
  clearLedger();
  const now = Date.now();
  appendFileSync(LEDGER, JSON.stringify({ at: now - 25 * HOUR, usd: 999, kind: "trade" }) + "\n");
  appendFileSync(LEDGER, JSON.stringify({ at: now - 23 * HOUR, usd: 40, kind: "trade" }) + "\n");
  assert.equal(new RiskLimiter().spentTodayUsd, 40);
});

test("a corrupt ledger line is skipped, never fatal", () => {
  clearLedger();
  appendFileSync(LEDGER, "not json at all\n");
  appendFileSync(LEDGER, JSON.stringify({ at: Date.now(), usd: 30, kind: "trade" }) + "\n");
  assert.equal(new RiskLimiter().spentTodayUsd, 30);
});

test("the breaker counts every wallet op, trades and LP alike, and opens at the cap", () => {
  clearLedger();
  recordWalletOp(10);
  recordWalletOp(10);
  recordWalletOp(10);
  new RiskLimiter().record(10);
  assert.doesNotThrow(() => guardWalletOp("probe"), "four ops of five are under the cap");
  recordWalletOp(10);
  assert.throws(() => guardWalletOp("probe"), /circuit breaker OPEN/);
});

test("the breaker opens on notional AT the cap: >= is the contract, not >", () => {
  clearLedger();
  recordWalletOp(600);
  recordWalletOp(399);
  assert.doesNotThrow(() => guardWalletOp("probe"), "$999 of $1000 still passes");
  recordWalletOp(1);
  assert.throws(() => guardWalletOp("probe"), /circuit breaker OPEN/);
});

test("a cap of 0 is zero allowance, not unset", { timeout: 60000 }, () => {
  // Every knob reads Number(...), so 0 must mean "nothing moves", and that can
  // only be proven in a fresh process because the cap binds at module load.
  const freshDir = mkdtempSync(join(tmpdir(), "risk-limiter-zero-"));
  const agentDir = new URL("..", import.meta.url).pathname;
  const probe =
    "import(process.env.RISK_MOD).then(m => { try { m.guardWalletOp('probe'); console.log('NO-THROW'); } catch { console.log('THREW'); } });";
  const out = spawnSync("npx", ["tsx", "--eval", probe], {
    cwd: agentDir,
    encoding: "utf8",
    timeout: 45000,
    env: {
      ...process.env,
      RISK_MOD: new URL("../src/risk.ts", import.meta.url).href,
      MERIDIAN_MAX_DAILY_WALLET_OPS: "0",
      MERIDIAN_DATA_DIR: freshDir,
    },
  });
  assert.match(out.stdout, /THREW/, "an empty ledger must already be over a cap of zero");
});
