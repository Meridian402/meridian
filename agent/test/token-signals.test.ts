import { test } from "node:test";
import assert from "node:assert/strict";
import { targets, parsePools, parseTokenInfo, parseTrending, holdersStale, latestByPool, type SignalRow } from "../src/signals/tokenSignals.js";
import { loadPools } from "../src/signals/paperReplay.js";
import { WATCHED as RH_WATCHED } from "../src/signals/poolWatch.js";
import { WATCHED as CHAIN_WATCHED } from "../src/signals/chainTrack.js";

/**
 * TOKEN SIGNALS: the pure parts.
 *
 * This ledger exists to be joined to the hourly pool record later, to ask
 * whether holders, wallets or attention predict anything. Two ways it could
 * quietly ruin that question are pinned here: a reading filed under a key the
 * pool record does not use (the join silently matches nothing), and a missing
 * figure written down as a zero (a token with unknown holders reads as a token
 * with none). Everything the index sends is treated as possibly absent.
 */

test("every watched pool is a target, keyed the way the replay keys pools", () => {
  const t = targets();
  const expected = RH_WATCHED.length + Object.values(CHAIN_WATCHED).reduce((a, list) => a + list.length, 0);
  assert.equal(t.length, expected);
  assert.equal(new Set(t.map((x) => x.key)).size, t.length, "keys are unique");
  for (const x of t) {
    assert.equal(x.key, `${x.chain}:${x.ref}`);
    assert.equal(x.ref, x.ref.toLowerCase());
  }
  // whatever the replay has on record must be findable here by the same key
  const keys = new Set(t.map((x) => x.key));
  for (const p of loadPools()) assert.ok(keys.has(p.key), `${p.key} has no signal target`);
});

test("networks: the desk's chain and the three tracked chains each map to an index network", () => {
  const byChain = new Map(targets().map((x) => [x.chain, x.network]));
  assert.deepEqual([...byChain.entries()].sort(), [["base", "base"], ["bnb", "bsc"], ["eth", "eth"], ["robinhood", "robinhood"]]);
});

const POOLS = {
  data: [
    {
      attributes: { address: "0xCCB5E080c38e4e7a1c6437db53bcbe016e45b9db", reserve_in_usd: "81234.5", fdv_usd: "12000000", locked_liquidity_percentage: null, transactions: { h1: { buys: 636, sells: 680, buyers: 305, sellers: 279, unique_traders: 502 } } },
      relationships: { base_token: { data: { id: "bsc_0xAA036928c9c0df07d525d55ea8ee690bb5a628c1" } } },
    },
    { attributes: { address: "0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef", transactions: {} }, relationships: {} },
    { attributes: {} },
  ],
};

test("pools: counts come through, addresses are lower-cased, the base token is taken off the id", () => {
  const m = parsePools(POOLS);
  assert.equal(m.size, 2, "a row with no address is dropped");
  const evaa = m.get("0xccb5e080c38e4e7a1c6437db53bcbe016e45b9db")!;
  assert.deepEqual(
    { buys: evaa.buys1h, sells: evaa.sells1h, buyers: evaa.buyers1h, sellers: evaa.sellers1h, traders: evaa.traders1h },
    { buys: 636, sells: 680, buyers: 305, sellers: 279, traders: 502 },
  );
  assert.equal(evaa.baseToken, "0xaa036928c9c0df07d525d55ea8ee690bb5a628c1");
  assert.equal(evaa.reserveUsd, 81234.5);
  assert.equal(evaa.lockedLiqPct, null);
});

test("pools: what the index did not send is null, never zero", () => {
  const v4 = parsePools(POOLS).get("0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef")!;
  assert.equal(v4.traders1h, null);
  assert.equal(v4.buyers1h, null);
  assert.equal(v4.baseToken, null);
  assert.equal(v4.reserveUsd, null);
});

