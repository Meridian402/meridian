import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLaunchInput, buildLaunchTokenTx, isGraduated, USDG_PAIR, PONS_V2 } from "../src/launch/ponsV2.js";
import { launchSalt } from "../src/launch/prepare.js";

const TEAM = "0x3333333333333333333333333333333333333333" as const;
const SPLITTER = "0x4444444444444444444444444444444444444444" as const;
const ECON = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SALT = ("0x" + "cd".repeat(32)) as `0x${string}`;

const goodInput = { name: "Test Agent", symbol: "tagt", description: "an agent that does things" };

test("validate: normalizes symbol to caps and fills defaults", () => {
  const v = validateLaunchInput(goodInput);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.clean.symbol, "TAGT");
    assert.equal(v.clean.creatorTaxBps, 0);
    assert.equal(v.clean.buybackEnabled, false);
    assert.equal(v.clean.socials.twitter, "");
  }
});

test("validate: rejects bad names, symbols, taxes, logos", () => {
  assert.equal(validateLaunchInput({ ...goodInput, name: "" }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, symbol: "WAY TOO LONG SYMBOL" }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, symbol: "no!" }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, creatorTaxBps: 1001 }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, creatorTaxBps: 2.5 }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, logo: "not-a-url" }).ok, false);
  assert.equal(validateLaunchInput({ ...goodInput, description: "x".repeat(501) }).ok, false);
});

function tx(overrides: Partial<Parameters<typeof buildLaunchTokenTx>[0]> = {}) {
  const v = validateLaunchInput(goodInput);
  assert.ok(v.ok);
  return buildLaunchTokenTx({
    clean: (v as { ok: true; clean: never }).clean,
    team: TEAM,
    splitter: SPLITTER,
    launchFeeWei: 500000000000000n,
    expectedEconomics: ECON,
    salt: SALT,
    ...overrides,
  });
}

test("launch tx targets the PONS factory and carries the launch fee as value", () => {
  const t = tx();
  assert.equal(t.to, PONS_V2.factory);
  assert.equal(t.value, 500000000000000n);
});

test("launch tx is deterministic and encodes the splitter as fee recipient", () => {
  assert.equal(tx().data, tx().data);
  assert.ok(tx().data.toLowerCase().includes(SPLITTER.slice(2).toLowerCase()));
  assert.ok(tx().data.toLowerCase().includes(USDG_PAIR.slice(2).toLowerCase()));
});

test("different splitter changes the calldata (recipient really flows through)", () => {
  const other = tx({ splitter: "0x5555555555555555555555555555555555555555" });
  assert.notEqual(tx().data, other.data);
});

test("graduation verdict: sweptAt stamps it, existence required", () => {
  assert.equal(isGraduated({ sweptAt: 0n, exists: true }), false);
  assert.equal(isGraduated({ sweptAt: 1787000000n, exists: true }), true);
  assert.equal(isGraduated({ sweptAt: 1787000000n, exists: false }), false);
});

test("launch salt is stable for same inputs, distinct across time and teams", () => {
  const a = launchSalt(TEAM, "TAGT", 1_700_000_000_000);
  assert.equal(a, launchSalt(TEAM, "TAGT", 1_700_000_000_000));
  assert.notEqual(a, launchSalt(TEAM, "TAGT", 1_700_000_000_001));
  assert.notEqual(a, launchSalt(SPLITTER, "TAGT", 1_700_000_000_000));
});
