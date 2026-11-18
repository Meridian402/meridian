import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS, WATCHED, lpShareOf, quoteSide, v3SwapToWatch, scanRow, scanReject, rankRow, type ChainKey } from "../src/signals/chainTrack.js";
import type { LedgerHour } from "../src/signals/poolWatch.js";

/**
 * THE CHAIN TRACK: the pure parts.
 *
 * Every extra chain is another set of ways to be quietly wrong: the money leg
 * can sit on either side of a pool, a dollar stable has 18 decimals on one
 * chain and 6 on the next, LPs keep a different slice of the fee on every
 * venue, and most of the headline volume is junk. Each of those is pinned
 * here, because a tracker that prices a pool upside down still prints a
 * confident table, and the whole point of this ledger is that a number means
 * the same thing on four chains.
 */

const Q96 = 2 ** 96;
const sqrtX96 = (ratio: number) => BigInt(Math.floor(Math.sqrt(ratio) * Q96));
const BNB = CHAINS.bnb;
const USDT = BNB.stables[0];
const USDC = BNB.stables[1];
const WBNB = BNB.wrappedNative;
const TOKEN = "0x1111111111111111111111111111111111111111";
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= Math.abs(b) * rel;

test("lpShareOf reads each venue's protocol fee the way that venue packs it", () => {
  assert.equal(lpShareOf("uniswap-v3", 0), 1, "protocol fee off: LPs keep everything");
  assert.equal(lpShareOf("uniswap-v3", 4 + (4 << 4)), 0.75, "a denominator of 4 means the protocol takes a quarter");
  assert.ok(near(lpShareOf("uniswap-v3", 6 + (6 << 4)), 5 / 6), "one sixth, as read on the first pools watched");
  assert.ok(near(lpShareOf("pancake-v3", 3200 + (3200 << 16)), 0.68), "PancakeSwap takes 32% of the fee");
  assert.equal(lpShareOf("pancake-v3", 0), 1);
});

test("quoteSide finds the money leg on either side and prefers dollars to the native coin", () => {
  assert.deepEqual(quoteSide(USDT, TOKEN, BNB), { quoteIs0: true, quote: "USD" });
  assert.deepEqual(quoteSide(TOKEN, USDT.toLowerCase(), BNB), { quoteIs0: false, quote: "USD" });
  assert.deepEqual(quoteSide(WBNB, TOKEN, BNB), { quoteIs0: true, quote: "NATIVE" });
  assert.deepEqual(quoteSide(TOKEN, WBNB, BNB), { quoteIs0: false, quote: "NATIVE" });
  assert.deepEqual(quoteSide(USDT, WBNB, BNB), { quoteIs0: true, quote: "USD" }, "USDT/WBNB is priced in dollars: BNB is the token");
  assert.deepEqual(quoteSide(USDC, USDT, BNB), { quoteIs0: false, quote: "USD" }, "between two stables the list order decides, consistently");
  assert.equal(quoteSide(TOKEN, "0x2222222222222222222222222222222222222222", BNB), null);
  assert.equal(quoteSide(WBNB, TOKEN, CHAINS.base), null, "another chain's native coin is just a token here");
  assert.deepEqual(quoteSide(CHAINS.base.wrappedNative, CHAINS.base.stables[0], CHAINS.base), { quoteIs0: false, quote: "USD" });
});

test("v3SwapToWatch prices the token in dollars whichever side the stable sorted to", () => {
  // token0 = USDT (18), token1 = TOKEN (18), 2 USDT per token: token1 per token0 = 0.5
  const a = v3SwapToWatch({ t: 100, amount0: 100n * 10n ** 18n, amount1: -50n * 10n ** 18n, sqrtPriceX96: sqrtX96(0.5), liquidity: 7n, sender: "0xAbC" }, { quoteIs0: true, dec0: 18, dec1: 18 }, 1);
  assert.ok(a);
  assert.ok(near(a!.usd, 100) && near(a!.px, 2, 1e-6), `usd ${a!.usd} px ${a!.px}`);
  assert.equal(a!.sender, "0xabc");
  assert.equal(a!.L, 7);
  // the same market with the token as token0: token1 per token0 = 2
  const b = v3SwapToWatch({ t: 100, amount0: -50n * 10n ** 18n, amount1: 100n * 10n ** 18n, sqrtPriceX96: sqrtX96(2), liquidity: 7n, sender: "0x1" }, { quoteIs0: false, dec0: 18, dec1: 18 }, 1);
  assert.ok(near(b!.usd, 100) && near(b!.px, 2, 1e-6));
});

