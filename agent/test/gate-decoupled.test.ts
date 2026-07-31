import { test } from "node:test";
import assert from "node:assert/strict";

// The holder gate and the credit system are two different access models, and
// they contradict. Credits are metering: start free, then pay for what you use.
// The gate is admission: hold 0.25% of a token's entire supply or you cannot
// use the product at all. Run both and a person must buy their way in and THEN
// pay per message, which makes the free tier unreachable.
//
// They also used to share one switch. merdGateEnabled() keyed off
// MERD_TOKEN_ADDRESS, which is the same variable that enables paying for
// credits in MERD, so turning payments on would have silently turned admission
// control on with it. This file exists so that cannot come back.

const MERD = "0x4663196C0Ad93594907555b2018457695Db8Ccef";

async function load() {
  const mod = await import(`../src/deploy/tokenGate.js?t=${Math.random()}`);
  return mod;
}

test("the gate is off by default", async () => {
  delete process.env.MERIDIAN_HOLDER_GATE;
  const { merdGateEnabled } = await load();
  assert.equal(merdGateEnabled(), false);
});

test("enabling MERD payments does NOT enable the gate", async () => {
  // The exact trap: one variable, two unrelated consequences.
  delete process.env.MERIDIAN_HOLDER_GATE;
  process.env.MERD_TOKEN_ADDRESS = MERD;
  process.env.CREDITS_PACK_STARTER_MERD = "1000000000000000000000";
  const { merdGateEnabled } = await load();
  const { merdCreditsEnabled } = await import(`../src/credits.js?t=${Math.random()}`);
  assert.equal(merdCreditsEnabled(), true, "MERD payments should be live");
  assert.equal(merdGateEnabled(), false, "admission control must NOT come along for the ride");
});

test("the gate turns on only when asked for by name", async () => {
  process.env.MERIDIAN_HOLDER_GATE = "on";
  const { merdGateEnabled } = await load();
  assert.equal(merdGateEnabled(), true);
});

test("anything other than a deliberate 'on' leaves it off", async () => {
  for (const v of ["", " ", "true", "1", "yes", "ON ", "off", "enabled"]) {
    process.env.MERIDIAN_HOLDER_GATE = v;
    const { merdGateEnabled } = await load();
    const expected = v.trim().toLowerCase() === "on";
    assert.equal(merdGateEnabled(), expected, `"${v}" should be ${expected}`);
  }
  delete process.env.MERIDIAN_HOLDER_GATE;
});
