import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every module under test resolves its data dir at import time, so the override
// has to be in place BEFORE the dynamic imports below. A fresh temp dir per run
// keeps these tests off the real ledgers.
const dir = mkdtempSync(join(tmpdir(), "meridian-spend-guards-"));
process.env.MERIDIAN_DATA_DIR = dir;
process.env.MERIDIAN_CREDITS = "on";
delete process.env.CHAT_MAX_TURNS_PER_DAY;
delete process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY;
delete process.env.CHAT_SPEND_CACHE_MS;
delete process.env.SCOUT_MAX_PER_WALLET_PER_DAY;

const {
  foldSpend,
  ceilingBreach,
  spendWindow,
  resetSpendWindow,
  chatSpendBlocked,
  chatMaxTurnsPerDay,
  chatMaxTurnsPerWalletPerDay,
} = await import("../src/spendGuards.js");
const { routeKey, ROUTE_KEY_LIMIT, OTHER_ROUTE_KEY } = await import("../src/httpGuards.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const row = (wallet: string, kind: string, at: number) => ({ wallet, kind, credits: 1, at });

// ---- the daily fold -----------------------------------------------------------

test("fold: counts one charged turn per spend row, per wallet and in total", () => {
  const view = foldSpend(
    [row("0xa", "spend", now), row("0xa", "spend", now), row("0xb", "spend", now)],
    now - DAY_MS,
  );
  assert.equal(view.total, 3);
  assert.equal(view.byWallet.get("0xa"), 2);
  assert.equal(view.byWallet.get("0xb"), 1);
});

test("fold: ignores rows outside the window", () => {
  const view = foldSpend(
    [
      row("0xa", "spend", now - DAY_MS - 1), // just too old
      row("0xa", "spend", now - DAY_MS), // exactly on the boundary, inside
      row("0xa", "spend", now),
    ],
    now - DAY_MS,
  );
  assert.equal(view.total, 2);
  assert.equal(view.byWallet.get("0xa"), 2);
});

test("fold: counts spends only, not grants or purchases", () => {
  const view = foldSpend(
    [row("0xa", "grant", now), row("0xa", "purchase", now), row("0xa", "spend", now)],
    now - DAY_MS,
  );
  assert.equal(view.total, 1);
});

test("fold: a refunded turn still counts, because the tokens were still spent", () => {
  // A refund is written as a grant, so the spend row that preceded it stays in
  // the count. The meter is model spend, not revenue.
  const view = foldSpend([row("0xa", "spend", now), row("0xa", "grant", now)], now - DAY_MS);
  assert.equal(view.total, 1);
});

test("fold: skips malformed rows instead of miscounting them", () => {
  const view = foldSpend(
    [
      { wallet: "0xa", kind: "spend", at: "yesterday" },
      { wallet: "", kind: "spend", at: now },
      { kind: "spend", at: now },
      { wallet: "0xa", kind: "spend", at: Number.NaN },
      row("0xa", "spend", now),
    ],
    now - DAY_MS,
  );
  assert.equal(view.total, 1);
});

test("fold: wallet keys are lowercased so casing cannot split a wallet's count", () => {
  const view = foldSpend([row("0xAB", "spend", now), row("0xab", "spend", now)], now - DAY_MS);
  assert.equal(view.byWallet.get("0xab"), 2);
});

// ---- the ceilings -------------------------------------------------------------

const limits = { globalMax: 10, walletMax: 3 };

test("ceiling: allows up to the max and refuses the one after it", () => {
  const under = { total: 9, byWallet: new Map([["0xa", 2]]) };
  assert.equal(ceilingBreach(under, "0xa", limits), null);

  const at = { total: 10, byWallet: new Map<string, number>() };
  const breach = ceilingBreach(at, "0xa", limits);
  assert.equal(breach?.status, 503);
  assert.equal(breach?.code, "chat_daily_cap");
});

test("ceiling: per-wallet trips at its own max with a 429, global untouched", () => {
  const view = { total: 4, byWallet: new Map([["0xa", 3]]) };
  const breach = ceilingBreach(view, "0xa", limits);
  assert.equal(breach?.status, 429);
  assert.equal(breach?.code, "wallet_daily_cap");
  // A different wallet on the same view is still fine.
  assert.equal(ceilingBreach(view, "0xb", limits), null);
});

test("ceiling: per-wallet boundary is exact", () => {
  assert.equal(ceilingBreach({ total: 0, byWallet: new Map([["0xa", 2]]) }, "0xa", limits), null);
  assert.notEqual(ceilingBreach({ total: 0, byWallet: new Map([["0xa", 3]]) }, "0xa", limits), null);
});

test("ceiling: wallet lookup is case insensitive", () => {
  const view = { total: 0, byWallet: new Map([["0xa", 3]]) };
  assert.equal(ceilingBreach(view, "0xA", limits)?.code, "wallet_daily_cap");
});

test("ceiling: global takes precedence over per-wallet", () => {
  const view = { total: 10, byWallet: new Map([["0xa", 3]]) };
  assert.equal(ceilingBreach(view, "0xa", limits)?.status, 503);
});

test("ceiling: a zero max closes chat, which is the point of the knob", () => {
  assert.equal(ceilingBreach({ total: 0, byWallet: new Map() }, "0xa", { globalMax: 0, walletMax: 5 })?.status, 503);
});

test("limits: generous defaults, env override, mistyped values fall back", () => {
  assert.equal(chatMaxTurnsPerDay(), 5000);
  assert.equal(chatMaxTurnsPerWalletPerDay(), 200);

  process.env.CHAT_MAX_TURNS_PER_DAY = "12";
  process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY = "0";
  assert.equal(chatMaxTurnsPerDay(), 12);
  assert.equal(chatMaxTurnsPerWalletPerDay(), 0); // explicit zero is honoured

  process.env.CHAT_MAX_TURNS_PER_DAY = "not a number";
  process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY = "-5";
  assert.equal(chatMaxTurnsPerDay(), 5000);
  assert.equal(chatMaxTurnsPerWalletPerDay(), 200);

  delete process.env.CHAT_MAX_TURNS_PER_DAY;
  delete process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY;
});

// ---- folded from the real ledger, not from a process counter -------------------

test("window: folds real spends out of credits.jsonl, and survives a cache drop", async () => {
  const { trySpend, refundCredit } = await import("../src/credits.js");
  const w = "0x00000000000000000000000000000000000000c1";
  resetSpendWindow();
  const before = spendWindow().total;

  assert.equal(trySpend(w).ok, true);
  assert.equal(trySpend(w).ok, true);
  refundCredit(w, 1, "refund:error"); // a refund does not un-count the tokens

  // The live view is current without a refold (noteSpend keeps it so).
  assert.equal(spendWindow().total, before + 2);
  assert.equal(spendWindow().byWallet.get(w), 2);

  // And a restart, simulated by dropping the cache, recovers the same count from
  // the ledger file rather than starting the day over.
  resetSpendWindow();
  assert.equal(spendWindow().total, before + 2);
  assert.equal(spendWindow().byWallet.get(w), 2);
});

test("window: the live check refuses a wallet once its own ceiling is reached", async () => {
  const { trySpend } = await import("../src/credits.js");
  const w = "0x00000000000000000000000000000000000000c2";
  process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY = "2";
  resetSpendWindow();

  assert.equal(chatSpendBlocked(w), null);
  trySpend(w);
  assert.equal(chatSpendBlocked(w), null);
  trySpend(w);
  assert.equal(chatSpendBlocked(w)?.status, 429);
  // Another wallet is unaffected by this one's cap.
  assert.equal(chatSpendBlocked("0x00000000000000000000000000000000000000c3"), null);

  delete process.env.CHAT_MAX_TURNS_PER_WALLET_PER_DAY;
  resetSpendWindow();
});

// ---- the request-stats key ----------------------------------------------------

test("routeKey: real prefixes keep their own bucket", () => {
  assert.equal(routeKey("/api/my-agent/message"), "/api/my-agent");
  assert.equal(routeKey("/api/my-agent/stream"), "/api/my-agent");
  assert.equal(routeKey("/api/earn/scout"), "/api/earn");
  assert.equal(routeKey("/api/account/0xabc"), "/api/account");
  assert.equal(routeKey("/mcp"), "/mcp");
  assert.equal(routeKey("/health"), "/health");
  assert.equal(routeKey("/api/ops"), "/api/ops");
});

test("routeKey: anything we do not serve buckets as other", () => {
  for (const path of ["/", "", "/wp-admin", "/api", "/api/nope", "/api/opsomething", "/mcpx", "/healthz", "/api/my-agentx"]) {
    assert.equal(routeKey(path), OTHER_ROUTE_KEY, path);
  }
});

test("routeKey: a flood of random paths cannot grow the stats map", () => {
  const byRoute = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    const path = `/${Math.random().toString(36).slice(2)}/${i}/${Math.random().toString(36).slice(2)}`;
    const key = routeKey(path);
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...byRoute.keys()], [OTHER_ROUTE_KEY]);
  assert.equal(byRoute.get(OTHER_ROUTE_KEY), 5000);

  // And even counting every real prefix, the map is bounded by construction.
  for (const path of ["/api/my-agent/x", "/mcp", "/health", "/api/swarm/feed"]) byRoute.set(routeKey(path), 1);
  assert.ok(byRoute.size <= ROUTE_KEY_LIMIT, `${byRoute.size} keys exceeds the ${ROUTE_KEY_LIMIT} the key space allows`);
});

