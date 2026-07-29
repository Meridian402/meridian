import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import {
  normalizeSocials,
  validateTokenIdentity,
  ponsSalt,
  ponsLaunchValue,
  describePonsEconomics,
  initialBuyRecipient,
  ZERO_ADDRESS,
  MAX_NAME,
  MAX_SYMBOL,
  type PonsLaunchConfig,
  type PonsDexConfig,
} from "../src/launch/pons.js";

/**
 * Pure units only, no network. These cover the parts of a PONS launch that can
 * be wrong while everything still runs: a struct field left undefined, a value
 * that silently under or overpays, and the one piece of wording a creator will
 * act on, which address actually receives their first buy.
 */

const CREATOR = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const LOCKER = "0x736D76699C26D0d966744cAe304C000d471f7F35" as const;

// The live launchConfig 0 / dexConfig 0, read off the verified factory.
const CONFIG: PonsLaunchConfig = {
  pairToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  graduationThreshold: 4_200_000_000_000_000_000n,
  initialTick: -204200,
  supply: 10n ** 27n,
  maxWalletBps: 500,
  maxTxBps: 550,
  restrictionBlocks: 2,
  reservedFee: 0,
  enabled: true,
  routerRequiresDeadline: false,
};

const DEX: PonsDexConfig = {
  name: "uniswap v3",
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  poolFee: 10000,
  tickSpacing: 200,
  enabled: true,
};

const economics = (over: { feeWallet?: `0x${string}`; initialBuyWei?: bigint } = {}) =>
  describePonsEconomics({
    symbol: "MTEST",
    creator: CREATOR,
    feeWallet: over.feeWallet,
    initialBuyWei: over.initialBuyWei ?? parseEther("0.01"),
    launchFeeWei: parseEther("0.0005"),
    config: CONFIG,
    dex: DEX,
    locker: LOCKER,
    // The locker's live cut of every fee claim, as read on chain today.
    protocolFeeSharePct: 30,
  });

test("the socials normalizer fills all five fields, since the struct has no optionals", () => {
  const s = normalizeSocials({ twitter: "https://x.com/meridian402" });
  assert.deepEqual(s, {
    twitter: "https://x.com/meridian402",
    telegram: "",
    discord: "",
    website: "",
    farcaster: "",
  });
  // An entirely absent socials object still encodes as five empty strings.
  assert.deepEqual(normalizeSocials(), { twitter: "", telegram: "", discord: "", website: "", farcaster: "" });
});

test("name and symbol are trimmed, and empty is rejected", () => {
  assert.deepEqual(validateTokenIdentity("  Meridian Test  ", " MTEST "), { name: "Meridian Test", symbol: "MTEST" });
  assert.throws(() => validateTokenIdentity("", "MTEST"), /name must be/);
  assert.throws(() => validateTokenIdentity("   ", "MTEST"), /name must be/);
  assert.throws(() => validateTokenIdentity("Meridian Test", ""), /symbol must be/);
});

test("over-long name and symbol are rejected rather than silently truncated", () => {
  assert.throws(() => validateTokenIdentity("x".repeat(MAX_NAME + 1), "MTEST"), /name must be/);
  assert.throws(() => validateTokenIdentity("Meridian Test", "y".repeat(MAX_SYMBOL + 1)), /symbol must be/);
  // The boundary itself is allowed.
  assert.equal(validateTokenIdentity("x".repeat(MAX_NAME), "y".repeat(MAX_SYMBOL)).name.length, MAX_NAME);
});

test("the salt is deterministic, so the same request predicts the same token", () => {
  assert.equal(ponsSalt(CREATOR, "Meridian Test", "MTEST"), ponsSalt(CREATOR, "Meridian Test", "MTEST"));
});

