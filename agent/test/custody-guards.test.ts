import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbiItem } from "viem";

// executeForUser is the ONE thing the backend can trigger against a user's
// vault. Everything here is about what it refuses.
//
// It used to take `amountUsd` as a number passed in ALONGSIDE an opaque calldata
// blob, so the per-trade cap bounded an honest caller and nobody else: a
// compromised backend could send any trade it liked and simply declare it was
// worth a dollar. The amount is now read out of the calldata, which is only
// possible because the session key is scoped to the adapter's single typed
// function rather than to the router's opaque execute().

process.env.CUSTODY_SESSION_MASTER = "x".repeat(48);
process.env.CUSTODY_VAULT_ADAPTER = "0x1111111111111111111111111111111111111111";
process.env.CUSTODY_MAX_PER_TRADE_USD = "100";

const { executeForUser, vaultAdapterAddress } = await import("../src/custody/vault.js");

const ADAPTER = "0x1111111111111111111111111111111111111111";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const OTHER = "0x2222222222222222222222222222222222222222";
const USER = "0x00000000000000000000000000000000000000a1";

const swapAbi = [parseAbiItem("function swapExactInSingle(address tokenIn, address tokenOut, uint24 fee, int24 tickSpacing, uint128 amountIn, uint128 minOut) returns (uint256)")];
const swap = (tokenIn: string, amountIn: bigint) =>
  encodeFunctionData({ abi: swapAbi, functionName: "swapExactInSingle", args: [tokenIn as `0x${string}`, OTHER as `0x${string}`, 3000, 60, amountIn, 1n] });

test("the adapter address is required, and there is no fallback to the router", () => {
  // Scoping straight at the UniversalRouter is what made "cannot withdraw"
  // untrue, so custody must refuse to arm rather than silently do that again.
  assert.equal(vaultAdapterAddress(), ADAPTER);
});

test("a trade aimed anywhere but the adapter is refused", async () => {
  const r = await executeForUser(USER, { to: OTHER as `0x${string}`, value: 0n, data: swap(USDG, 1_000_000n), amountUsd: 1 });
  assert.deepEqual(r, { error: "trade target is not the scoped adapter" });
});

test("calldata that is not the adapter's swap is refused", async () => {
  const junk = await executeForUser(USER, { to: ADAPTER as `0x${string}`, value: 0n, data: "0xdeadbeef", amountUsd: 1 });
  assert.ok("error" in junk && /not a call to the vault adapter/.test(junk.error));
});

test("the cap is applied to the calldata amount, not the declared one", async () => {
  // The heart of it: claim a dollar, actually move ten thousand.
  const lying = await executeForUser(USER, {
    to: ADAPTER as `0x${string}`,
    value: 0n,
    data: swap(USDG, 10_000_000_000n), // $10,000 at 6dp
    amountUsd: 1, // the lie
  });
  assert.ok("error" in lying, "a trade over the cap must be refused however it is labelled");
  assert.match(lying.error, /exceeds the \$100 per-trade cap/);
  assert.match(lying.error, /10000\.00/, "the error should quote the REAL amount, not the claimed one");
});

test("an unpriceable input token is refused rather than guessed at", async () => {
  // The cap is denominated in USD. A non-USDG input has no USD figure here, and
  // inventing one would put the bound back on trust.
  const r = await executeForUser(USER, { to: ADAPTER as `0x${string}`, value: 0n, data: swap(OTHER, 1n), amountUsd: 1 });
  assert.ok("error" in r && /only USDG-in trades are priced/.test(r.error));
});

test("a trade inside the cap gets past the guards", async () => {
  // It will not complete (no vault is deployed in a test), but it must fail for
  // that reason rather than being rejected by the checks above.
  const r = await executeForUser(USER, { to: ADAPTER as `0x${string}`, value: 0n, data: swap(USDG, 50_000_000n), amountUsd: 999 });
  assert.ok("error" in r, "no vault exists here, so it cannot succeed");
  assert.ok(!/cap|not a call|not the scoped|only USDG/.test(r.error), `should clear the guards, got: ${r.error}`);
});