// ---- the scout cap counts attempts, not wins ----------------------------------

const BOUNTIES = join(dir, "bounties.jsonl");
const writeBounties = (rows: Record<string, unknown>[]) =>
  writeFileSync(BOUNTIES, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const scoutRow = (status: string, at: number, amountUsd = 0, wallet = "0xs1") => ({
  ts: at,
  kind: "scout",
  wallet,
  status,
  amountUsd,
});

const { scoutAllowed } = await import("../src/earn/scout.js");
const { config } = await import("../src/config.js");

test("scout cap: wins alone no longer close the door, attempts do", () => {
  const max = config.scoutMaxPerWalletPerDay;
  // Old meter: this wallet has already been paid for `max` finds today. Under
  // the win-counting cap that was a hard stop; it was also the only thing
  // counted, so failed runs were unlimited.
  writeBounties(Array.from({ length: max }, () => scoutRow("accrued", now, 0.1)));
  assert.equal(scoutAllowed("0xs1").ok, true);

  // New meter: the same number of ATTEMPTS, none of which earned anything.
  writeBounties(Array.from({ length: max }, () => scoutRow("attempt", now)));
  const blocked = scoutAllowed("0xs1");
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason), /scout runs/);
});

test("scout cap: one attempt short of the cap is still allowed", () => {
  writeBounties(Array.from({ length: config.scoutMaxPerWalletPerDay - 1 }, () => scoutRow("attempt", now)));
  assert.equal(scoutAllowed("0xs1").ok, true);
});