test("v3SwapToWatch handles a 6-decimal stable, mismatched decimals and a native-quoted pool", () => {
  // Base and Ethereum: USDC has 6 decimals. token0 = TOKEN (18), token1 = USDC (6), 2 USDC per token: raw ratio 2e-12
  const c = v3SwapToWatch({ t: 1, amount0: -5n * 10n ** 18n, amount1: 10n * 10n ** 6n, sqrtPriceX96: sqrtX96(2e-12), liquidity: 1n, sender: "0x1" }, { quoteIs0: false, dec0: 18, dec1: 6 }, 1);
  assert.ok(near(c!.usd, 10) && near(c!.px, 2, 1e-6), `usd ${c!.usd} px ${c!.px}`);
  // token0 = TOKEN (9 decimals), token1 = USDT (18): 2 USDT per token is a raw ratio of 2e9
  const a = v3SwapToWatch({ t: 1, amount0: -5n * 10n ** 9n, amount1: 10n * 10n ** 18n, sqrtPriceX96: sqrtX96(2e9), liquidity: 1n, sender: "0x1" }, { quoteIs0: false, dec0: 9, dec1: 18 }, 1);
  assert.ok(near(a!.usd, 10) && near(a!.px, 2, 1e-6), `usd ${a!.usd} px ${a!.px}`);
  // token0 = TOKEN (18), token1 = wrapped native (18): 0.01 native per token, native at $600
  const b = v3SwapToWatch({ t: 1, amount0: 100n * 10n ** 18n, amount1: -(10n ** 18n), sqrtPriceX96: sqrtX96(0.01), liquidity: 1n, sender: "0x1" }, { quoteIs0: false, dec0: 18, dec1: 18 }, 600);
  assert.ok(near(b!.usd, 600) && near(b!.px, 6, 1e-6), `usd ${b!.usd} px ${b!.px}`);
  assert.equal(v3SwapToWatch({ t: 1, amount0: 1n, amount1: 1n, sqrtPriceX96: 0n, liquidity: 1n, sender: "0x1" }, { quoteIs0: true, dec0: 18, dec1: 18 }, 1), null, "a zero price is not a sample");
});

const attrs = (o: Record<string, unknown> = {}) => ({
  address: "0xABCDEF0000000000000000000000000000000001", name: "FOO / USDT 0.25%", pool_created_at: "2026-01-01T00:00:00Z", reserve_in_usd: "200000",
  volume_usd: { h24: "1000000" }, transactions: { h24: { buys: 900, sells: 600, buyers: 300, sellers: 250 } }, price_change_percentage: { h1: "0.5", h6: "-2", h24: "7.5" }, ...o,
});
const NOW = Date.parse("2026-11-16T00:00:00Z");

test("scanRow turns an index entry into what an LP would see, with the venue's cut removed", () => {
  const r = scanRow(attrs(), "pancakeswap-v3-bsc", "Pancakeswap V3 (BSC)", NOW, BNB);
  assert.equal(r.address, "0xabcdef0000000000000000000000000000000001");
  assert.equal(r.pair, "FOO / USDT");
  assert.equal(r.feePct, 0.25);
  assert.equal(r.kind, "alt");
  assert.equal(r.dex, "pancake-v3");
  assert.equal(r.trades, 1500);
  assert.equal(r.traders, 550);
  assert.ok(near(r.lpFeesUsd!, 1_000_000 * 0.0025 * 0.68), `LP fees ${r.lpFeesUsd}`);
  assert.ok(near(r.yieldPct!, (1_000_000 * 0.0025 * 0.68 / 200_000) * 100));
  assert.ok(r.ageDays! > 300 && r.lpShareKnown);
  assert.equal(scanRow(attrs({ name: "USDT / WBNB 0.05%" }), "uniswap-bsc", "Uniswap V3 (BSC)", NOW, BNB).kind, "major");
  assert.equal(scanRow(attrs({ name: "USD1 / USDT 0.01%" }), "uniswap-bsc", "Uniswap V3 (BSC)", NOW, BNB).kind, "stable");
  const v2 = scanRow(attrs({ name: "FOO / WBNB" }), "pancakeswap_v2", "Pancakeswap V2 (BSC)", NOW, BNB);
  assert.equal(v2.feePct, 0.25, "a v2 pool has no tier in its name; the venue's flat fee applies");
  assert.equal(v2.dex, null, "and the hourly watch cannot decode it");
  const unknown = scanRow(attrs({ name: "FOO / WBNB" }), "some-new-dex", "Some New Dex", NOW, BNB);
  assert.equal(unknown.feePct, null);
  assert.equal(unknown.lpShareKnown, false);
  const aero = scanRow(attrs({ name: "MSFTc / USDC 0.16%" }), "aero-slipstream-base", "Aero Slipstream (Base)", NOW, CHAINS.base);
  assert.equal(aero.dex, "slipstream");
  assert.equal(aero.venueNote, "unstaked");
  assert.ok(near(aero.lpFeesUsd!, 1_000_000 * 0.0016 * 0.9));
});