test("pools: a base token id on a network whose name has an underscore still parses", () => {
  const m = parsePools({ data: [{ attributes: { address: "0xabc" }, relationships: { base_token: { data: { id: "polygon_pos_0xDEF" } } } }] });
  assert.equal(m.get("0xabc")!.baseToken, "0xdef");
});

test("pools: an error body or junk gives an empty map, not a throw", () => {
  assert.equal(parsePools({ status: { error_code: 429 } }).size, 0);
  assert.equal(parsePools(null).size, 0);
  assert.equal(parsePools("nope").size, 0);
});

test("token info: holders, top-ten share, developer share, score and the honeypot flag", () => {
  const r = parseTokenInfo({ data: { attributes: { holders: { count: 26486, distribution_percentage: { top_10: "79.3882", rest: "1.2674" }, last_updated: "2026-11-17T08:02:58Z" }, developer_holding_percentage: "3.5", gt_score: 78.507, is_honeypot: false } } })!;
  assert.equal(r.holders, 26486);
  assert.equal(r.top10Pct, 79.3882);
  assert.equal(r.devPct, 3.5);
  assert.equal(r.gtScore, 78.507);
  assert.equal(r.honeypot, false);
  assert.equal(r.holdersAsOf, "2026-11-17T08:02:58Z");
});

test("token info: a rate-limit body is no reading; a token with no holder data is nulls, not zeros", () => {
  assert.equal(parseTokenInfo({ status: { error_code: 429, error_message: "rate limit" } }), null);
  assert.equal(parseTokenInfo(null), null);
  const bare = parseTokenInfo({ data: { attributes: { symbol: "X", holders: null, is_honeypot: "unknown" } } })!;
  assert.deepEqual(bare, { holders: null, top10Pct: null, devPct: null, gtScore: null, honeypot: null, holdersAsOf: null });
});

test("token info: a top-ten share of exactly zero is the index's blank, recorded as not known", () => {
  const r = parseTokenInfo({ data: { attributes: { holders: { count: 7640, distribution_percentage: { top_10: "0.0" } }, developer_holding_percentage: "0" } } })!;
  assert.equal(r.holders, 7640);
  assert.equal(r.top10Pct, null);
  assert.equal(r.devPct, 0, "a developer holding nothing is a real reading");
});

test("trending: place on the list counts from one; a pool not on it is simply absent", () => {
  const m = parseTrending({ data: [{ attributes: { address: "0xAAA" } }, { attributes: { address: "0xbbb" } }, { attributes: {} }, { attributes: { address: "0xaaa" } }] });
  assert.equal(m.get("0xaaa"), 1, "first appearance wins");
  assert.equal(m.get("0xbbb"), 2);
  assert.equal(m.has("0xccc"), false);
  assert.equal(parseTrending({ status: { error_code: 429 } }).size, 0);
});

test("holders are re-read when never read, or six hours old; not before", () => {
  const now = 1_800_000_000_000;
  assert.equal(holdersStale(undefined, now), true);
  assert.equal(holdersStale({ holdersTs: null }, now), true);
  assert.equal(holdersStale({ holdersTs: now - 5 * 3600_000 }, now), false);
  assert.equal(holdersStale({ holdersTs: now - 6 * 3600_000 }, now), true);
});

test("latest reading per pool is the newest row, whatever order they arrive in", () => {
  const row = (key: string, ts: number, holders: number): SignalRow => ({
    ts, kind: "signal", chain: "bnb", key, label: key, baseToken: null, buys1h: null, sells1h: null, buyers1h: null, sellers1h: null, traders1h: null, reserveUsd: null, fdvUsd: null, lockedLiqPct: null,
    holders, top10Pct: null, devPct: null, gtScore: null, honeypot: null, holdersAsOf: null, trendingRank: null, trendingRead: true, holdersTs: ts,
  });
  const m = latestByPool([row("a", 3, 30), row("b", 1, 10), row("a", 2, 20)]);
  assert.equal(m.get("a")!.holders, 30);
  assert.equal(m.get("b")!.holders, 10);
});
