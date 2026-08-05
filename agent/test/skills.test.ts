import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILLS, listSkills } from "../src/skills/registry.js";
import { mmVerdict, type MMPoolView } from "../src/skills/marketMaking.js";

test("the skills catalog has honest, well-formed entries", () => {
  assert.ok(SKILLS.length >= 3);
  const states = new Set(["live", "prepare-only", "planned"]);
  const custodies = new Set(["read-only", "self-custody-sign", "funded-runner"]);
  for (const s of SKILLS) {
    assert.ok(s.id && s.name && s.summary && s.pricing, `skill ${s.id} is complete`);
    assert.ok(states.has(s.state), `${s.id} has a real state`);
    assert.ok(custodies.has(s.custody), `${s.id} has a real custody model`);
  }
  // The wash-trading boundary is a design invariant: no skill may advertise
  // generating or faking volume.
  const banned = /wash|fake volume|inflate volume|spoof/i;
  for (const s of SKILLS) assert.ok(!banned.test(s.summary), `${s.id} must not sell fake volume`);
  assert.equal(listSkills().length, SKILLS.length);
});

const pool = (over: Partial<MMPoolView>): MMPoolView => ({
  poolId: "0xabc",
  feePct: 1,
  tickSpacing: 200,
  priceEth: 1e-5,
  priceUsd: 0.02,
  activeLiquidity: "1000000",
  quotable: true,
  ...over,
});

test("mm verdict: no pool, no liquidity, quotable", () => {
  assert.equal(mmVerdict([]), "no-eth-pool");
  assert.equal(mmVerdict([pool({ quotable: false, activeLiquidity: "0" })]), "no-liquidity");
  assert.equal(mmVerdict([pool({})]), "quotable");
  assert.equal(mmVerdict([pool({ quotable: false }), pool({ quotable: true })]), "quotable", "one quotable pool is enough");
});