test("a different creator, identity or nonce gives a different salt", () => {
  const base = ponsSalt(CREATOR, "Meridian Test", "MTEST");
  assert.notEqual(base, ponsSalt(OTHER, "Meridian Test", "MTEST"));
  assert.notEqual(base, ponsSalt(CREATOR, "Meridian Test 2", "MTEST"));
  assert.notEqual(base, ponsSalt(CREATOR, "Meridian Test", "MTEST2"));
  assert.notEqual(base, ponsSalt(CREATOR, "Meridian Test", "MTEST", "1"));
});

test("value is the launch fee plus the initial buy, since the remainder is swapped", () => {
  const fee = parseEther("0.0005");
  const buy = parseEther("0.25");
  assert.equal(ponsLaunchValue(fee, buy), fee + buy);
});

test("with no initial buy, value is exactly the launch fee", () => {
  // Overpaying here is not harmless: anything above the fee is spent buying.
  const fee = parseEther("0.0005");
  assert.equal(ponsLaunchValue(fee, 0n), fee);
});

test("a negative initial buy is refused rather than encoded", () => {
  assert.throws(() => ponsLaunchValue(parseEther("0.0005"), -1n), /cannot be negative/);
});

test("with no fee wallet, the initial buy goes to the creator", () => {
  const e = economics();
  assert.equal(e.initialBuyGoesTo, CREATOR);
  assert.match(e.initialBuyNote, /creator wallet/);
  assert.ok(e.initialBuyNote.includes(CREATOR));
  assert.ok(e.tradingFees.includes(CREATOR));
  assert.equal(initialBuyRecipient(CREATOR, ZERO_ADDRESS), CREATOR);
});

test("with a fee wallet set, the initial buy goes THERE, not to the creator", () => {
  // The footgun of this launchpad: one field is both the fee payout wallet and
  // the recipient of the creator's own first buy.
  const e = economics({ feeWallet: OTHER });
  assert.equal(e.initialBuyGoesTo, OTHER);
  assert.ok(e.initialBuyNote.includes(OTHER));
  assert.match(e.initialBuyNote, /NOT to the creator wallet/);
  assert.ok(e.tradingFees.includes(OTHER));
  assert.equal(initialBuyRecipient(CREATOR, OTHER), OTHER);
});

test("with no initial buy, the description says no tokens are received", () => {
  const e = economics({ initialBuyWei: 0n, feeWallet: OTHER });
  assert.equal(e.initialBuy, "none");
  assert.match(e.initialBuyNote, /No initial buy/);
});

test("the economics state the terms a creator is actually agreeing to", () => {
  const e = economics();
  assert.match(e.supply, /^1000000000 MTEST/);
  assert.match(e.liquidity, /locks?\s|locked|locker/);
  assert.equal(e.liquidityLockedIn, LOCKER);
  assert.match(e.poolFee, /^1%/);
  assert.equal(e.pairToken, CONFIG.pairToken);
  assert.match(e.launchFee, /^0.0005 ETH/);
});

// The limits are a two-block anti-sniper window on pool buys, not permanent
// token properties. Selling them as permanent would be selling a safety feature
// the token does not have, so the wording is pinned here.
test("the launch window is described as temporary, never as a permanent limit", () => {
  const e = economics();
  assert.match(e.launchWindow, /5%/);
  assert.match(e.launchWindow, /5.5%/);
  assert.match(e.launchWindow, /2 block/);
  assert.match(e.launchWindow, /after that window the token trades with no limits/i);
  assert.doesNotMatch(e.launchWindow, /permanent/i);
});

// PONS keeps a cut of every fee claim and nothing is streamed, so "fees accrue
// to you" would be wrong twice over.
test("trading fees name the protocol cut and that claiming is manual", () => {
  const e = economics();
  assert.match(e.tradingFees, /30%/);
  assert.match(e.tradingFees, /70%/);
  assert.match(e.tradingFees, /collectFees/);
  assert.doesNotMatch(e.tradingFees, /accrue to the creator wallet/);
});
