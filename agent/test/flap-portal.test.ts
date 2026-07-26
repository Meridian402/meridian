import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseEther } from "viem";
import {
  buildStandardLaunch,
  buildTaxLaunch,
  mineVanitySalt,
  predictTokenAddress,
  PORTAL_ABI,
  DexThresh,
  MigratorType,
  TokenVersion,
  LAUNCH_STYLES,
  MIN_SHARE_BALANCE,
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
  assert.throws(() => buildStandardLaunch({ ...req, creator: "nope" as never }, DEP), /creator/);
});

// --- tax tokens --------------------------------------------------------------

test("every tax style targets the 7777 suffix and the V6 entry point", () => {
  for (const style of ["marketing", "dividend", "deflationary", "liquidity"] as const) {
    const built = buildTaxLaunch({ ...req, style }, DEP);
    assert.ok(built.predictedToken.toLowerCase().endsWith("7777"), `${style} got ${built.predictedToken}`);
    assert.equal(decodeFunctionData({ abi: PORTAL_ABI, data: built.data }).functionName, "newTokenV6", style);
  }
});

test("each style routes tax where its name says it does", () => {
  const routed = (style: "marketing" | "dividend" | "deflationary" | "liquidity") => {
    const [p] = decodeFunctionData({ abi: PORTAL_ABI, data: buildTaxLaunch({ ...req, style }, DEP).data }).args as [
      Record<string, number>,
    ];
    return p;
  };
  assert.equal(routed("marketing").mktBps, 10000);
  assert.ok(routed("dividend").dividendBps > routed("dividend").mktBps);
  assert.ok(routed("deflationary").deflationBps > routed("deflationary").mktBps);
  assert.ok(routed("liquidity").lpBps > routed("liquidity").mktBps);
});

test("the tax split must sum to exactly 10000 bps", () => {
  // The Portal reverts InvalidTaxDistribution(); catching it here saves the gas.
  assert.throws(
    () => buildTaxLaunch({ ...req, style: "marketing", overrides: { mktBps: 5000 } }, DEP),
    /sum to exactly 10000/,
  );
  for (const style of ["marketing", "dividend", "deflationary", "liquidity"] as const) {
    const s = LAUNCH_STYLES[style];
    assert.equal(s.mktBps + s.deflationBps + s.dividendBps + s.lpBps, 10000, `${style} preset is malformed`);
  }
});

test("tax rates are capped — an agent cannot build a 50% tax by fumbling a number", () => {
  assert.throws(() => buildTaxLaunch({ ...req, style: "marketing", overrides: { buyTaxRate: 5000 } }, DEP), /exceeds the 1000bps/);
  assert.throws(() => buildTaxLaunch({ ...req, style: "marketing", overrides: { sellTaxRate: 1001 } }, DEP), /exceeds the 1000bps/);
  // At the ceiling exactly is allowed.
  assert.ok(buildTaxLaunch({ ...req, style: "marketing", overrides: { buyTaxRate: 1000 } }, DEP).predictedToken);
});

test("a tax token with no tax is a mistake, not a standard token", () => {
  assert.throws(
    () => buildTaxLaunch({ ...req, style: "marketing", overrides: { buyTaxRate: 0, sellTaxRate: 0 } }, DEP),
    /use the 'standard' style/,
  );
});

test("dividend styles get the eligibility floor the Portal demands", () => {
  // Discovered the hard way: 0 reverts MinimumShareBalanceTooLow() (0x6b9099a1).
  const [p] = decodeFunctionData({ abi: PORTAL_ABI, data: buildTaxLaunch({ ...req, style: "dividend" }, DEP).data }).args as [
    Record<string, bigint>,
  ];
  assert.ok(p.minimumShareBalance >= MIN_SHARE_BALANCE, `got ${p.minimumShareBalance}`);
  assert.throws(() => buildTaxLaunch({ ...req, style: "dividend", minimumShareBalance: 1n }, DEP), /at least 10000 tokens/);
});

test("non-dividend styles do not carry an eligibility floor", () => {
  const [p] = decodeFunctionData({ abi: PORTAL_ABI, data: buildTaxLaunch({ ...req, style: "marketing" }, DEP).data }).args as [
    Record<string, bigint>,
  ];
  assert.equal(p.minimumShareBalance, 0n);
});

test("tax accrues to the creator, never to us", () => {
  const [p] = decodeFunctionData({ abi: PORTAL_ABI, data: buildTaxLaunch({ ...req, style: "marketing" }, DEP).data }).args as [
    Record<string, string>,
  ];
  assert.equal(p.beneficiary, CREATOR);
});

test("durations are bounded the way the contract bounds them", () => {
  assert.throws(() => buildTaxLaunch({ ...req, style: "marketing", overrides: { taxDurationSec: 0n } }, DEP), /TaxDurationTooShort/);
  assert.throws(
    () => buildTaxLaunch({ ...req, style: "marketing", overrides: { antiFarmerDurationSec: 400n * 24n * 60n * 60n } }, DEP),
    /AntiFarmerDurationTooLong/,
  );
});

test("meta is optional — the chain accepts an empty metadata URI", () => {
  // Flap's own Robinhood example passes meta = "". A launch without it is
  // valid on-chain but invisible in terminals, which is a warning to surface
  // to the user, not a reason to refuse to build the transaction.
  const built = buildStandardLaunch({ ...req, meta: undefined }, DEP);
  assert.ok(built.predictedToken.toLowerCase().endsWith("8888"));
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
