import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Paying for credit packs in MERD.
 *
 * MERD IS NOT DEPLOYED. The feature therefore ships dormant, and the first
 * property here is that an unconfigured deployment offers nothing: no MERD
 * price, no MERD asset, no way to be quoted in a token that does not exist.
 *
 * The second property is the cross-asset one. The same pack can be priced in
 * two tokens, so the payer's signature must commit to WHICH token it authorises,
 * or one proof would settle either. The USDG message is pinned byte for byte so
 * this refactor is provably invisible to everyone paying today.
 */

// Both modules resolve their data dir at import time, so the override goes in
// first. Every MERD env var starts unset: the dormant case is the default case.
process.env.MERIDIAN_DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-credits-merd-test-"));
process.env.MERIDIAN_CREDITS = "on";
delete process.env.MERD_TOKEN_ADDRESS;
delete process.env.CREDITS_PACK_STARTER_MERD;
delete process.env.CREDITS_PACK_PLUS_MERD;
delete process.env.CREDITS_PACK_PRO_MERD;

const { PACKS, packs, packsForApi, packMerdWei, merdAsset, merdCreditsEnabled, addPurchase, balanceOf, FREE_CREDITS } = await import(
  "../src/credits.js"
);
const { paymentMessage, USDG_ASSET, PaymentGate } = await import("../src/payments/PaymentGate.js");
const { merdTokenAddress } = await import("../src/deploy/tokenGate.js");

// The mined MERD address. Valid in form, no code behind it yet, which is the
// whole reason this feature has to stay off until an operator says otherwise.
const MERD_ADDRESS = "0x4663196C0Ad93594907555b2018457695Db8Ccef";
const TREASURY = "0x759dd0df0000000000000000000000000000beef";
const TX = "0x" + "ab".repeat(32);
const PRO_MERD = 12_500n * 10n ** 18n; // a flat, operator-set price

/** Run fn with MERD configured, then put the environment back exactly as it was. */
function withMerd(fn: () => void, prices: Record<string, string> = { CREDITS_PACK_PRO_MERD: PRO_MERD.toString() }): void {
  process.env.MERD_TOKEN_ADDRESS = MERD_ADDRESS;
  for (const [k, v] of Object.entries(prices)) process.env[k] = v;
  try {
    fn();
  } finally {
    delete process.env.MERD_TOKEN_ADDRESS;
    for (const k of Object.keys(prices)) delete process.env[k];
  }
}

test("dormant by default: no MERD config means no MERD anywhere", () => {
  assert.equal(merdCreditsEnabled(), false, "MERD payment must be off until MERD exists");
  assert.equal(merdAsset(), null, "there is no asset to describe before the token is deployed");
  for (const p of packs()) {
    assert.equal(p.merdWei, undefined, `${p.id} must have no MERD price`);
    assert.equal(packMerdWei(p.id), undefined);
  }
  for (const p of packsForApi()) assert.equal("merdWei" in p, false, "the wire form must not advertise a price that does not exist");
});

test("a MERD address alone is still dormant: no pack price means nothing to charge", () => {
  withMerd(() => {
    assert.equal(merdCreditsEnabled(), false);
    assert.equal(packs().every((p) => p.merdWei === undefined), true);
  }, {});
});

test("configured: packs pick up their flat MERD price from env", () => {
  withMerd(
    () => {
      assert.equal(merdCreditsEnabled(), true);
      assert.deepEqual(merdAsset(), { symbol: "MERD", address: MERD_ADDRESS, decimals: 18 });
      const by = Object.fromEntries(packs().map((p) => [p.id, p.merdWei]));
      assert.equal(by.starter, 1_000n * 10n ** 18n);
      assert.equal(by.plus, undefined, "a pack with no configured price stays USDG only");
      assert.equal(by.pro, PRO_MERD);
      // The wire form carries the price as a decimal string: 1e18-scale numbers
      // do not survive JSON's float.
      const wire = Object.fromEntries(packsForApi().map((p) => [p.id, p.merdWei]));
      assert.equal(wire.pro, PRO_MERD.toString());
      assert.equal(wire.plus, undefined);
    },
    { CREDITS_PACK_STARTER_MERD: (1_000n * 10n ** 18n).toString(), CREDITS_PACK_PRO_MERD: PRO_MERD.toString() },
  );
});

test("a junk or zero MERD price is ignored, it never becomes free credits", () => {
  withMerd(
    () => {
      assert.equal(packMerdWei("starter"), undefined);
      assert.equal(packMerdWei("plus"), undefined);
      assert.equal(merdCreditsEnabled(), false);
    },
    { CREDITS_PACK_STARTER_MERD: "0", CREDITS_PACK_PLUS_MERD: "not-a-number" },
  );
});

/**
 * The cross-asset replay property. Without the asset in the signed message, a
 * signature authorising a MERD payment for credits:pro would equally authorise
 * a USDG payment for credits:pro, letting a payer settle in whichever token was
 * cheaper for them than the one they were quoted.
 */
