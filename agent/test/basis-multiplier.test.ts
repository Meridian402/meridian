import { test } from "node:test";
import assert from "node:assert/strict";
import { perShareBasis } from "../src/signals/basis.js";

// The basis compares a 24/7 on-chain pool price to the real equity market's
// per-share price. Robinhood's tokenized stocks now handle dividends and splits
// with an ERC-8056 multiplier: the pool trades RAW tokens, and a raw token is
// worth `m` shares, so the raw pool price must be divided by m before the
// comparison. Without that, a corporate action reads as a giant fake basis, and
// Merd tweets the basis publicly.

test("with no corporate action (m=1) the basis is unchanged", () => {
  const r = perShareBasis(332, 333, 1);
  assert.equal(r.poolUsd, 332);
  assert.ok(Math.abs(r.basisPct - ((332 - 333) / 333) * 100) < 1e-9, "a real -0.3% basis, untouched");
});

test("a live drift (MU at 1.0000748 on-chain today) is corrected, not ignored", () => {
  // Verified on-chain: MU's multiplier already sits above 1.0. The correction is
  // tiny now but real, and it grows with every dividend.
  const raw = perShareBasis(100, 100, 1);
  const drifted = perShareBasis(100, 100, 1.0000748);
  assert.ok(drifted.poolUsd < raw.poolUsd, "the per-share price is nudged down by the multiplier");
  assert.ok(drifted.basisPct < 0, "so a token at par reads as a hair under, not exactly zero");
});

test("a 4:1 split does NOT read as a +300% basis", () => {
  // The whole point. After a 4:1 split the multiplier is 4, and the pool trades
  // the raw token at ~4x the share price. The naive basis would scream +300%.
  const sharePrice = 150;
  const rawPoolPrice = sharePrice * 4; // arbitrage holds the raw token at 4x a share
  const naiveBasisPct = ((rawPoolPrice - sharePrice) / sharePrice) * 100;
  assert.ok(naiveBasisPct > 290, "the bug this prevents: a ~300% fake premium");

  const fixed = perShareBasis(rawPoolPrice, sharePrice, 4);
  assert.ok(Math.abs(fixed.basisPct) < 0.01, "corrected to ~0, because there is no real basis, just a split");
  assert.ok(Math.abs(fixed.poolUsd - sharePrice) < 0.01, "per-share pool price matches the share price");
});

test("a real basis on top of a split still surfaces correctly", () => {
  // A 2:1 split (m=2) AND a genuine 5% on-chain discount: the fix must show the
  // 5%, not bury it or inflate it.
  const sharePrice = 200;
  const rawPoolPrice = sharePrice * 2 * 0.95; // 2x for the split, 5% under
  const r = perShareBasis(rawPoolPrice, sharePrice, 2);
  assert.ok(Math.abs(r.basisPct - -5) < 0.01, "the real 5% discount survives the split correction");
});

test("a garbage multiplier falls back to 1.0 rather than rescaling wildly", () => {
  // A bad read must never silently multiply a price by nonsense.
  for (const bad of [0, -1, NaN, Infinity]) {
    const r = perShareBasis(100, 100, bad as number);
    assert.equal(r.poolUsd, 100, `m=${bad} must be treated as 1.0`);
  }
});