test("scanReject throws out the pools that make up most of the headline volume", () => {
  assert.equal(scanReject(scanRow(attrs(), "pancakeswap-v3-bsc", "x", NOW, BNB)), null);
  assert.match(scanReject(scanRow(attrs({ reserve_in_usd: "309" }), "pancakeswap_v2", "x", NOW, BNB))!, /liquidity/);
  assert.match(scanReject(scanRow(attrs({ volume_usd: { h24: "90000000" } }), "pancakeswap_v2", "x", NOW, BNB))!, /turnover/);
  assert.match(scanReject(scanRow(attrs({ transactions: { h24: { buys: 3, sells: 2 } } }), "pancakeswap_v2", "x", NOW, BNB))!, /trades/);
  assert.match(scanReject(scanRow(attrs({ price_change_percentage: { h24: "-100" } }), "pancakeswap_v2", "x", NOW, BNB))!, /60%/);
  assert.match(scanReject(scanRow(attrs({ name: "FOO / WBNB" }), "some-new-dex", "x", NOW, BNB))!, /fee unknown/);
});

function hour(i: number, o: Partial<LedgerHour> = {}): LedgerHour {
  return { ts: 0, kind: "hour", id: "0xpool", symbol: "T", quote: "USD", feePct: 1, enterable: true, hour: "", hourStart: i * 3600, swaps: 20, traders: 8, volumeUsd: 5000, feesUsd: 50, markoutUsd: 10, lpNetUsd: 40, pxOpen: 1, pxClose: 1, pxHigh: 1, pxLow: 1, sqrtPClose: 1, liquidity: 1e18, depth2pctUsd: 2000, seatSharePct: 2, seatNetUsd: 0.8, ...o };
}

test("rankRow scales a short record to a day so pools with different history compare, and says how short it is", () => {
  const six = rankRow("bnb", "FOO/USDT", Array.from({ length: 6 }, (_, i) => hour(i)));
  assert.ok(six);
  assert.equal(six!.hours, 6);
  assert.ok(near(six!.seatPerDayUsd, 0.8 * 24), "six hours at $0.80 is $19.20 a day");
  const day = rankRow("base", "BAR/USDC", Array.from({ length: 30 }, (_, i) => hour(i)));
  assert.equal(day!.hours, 24, "only the last 24 hours count");
  assert.ok(near(day!.seatPerDayUsd, 0.8 * 24));
  assert.equal(day!.volumeUsd, 5000 * 24);
  assert.equal(rankRow("eth", "none", []), null);
  const losing = rankRow("eth", "BAD/WETH", Array.from({ length: 30 }, (_, i) => hour(i, { lpNetUsd: -40, seatNetUsd: -0.8 })));
  assert.ok(losing!.seatPerDayUsd < 0 && losing!.flags.some((f) => /LPs net negative/.test(f)));
});

test("every chain's configuration and watch list is well formed", () => {
  for (const key of Object.keys(CHAINS) as ChainKey[]) {
    const cfg = CHAINS[key];
    assert.equal(cfg.key, key);
    assert.match(cfg.wrappedNative, /^0x[0-9a-fA-F]{40}$/);
    // at least one dollar stable: the desk's own chain has exactly one (USDG)
    assert.ok(cfg.stables.length >= 1 && cfg.stables.every((s) => /^0x[0-9a-fA-F]{40}$/.test(s)));
    assert.ok(cfg.maxRange > 0n && cfg.rpcDefault.startsWith("https://"));
    const list = WATCHED[key];
    const addrs = list.map((p) => p.address.toLowerCase());
    assert.equal(new Set(addrs).size, addrs.length, `${key}: no pool is listed twice`);
    assert.ok(addrs.includes(cfg.refPool.address.toLowerCase()), `${key}: the native price pool is watched as the benchmark`);
    for (const p of list) {
      assert.match(p.address, /^0x[0-9a-fA-F]{40}$/);
      assert.ok(["uniswap-v3", "pancake-v3", "slipstream"].includes(p.dex));
      assert.ok(p.label.length > 0 && p.note.length > 0);
    }
  }
});
