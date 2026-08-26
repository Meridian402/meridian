import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { computeMintPlan } from "../src/venues/lpPositions.js";

// The ETH anchor: native ETH is currency0 (address 0x0 sorts first), USDG is
// currency1. This is the only pool shape where the mint must carry msg.value and
// sweep the remainder — every ERC20/ERC20 pool must stay value:0, two actions.
const Q96 = 2 ** 96;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571" as const;
const DESK = "0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe" as const;

// ETH ~= $2500: price_raw = USDG_raw/ETH_raw = 2500e6/1e18 = 2.5e-9.
const PRICE_RAW = 2.5e-9;
const SQRTP = Math.sqrt(PRICE_RAW) * Q96;
const TICK = Math.round(Math.log(PRICE_RAW) / Math.log(1.0001));
const ETH_BAL = 1_000000000000000000n; // 1 ETH
const USDG_BAL = 2500_000000n; // 2500 USDG

const ANCHOR_KEY = { currency0: NATIVE, currency1: USDG, fee: 460, tickSpacing: 9 };

function nativePlan(recipient: `0x${string}` = DESK, extra = {}) {
  return computeMintPlan({ key: ANCHOR_KEY, sqrtP: SQRTP, tick: TICK, widthPct: 20, bal0Raw: ETH_BAL, bal1Raw: USDG_BAL, recipient, nowMs: 1_700_000_000_000, ...extra });
}

function actionsOf(unlockData: Hex): string {
  const [actions] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), unlockData) as [Hex, Hex[]];
  return actions.toLowerCase();
}
function paramsOf(unlockData: Hex): Hex[] {
  const [, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), unlockData) as [Hex, Hex[]];
  return params;
}

test("native mint carries value and a SWEEP; value equals the ETH-side cap", () => {
  const p = nativePlan();
  assert.ok(p.liquidity > 0n, "should build real liquidity");
  assert.equal(p.tx.value, p.amountMax0, "tx.value must be the native-side amountMax");
  assert.ok(p.tx.value > 0n, "the ETH we may spend must be non-zero");
  assert.ok(p.amountMax0 <= ETH_BAL, "never sends more ETH than the wallet holds");
  // MINT_POSITION(0x02) SETTLE_PAIR(0x0d) SWEEP(0x14)
  assert.equal(actionsOf(p.unlockData), "0x020d14", "native path adds a SWEEP action");
});

test("the SWEEP refunds unspent ETH to the recipient (native), not elsewhere", () => {
  const p = nativePlan(DESK);
  const sweep = paramsOf(p.unlockData)[2];
  const [currency, to] = decodeAbiParameters(parseAbiParameters("address, address"), sweep);
  assert.equal((currency as string).toLowerCase(), NATIVE);
  assert.equal((to as string).toLowerCase(), DESK.toLowerCase());
});

test("an ERC20/ERC20 pool stays value:0 with only MINT+SETTLE (native branch inert)", () => {
  const usdgTokenKey = { currency0: USDG, currency1: PONS, fee: 3000, tickSpacing: 60 };
  const p = computeMintPlan({ key: usdgTokenKey, sqrtP: Q96, tick: 0, widthPct: 20, bal0Raw: 1_000_000000n, bal1Raw: 1_000000000000000000000n, recipient: DESK, nowMs: 1_700_000_000_000 });
  assert.equal(p.tx.value, 0n, "no native value on an ERC20 pool");
  assert.equal(actionsOf(p.unlockData), "0x020d", "no SWEEP on an ERC20 pool");
});

test("native mint recipient flows into the position, and is deterministic", () => {
  const a = nativePlan(DESK);
  const b = nativePlan(DESK);
  assert.equal(a.unlockData, b.unlockData, "same inputs, same bytes");
  const other = nativePlan("0x2222222222222222222222222222222222222222");
  assert.notEqual(a.tx.data, other.tx.data, "recipient changes the calldata");
});
