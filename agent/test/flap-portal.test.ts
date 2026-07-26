import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseEther } from "viem";
import {
  buildStandardLaunch,
  mineVanitySalt,
  predictTokenAddress,
  PORTAL_ABI,
  DexThresh,
  MigratorType,
  TokenVersion,
  FLAP_ROBINHOOD_TESTNET as DEP,
} from "../src/launch/flapPortal.js";

/**
 * These cover the failures that are silent — the ones where the code runs, the
 * transaction sends, and the wrong thing happens on-chain.
 *
 * The expensive lesson is baked into the first test: Flap's general docs call
 * newTokenV6 the "unified entry point for all token types", but on Robinhood
 * Chain the non-tax path is not implemented there and reverts FeatureDisabled()
 * (0xac5f6092). Only a testnet simulation caught it. A unit test cannot reach
 * the chain, so it pins the entry point instead.
 */

const CREATOR = "0x1111111111111111111111111111111111111111" as const;
const req = { name: "Meridian Test", symbol: "MTEST", meta: "bafkreiplaceholder", quoteAmt: 0n, creator: CREATOR };

test("standard launches go through newTokenV5, not newTokenV6", () => {
  const built = buildStandardLaunch(req, DEP);
  const decoded = decodeFunctionData({ abi: PORTAL_ABI, data: built.data });
  assert.equal(decoded.functionName, "newTokenV5");
});

test("the predicted address carries the 8888 vanity suffix Flap requires", () => {
  const built = buildStandardLaunch(req, DEP);
  assert.ok(built.predictedToken.toLowerCase().endsWith("8888"), `got ${built.predictedToken}`);
});

test("the mined salt actually reproduces the predicted address", () => {
  // If these ever disagree, the token deploys to an address we did not predict
  // and every downstream reference (ledger, agent reply, explorer link) is wrong.
  const built = buildStandardLaunch(req, DEP);
  assert.equal(predictTokenAddress(built.salt, DEP.tokenImplStandard, DEP.portal), built.predictedToken);
});

test("msg.value must equal quoteAmt — the contract requires it", () => {
  const buy = parseEther("0.25");
  const built = buildStandardLaunch({ ...req, quoteAmt: buy }, DEP);
  assert.equal(built.value, buy);
  const [params] = decodeFunctionData({ abi: PORTAL_ABI, data: built.data }).args as [Record<string, unknown>];
  assert.equal(params.quoteAmt, buy);
});

test("a standard launch is genuinely non-tax: every tax lever reads zero", () => {
  const [params] = decodeFunctionData({ abi: buildAbi(), data: buildStandardLaunch(req, DEP).data }).args as [
    Record<string, bigint | number>,
  ];
  for (const field of ["taxRate", "mktBps", "deflationBps", "dividendBps", "lpBps", "taxDuration"]) {
    assert.equal(Number(params[field]), 0, `${field} must be 0 on a standard token`);
  }
});

test("Robinhood-mandated parameters are pinned", () => {
  const [params] = decodeFunctionData({ abi: buildAbi(), data: buildStandardLaunch(req, DEP).data }).args as [
    Record<string, unknown>,
  ];
  // Any other migrator reverts on this chain; any other threshold silently
  // changes when the token graduates.
  assert.equal(params.migratorType, MigratorType.V2);
  assert.equal(params.dexThresh, DexThresh.FOUR_FIFTHS);
  assert.equal(params.quoteToken, "0x0000000000000000000000000000000000000000"); // native ETH
  assert.equal(params.beneficiary, CREATOR); // never us
});

test("enum values match Flap's declaration order", () => {
  // Encoded as uint8; an off-by-one here launches something else entirely.
  assert.equal(DexThresh.FOUR_FIFTHS, 1);
  assert.equal(MigratorType.V2, 1);
  assert.equal(TokenVersion.V2_PERMIT, 2);
  assert.equal(TokenVersion.TAXED_V3, 6);
});

test("bad input is rejected before any salt is mined", () => {
  assert.throws(() => buildStandardLaunch({ ...req, name: "" }, DEP), /name must be/);
  assert.throws(() => buildStandardLaunch({ ...req, symbol: "" }, DEP), /symbol must be/);
  assert.throws(() => buildStandardLaunch({ ...req, meta: "  " }, DEP), /meta/);
  assert.throws(() => buildStandardLaunch({ ...req, creator: "nope" as never }, DEP), /creator/);
});

test("a 4-hex vanity suffix is cheap enough to mine inline", () => {
  const mined = mineVanitySalt("8888", DEP.tokenImplStandard, DEP.portal);
  assert.ok(mined.address.toLowerCase().endsWith("8888"));
  // ~65k expected iterations; generous ceiling so this never flakes in CI.
  assert.ok(mined.iterations < 2_000_000, `took ${mined.iterations} iterations`);
});

test("a malformed suffix fails loudly instead of mining forever", () => {
  assert.throws(() => mineVanitySalt("888", DEP.tokenImplStandard, DEP.portal), /exactly 4 hex/);
  assert.throws(() => mineVanitySalt("zzzz", DEP.tokenImplStandard, DEP.portal), /exactly 4 hex/);
});

/** The ABI as the module defines it — kept local so the test decodes what ships. */
function buildAbi() {
  return PORTAL_ABI;
}
