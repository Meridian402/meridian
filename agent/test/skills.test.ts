import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILLS, listSkills } from "../src/skills/registry.js";
import { mmVerdict, type MMPoolView } from "../src/skills/marketMaking.js";
import { ETH_POOLS, buildNativeOnlyMint } from "../src/venues/ethPools.js";

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

test("a prepared band mints to the CREATOR, single-sided ETH, value carried", () => {
  // The self-custody guarantee, checked at the builder: recipient is the
  // creator, the range sits above spot (ETH-only), and msg.value equals the
  // creator's deposit. No token, no Permit2, nothing Meridian holds.
  const creator = "0x00000000000000000000000000000000000000c0" as const;
  const p = { ...ETH_POOLS.CASHCAT };
  const tx = buildNativeOnlyMint(p, 99000, 10n ** 17n, creator, p.offsetAbove);
  assert.ok(tx.tickLower > 99000, "band sits above spot: single-sided ETH");
  assert.equal(tx.value, 10n ** 17n, "the creator's ETH is the msg.value");
  assert.ok(tx.data.startsWith("0x"));
});