test("scout cap: failed and empty runs count, which is the whole fix", () => {
  // These three rows are what a wallet burning model tokens with nothing to show
  // for it leaves behind. Every one of them was free before.
  writeBounties([scoutRow("attempt", now), scoutRow("attempt", now), scoutRow("attempt", now), scoutRow("invalid", now), scoutRow("duplicate", now)]);
  assert.equal(scoutAllowed("0xs1").ok, false);
});

test("scout cap: attempts age out of the 24h window, and are per wallet", () => {
  writeBounties(Array.from({ length: config.scoutMaxPerWalletPerDay }, () => scoutRow("attempt", now - DAY_MS - 60_000)));
  assert.equal(scoutAllowed("0xs1").ok, true);

  writeBounties(Array.from({ length: config.scoutMaxPerWalletPerDay }, () => scoutRow("attempt", now, 0, "0xother")));
  assert.equal(scoutAllowed("0xs1").ok, true);
  assert.equal(scoutAllowed("0xother").ok, false);
});

test("scout cap: the global pool still meters accrued dollars, not attempts", () => {
  // Attempts cost model tokens; the pool is money owed, and money is only owed
  // on a real find. Cheap attempts by one wallet must not close the pool.
  const rows = Array.from({ length: 50 }, () => scoutRow("attempt", now, 0, "0xspender"));
  writeBounties(rows);
  assert.equal(scoutAllowed("0xfresh").ok, true);

  writeBounties([scoutRow("accrued", now, config.scoutMaxDailyTotalUsd, "0xw1")]);
  const blocked = scoutAllowed("0xfresh");
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.reason), /global bounty pool/);
});
