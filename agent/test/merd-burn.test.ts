import { test } from "node:test";
import assert from "node:assert/strict";

// MERD's real deterministic address. The gate refuses anything else, on
// purpose: a hex-shaped value is not proof it is MERD, and a flat wei price
// against the wrong token would charge people in something they never agreed
// to. Using a placeholder here made this file fail closed, which is the gate
// working.
process.env.MERD_TOKEN_ADDRESS = "0x4663196C0Ad93594907555b2018457695Db8Ccef";
process.env.CREDITS_PACK_STARTER_MERD = "1000000000000000000000";

const { merdAsset, merdCreditsEnabled, packs } = await import("../src/credits.js");
const { destinationFor, paymentMessage, BURN_ADDRESS, USDG_ASSET } = await import("../src/payments/PaymentGate.js");

const TREASURY = "0x7037b347B21D5e72452dA1445FB1f01D652d40CC";

// Paying in MERD destroys the tokens. The mechanism is that the payment itself
// goes to an address with no known private key, so there is never a moment when
// the tokens sit somewhere that has to be TRUSTED to burn them later, and no
// second transaction that can fail or be forgotten.

test("MERD settles to the burn address, never the treasury", () => {
  const merd = merdAsset();
  assert.ok(merd, "MERD should be configured in this file");
  assert.equal(merd!.payTo, BURN_ADDRESS);
  assert.equal(destinationFor(merd!, TREASURY), BURN_ADDRESS.toLowerCase());
  assert.notEqual(destinationFor(merd!, TREASURY), TREASURY.toLowerCase());
});

test("the burn address is one nobody can spend from", () => {
  // Not address(0): MeridianToken reverts on a transfer there, so a payment to
  // it could never land. 0x…dEaD is the conventional unspendable address.
  assert.notEqual(BURN_ADDRESS, "0x0000000000000000000000000000000000000000");
  assert.match(BURN_ADDRESS, /^0x0{36}dead$/i);
});

test("USDG is untouched and still pays the treasury", () => {
  assert.equal(USDG_ASSET.payTo, undefined);
  assert.equal(destinationFor(USDG_ASSET, TREASURY), TREASURY.toLowerCase());
});

test("a burn authorization cannot be replayed as a treasury payment", () => {
  // The signed message binds the destination for a non-default asset, so a
  // signature over "send MERD to the burn address" is not also a signature over
  // "send MERD to the treasury".
  const merd = merdAsset()!;
  const burn = paymentMessage({ txHash: "0x" + "ab".repeat(32), resource: "credits:starter", treasury: TREASURY, asset: merd });
  const toTreasury = paymentMessage({ txHash: "0x" + "ab".repeat(32), resource: "credits:starter", treasury: TREASURY, asset: { ...merd, payTo: undefined } });
  assert.notEqual(burn, toTreasury);
  assert.match(burn, /PayTo: 0x0{36}dead/i);
});

test("the USDG authorization message is still byte-identical", () => {
  // Existing payers sign this exact string. Adding MERD burning must not alter
  // a single byte of it.
  const msg = paymentMessage({ txHash: "0x" + "cd".repeat(32), resource: "credits:starter", treasury: TREASURY });
  assert.equal(
    msg,
    ["Meridian x402 payment authorization", "Chain: 4663", `Treasury: ${TREASURY.toLowerCase()}`, "Resource: credits:starter", `Tx: 0x${"cd".repeat(32)}`].join("\n"),
  );
  assert.ok(!msg.includes("PayTo"), "the USDG message must not gain a PayTo line");
});

test("paying in MERD buys the same pack, with no discount for burning", () => {
  assert.equal(merdCreditsEnabled(), true);
  const starter = packs().find((p) => p.id === "starter")!;
  assert.equal(starter.credits, 200, "the MERD buyer gets exactly what the USDG buyer gets");
  assert.equal(starter.merdWei, 1000000000000000000000n);
});