test("the signed authorization differs between a USDG and a MERD payment for the same resource and tx", () => {
  withMerd(() => {
    const merd = merdAsset()!;
    const usdgMsg = paymentMessage({ txHash: TX, resource: "credits:pro", treasury: TREASURY });
    const merdMsg = paymentMessage({ txHash: TX, resource: "credits:pro", treasury: TREASURY, asset: merd });
    assert.notEqual(usdgMsg, merdMsg, "one signature must not authorise both assets");
    assert.match(merdMsg, /^Asset: MERD 0x4663196c0ad93594907555b2018457695db8ccef$/m);
    // Passing USDG explicitly is the same thing as omitting it, so the default
    // cannot drift away from what USDG payers sign.
    assert.equal(paymentMessage({ txHash: TX, resource: "credits:pro", treasury: TREASURY, asset: USDG_ASSET }), usdgMsg);
  });
});

test("the USDG authorization message is UNCHANGED, byte for byte", () => {
  // Pinned literally, not derived: this is the contract every payer already
  // signs, and a 402 challenge in flight must stay valid across this refactor.
  const expected =
    "Meridian x402 payment authorization\n" +
    "Chain: 4663\n" +
    `Treasury: ${TREASURY}\n` +
    "Resource: credits:pro\n" +
    `Tx: ${TX}`;
  assert.equal(paymentMessage({ txHash: TX, resource: "credits:pro", treasury: TREASURY }), expected);
  // And it stays that way with MERD fully configured: the asset line is only
  // added for non-default assets.
  withMerd(() => {
    assert.equal(paymentMessage({ txHash: TX, resource: "credits:pro", treasury: TREASURY }), expected);
  });
});

test("the 402 challenge quotes MERD in raw wei, and never converts USD to MERD", () => {
  withMerd(() => {
    const merd = merdAsset()!;
    const gate = new PaymentGate(TREASURY, "self");

    const usdg = gate.requirements(50, "credits:pro");
    assert.equal(usdg.accepts[0].maxAmountRequired, "50000000"); // 6 decimals, unchanged
    assert.equal(usdg.accepts[0].description, "Meridian credits:pro - $50.0000");
    assert.equal(usdg.accepts[0].asset, undefined, "the USDG challenge body must be unchanged");

    const inMerd = gate.requirements(PRO_MERD, "credits:pro", merd);
    assert.equal(inMerd.accepts[0].maxAmountRequired, PRO_MERD.toString());
    assert.equal(inMerd.accepts[0].asset?.address, MERD_ADDRESS);
    assert.equal(inMerd.accepts[0].asset?.decimals, 18);
    assert.match(inMerd.accepts[0].description, /12500 MERD$/);

    // A USD figure for MERD is refused rather than guessed at. There is no
    // oracle here on purpose: a price read from a thin pool is a price an
    // attacker can move seconds before buying.
    assert.throws(() => gate.requirements(50, "credits:pro", merd), /raw token units/);
  });
});

test("a MERD purchase grants exactly the same credits as the USDG purchase of that pack", () => {
  const pro = PACKS.find((p) => p.id === "pro")!;
  const usdgBuyer = "0x00000000000000000000000000000000000000c1";
  const merdBuyer = "0x00000000000000000000000000000000000000c2";
  balanceOf(usdgBuyer);
  const usdgBalance = addPurchase(usdgBuyer, pro.id, pro.credits, "0xusdgtx");

  withMerd(() => {
    // The pack a MERD payer buys is the same object with the same credits: the
    // MERD price is the only field that differs, no bonus and no discount.
    const pack = packs().find((p) => p.id === "pro")!;
    assert.equal(pack.credits, pro.credits);
    assert.equal(pack.usd, pro.usd);
    balanceOf(merdBuyer);
    const merdBalance = addPurchase(merdBuyer, pack.id, pack.credits, "0xmerdtx");
    assert.equal(merdBalance, usdgBalance);
    assert.equal(merdBalance, FREE_CREDITS + pro.credits);
  });
});

// Both findings from the adversarial review of this feature, pinned so neither
// can come back quietly.

test("a MERD address that is not MERD leaves the feature dormant", async () => {
  const prev = process.env.MERD_TOKEN_ADDRESS;
  try {
    // The zero address is hex-shaped and would otherwise arm a live payment path.
    process.env.MERD_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
    assert.equal(merdTokenAddress(), null, "the zero address is not MERD");

    // So is any other real token. USDG here: pasting it into the wrong env line
    // would have people paying for credits in a token priced as if it were MERD.
    process.env.MERD_TOKEN_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    assert.equal(merdTokenAddress(), null, "USDG is not MERD");

    process.env.MERD_TOKEN_ADDRESS = MERD_ADDRESS;
    assert.equal((merdTokenAddress() ?? "").toLowerCase(), MERD_ADDRESS.toLowerCase(), "MERD itself is accepted");
  } finally {
    if (prev === undefined) delete process.env.MERD_TOKEN_ADDRESS;
    else process.env.MERD_TOKEN_ADDRESS = prev;
  }
});

test("a resource carrying a line break cannot forge the asset commitment", () => {
  // The asset line is present or absent, so a newline in the resource could
  // write it. Not reachable today; this asserts the invariant rather than
  // trusting that every future caller keeps it.
  const forged = `credits:pro\nAsset: MERD ${MERD_ADDRESS.toLowerCase()}`;
  assert.throws(
    () => paymentMessage({ txHash: "0x" + "ab".repeat(32), resource: forged, treasury: "0x" + "cd".repeat(20) }),
    /line break/,
  );
});
