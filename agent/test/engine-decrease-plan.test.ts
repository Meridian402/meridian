import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDecreasePlan } from "../src/venues/lpPositions.js";

const C0 = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const; // USDG
const C1 = "0x39dBED3a2bd333467115dE45665cC57F813C4571" as const; // PONS
const DESK = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe" as const;
const USER = "0x2222222222222222222222222222222222222222" as const;
const NOW = 1_700_000_000_000;

const plan = (liquidity: bigint, recipient: `0x${string}` = DESK, tokenId = "894595") =>
  computeDecreasePlan({ currency0: C0, currency1: C1, tokenId, liquidity, recipient, nowMs: NOW });

test("targets the position manager with a now+300s deadline", () => {
  const p = plan(0n);
  assert.equal(p.tx.to.toLowerCase(), "0x58daec3116aae6d93017baaea7749052e8a04fa7");
  assert.equal(p.deadline, BigInt(1_700_000_000 + 300));
});

test("identical inputs are byte-identical (deterministic, no drift)", () => {
  assert.equal(plan(0n).tx.data, plan(0n).tx.data);
});

test("collect (0 liquidity) and close (full liquidity) produce different calldata", () => {
  assert.notEqual(plan(0n).tx.data, plan(123456789n).tx.data);
});

test("the recipient flows into the take: desk and user get different bytes, each containing their address", () => {
  const desk = plan(0n, DESK);
  const user = plan(0n, USER);
  assert.notEqual(desk.tx.data, user.tx.data);
  assert.ok(desk.tx.data.toLowerCase().includes(DESK.slice(2).toLowerCase()));
  assert.ok(user.tx.data.toLowerCase().includes(USER.slice(2).toLowerCase()));
});

test("the tokenId is encoded into the decrease", () => {
  assert.notEqual(plan(0n, DESK, "1"). tx.data, plan(0n, DESK, "2").tx.data);
});
