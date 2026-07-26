import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { predictTokenAddress, tokenInitCode, deployToken } from "../src/launch/deployToken.js";
import { keccak256 } from "viem";

/**
 * MERD signs this deployment himself, which makes one mistake very easy to
 * reach: the entire supply landing in the hot key that happened to sign. These
 * cover the guards that make the permanent, public mistakes impossible rather
 * than merely unlikely — a wrong symbol or a misplaced billion tokens cannot be
 * undone once broadcast.
 */

const TREASURY = "0x1111111111111111111111111111111111111111" as const;
const MERD = { name: "Meridian", symbol: "MERD", supply: 1_000_000_000n, treasury: TREASURY };

// No network is touched: every assertion below fails before the RPC is used.
const opts = { rpcUrl: "http://127.0.0.1:9/unused", privateKey: generatePrivateKey(), chainId: 4663 };

test("the address is known before anything is broadcast", () => {
  const a = predictTokenAddress(MERD);
  assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(predictTokenAddress(MERD), a, "must be deterministic");
});

test("any change to the arguments moves the address", () => {
  // The init code hash covers the constructor args, so a treasury swap or a
  // supply typo produces a different token at a different address rather than
  // quietly overwriting the intended one.
  const base = predictTokenAddress(MERD);
  assert.notEqual(predictTokenAddress({ ...MERD, supply: 999_999_999n }), base);
  assert.notEqual(predictTokenAddress({ ...MERD, treasury: "0x2222222222222222222222222222222222222222" }), base);
  assert.notEqual(predictTokenAddress({ ...MERD, symbol: "MERDX" }), base);
});

test("the supply is scaled to 18 decimals exactly once", () => {
  // Passing 1e27 instead of 1e9 here would mint a billion billion tokens.
  const a = tokenInitCode(MERD);
  const b = tokenInitCode({ ...MERD, supply: 1_000_000_000n * 10n ** 18n });
  assert.notEqual(keccak256(a), keccak256(b), "supply must be interpreted as whole tokens");
});

test("REFUSES to send the supply to the signing key", async () => {
  // The whole reason this module exists. MERD's key is hot and rotates; it has
  // no business holding a billion tokens because it happened to sign.
  const account = privateKeyToAccount(opts.privateKey);
  await assert.rejects(
    deployToken({ ...MERD, treasury: account.address }, opts),
    /treasury must not be the deploying key/,
  );
});

test("rejects a symbol that would be permanent and wrong", async () => {
  for (const symbol of ["merd", "MERD ", " MERD", "M", "MERD-2", "MERDMERDMERD"]) {
    await assert.rejects(deployToken({ ...MERD, symbol }, opts), /symbol|whitespace/i, `accepted ${JSON.stringify(symbol)}`);
  }
});

test("rejects a name with stray whitespace or odd characters", async () => {
  for (const name of [" Meridian", "Meridian ", "", "Meridian​"]) {
    await assert.rejects(deployToken({ ...MERD, name }, opts), /name/i, `accepted ${JSON.stringify(name)}`);
  }
});

test("rejects a nonsense supply or treasury", async () => {
  await assert.rejects(deployToken({ ...MERD, supply: 0n }, opts), /supply must be positive/);
  await assert.rejects(deployToken({ ...MERD, treasury: "nope" as never }, opts), /treasury must be an address/);
});

test("the exact MERD parameters pass every guard", () => {
  // The positive case: nothing about the real launch trips a validator.
  assert.doesNotThrow(() => tokenInitCode(MERD));
  assert.match(predictTokenAddress(MERD), /^0x[0-9a-fA-F]{40}$/);
});
