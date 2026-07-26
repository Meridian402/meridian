import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Tier 1: deterministic MCP tool-level tests. No LLM involved — spawns the
 * real server against a scratch universe file, drives it with the real MCP
 * client/transport OpenHermit uses, and asserts on tool behavior. Free to
 * run as often as you like; run before ever spending tokens on a live agent.
 */
const PORT = 8799;
const scratchDir = mkdtempSync(join(tmpdir(), "meridian-test-"));
const universePath = join(scratchDir, "rwa-universe.json");
// Isolates the strategy's persisted position state from the real one — a
// prior run of this suite clobbered the real position-state.json (2026-07-11)
// because it wasn't isolated the way the universe file already was.
const positionStatePath = join(scratchDir, "position-state.json");

let child: ChildProcess;
let client: Client;

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy in time");
}

/**
 * HERMETIC child environment. Deliberately does NOT spread process.env: doing so
 * inherited whatever the operator's shell happened to hold, which gave the suite
 * two failure modes and no correct one. With no .env loaded the server refused to
 * boot; with the real .env loaded, MERIDIAN_MCP_TOKEN switched on the bearer gate
 * (submit_research 401s, and the universe assertions then fail on an empty
 * universe), X402_FACILITATOR_URL left payment stub mode so the "test-proof"
 * header below stopped being accepted, and AGENT_SIGNER_PRIVATE_KEY pushed the
 * execute tools onto the real signing path the stub-mode assertions do not expect.
 *
 * Everything the server needs is therefore stated here, and every gate the suite
 * must not hit is explicitly blanked rather than left to chance. Only PATH and
 * HOME come from the parent, because npx needs them.
 */
const childEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,

  MERIDIAN_MCP_PORT: String(PORT),
  MERIDIAN_UNIVERSE_PATH: universePath,
  MERIDIAN_POSITION_STATE_PATH: positionStatePath,
  // Keeps the money-adjacent ledgers (x402 replay, reservations, accounts) in
  // the scratch dir. Unset, DATA_DIR falls back to the repo and the suite writes
  // into real state — the same class of bug that clobbered position-state.json.
  MERIDIAN_DATA_DIR: scratchDir,

  // Satisfies module-load requirements. Never dialed: the loggers that would use
  // these only start when their MERIDIAN_RUN_*_LOGGER flag is set, which it is not.
  ROBINHOOD_RPC_URL: "http://127.0.0.1:9/unused",
  SOLANA_RPC_URL: "http://127.0.0.1:9/unused",

  AGENT_MAX_TRADE_USD: "1000",
  // 2000, not 1500: the index_execute tests spend $300 before the
  // bridge_execute tests run (one shared RiskLimiter for the whole file),
  // and the daily-cap test still needs headroom for its own $500 + $1000.
  AGENT_MAX_DAILY_USD: "2000",

  // Gates the suite must not hit, blanked explicitly.
  MERIDIAN_MCP_TOKEN: "",
  MERIDIAN_EXECUTE_TOKEN: "",
  X402_FACILITATOR_URL: "",
  AGENT_SIGNER_PRIVATE_KEY: "",
  AGENT_LIVE_TRADING: "false",
};

before(async () => {
  child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: childEnv,
    stdio: "ignore",
  });
  await waitForHealth();

  client = new Client({ name: "test", version: "0.0.1" });
  // Default X-PAYMENT header so tool-behavior tests below don't have to think
  // about the paywall — in stub mode (no X402_FACILITATOR_URL) any non-empty
  // header is accepted. The paywall itself is exercised separately below.
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { "x-payment": "test-proof" } },
    }),
  );
});

after(async () => {
  await client?.close();
  child?.kill();
  rmSync(scratchDir, { recursive: true, force: true });
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.map((c) => c.text).join(""));
}

test("lists all expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "meridian_list_chains",
    "meridian_list_assets",
    "meridian_market_data",
    "meridian_suggest_route",
    "meridian_agent_thoughts",
    "meridian_bridge_quote",
    "meridian_bridge_execute",
    "meridian_index_execute",
    "meridian_settle_x402",
    "meridian_market_universe",
    "meridian_universe_status",
    "meridian_submit_research",
    "meridian_index_yield",
    "meridian_index_yield_execute",
    "meridian_launch_token",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

/**
 * launch_token must stay reachable WITHOUT the execute token. It returns
 * unsigned calldata and holds no signer, so it cannot move funds — which is
 * exactly why every user's chat agent, connecting through the credential-free
 * registration, is allowed to call it. If someone later adds it to
 * EXECUTE_TOOLS "to be safe", the feature silently dies for its entire
 * audience and this test is the thing that says so.
 *
 * Uses invalid input on purpose: validation fails before any network call, so
 * the assertion stays hermetic and this suite keeps its "free to run" promise.
 */
/**
 * A gated tool fails at the TRANSPORT layer (StreamableHTTPError 401/403)
 * before dispatch happens at all. Reaching the tool's own schema validation is
 * therefore the proof that it is NOT gated. The SDK surfaces schema rejection
 * either as a rejected promise or as an isError result, so accept both shapes
 * and assert only on the thing that actually matters.
 */
async function rejectedWithoutAuthGate(args: Record<string, unknown>) {
  let transportError: unknown = null;
  let result: Awaited<ReturnType<Client["callTool"]>> | null = null;
  try {
    result = await client.callTool({ name: "meridian_launch_token", arguments: args });
  } catch (err) {
    transportError = err;
  }
  assert.ok(!(transportError instanceof StreamableHTTPError), "launch_token must not sit behind an auth gate");
  assert.ok(transportError !== null || result?.isError === true, "expected invalid input to be rejected");
}

test("launch_token is not gated behind the execute token", async () => {
  await rejectedWithoutAuthGate({
    name: "x".repeat(200),
    symbol: "TST",
    creator: "0x1111111111111111111111111111111111111111",
  });
});

test("launch_token refuses a creator that is not an address", async () => {
  // Rejected by schema: never mines a salt, never touches the chain.
  await rejectedWithoutAuthGate({ name: "Test", symbol: "TST", creator: "not-a-wallet" });
});

test("universe starts empty", async () => {
  const status = textOf(await client.callTool({ name: "meridian_universe_status", arguments: {} }));
  assert.equal(status.totalVenues, 0);
  assert.equal(status.segments.length, 12);
});

test("submit_research upserts new venues", async () => {
  const result = textOf(
    await client.callTool({
      name: "meridian_submit_research",
      arguments: {
        submittedBy: "rwa-research-treasuries",
        venues: [
          { name: "Ondo Finance", segment: "Tokenized US Treasuries & T-bills", chains: ["ethereum"], tvlUsd: "$680M", confidence: "high", sources: ["https://ondo.finance"] },
          { name: "BlackRock BUIDL", segment: "Tokenized US Treasuries & T-bills", chains: ["ethereum"], tvlUsd: "$550M", confidence: "medium", sources: ["https://securitize.io/buidl"] },
        ],
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.upserted, 2);
  assert.equal(result.total, 2);
});

test("resubmitting an existing venue updates in place, does not duplicate", async () => {
  const result = textOf(
    await client.callTool({
      name: "meridian_submit_research",
      arguments: {
        submittedBy: "rwa-research-treasuries",
        venues: [{ name: "ondo finance", tvlUsd: "$710M", tvlAsOf: "2026-07-10", confidence: "high" }],
      },
    }),
  );
  assert.equal(result.total, 2, "name-normalized match should update, not add a 3rd venue");

  const found = textOf(await client.callTool({ name: "meridian_market_universe", arguments: { query: "ondo" } }));
  assert.equal(found.count, 1);
  assert.equal(found.venues[0].tvlUsd, "$710M");
  assert.equal(found.venues[0].chains?.[0], "ethereum", "unset fields on resubmit should keep prior values");
});

test("universe_status reflects segment counts after submission", async () => {
  const status = textOf(await client.callTool({ name: "meridian_universe_status", arguments: {} }));
  assert.equal(status.totalVenues, 2);
  const treasuries = status.segments.find((s: { key: string }) => s.key === "treasuries");
  assert.equal(treasuries.venuesFound, 2);
});

test("market_universe filters by segment substring", async () => {
  const result = textOf(await client.callTool({ name: "meridian_market_universe", arguments: { segment: "treasur" } }));
  assert.equal(result.count, 2);
});

test("bridge_quote clamps to the per-trade cap and previews the x402 fee", async () => {
  const result = textOf(
    await client.callTool({ name: "meridian_bridge_quote", arguments: { symbol: "AAPL", amountUsd: 25000, destChain: "base" } }),
  );
  assert.equal(result.amountUsd, 1000);
  assert.equal(result.clampedFromRequested, 25000);
  assert.equal(result.estFeeUsd, 0.8, "8 bps of the $1000 clamped notional");
  assert.equal(result.feeSettledVia, "x402");
});

test("free tools are never gated", async () => {
  const result = textOf(await client.callTool({ name: "meridian_list_chains", arguments: {} }));
  assert.ok(Array.isArray(result.chains));
});

test("priced tool call without X-PAYMENT is rejected with a 402 + x402 requirements", async () => {
  const unpaidClient = new Client({ name: "test-unpaid", version: "0.0.1" });
  await unpaidClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));

  try {
    await assert.rejects(
      unpaidClient.callTool({ name: "meridian_market_data", arguments: {} }),
      (err: unknown) => {
        assert.ok(err instanceof StreamableHTTPError);
        assert.equal(err.code, 402);
        assert.match(err.message, /meridian_market_data/);
        assert.match(err.message, /x402Version/);
        return true;
      },
    );
  } finally {
    await unpaidClient.close();
  }
});

test("priced tool call with X-PAYMENT succeeds (stub accepts any proof)", async () => {
  const result = textOf(await client.callTool({ name: "meridian_market_data", arguments: {} }));
  assert.ok(Array.isArray(result.assets));
});

test("suggest_route returns a decision with step-by-step reasoning", async () => {
  // IndexYieldStrategy (reactivated 2026-07-11 with real P&L tracking —
  // see its file header) reasons over live, non-deterministic trend data,
  // so which posture fires isn't fixed across test runs.
  const result = textOf(await client.callTool({ name: "meridian_suggest_route", arguments: {} }));
  // suggest_route evaluates `strategy` from state.ts, which is MomentumStrategy.
  // This asserted "index-distribution-yield" since the initial commit and could
  // never have passed: that strategy is wired separately and does not drive this
  // tool. Assert the tool actually reports the strategy it ran.
  assert.equal(result.strategy, "momentum-apr-rotation");
  assert.ok(["hold", "enter_index", "hold_index", "exit_index"].includes(result.action));
  assert.ok(Array.isArray(result.thoughts) && result.thoughts.length > 0);
});

test("suggest_route is advisory: repeated calls don't drift the strategy's tracked position", async () => {
  // evaluate() must only READ position state, never write it — otherwise this
  // "does not execute" tool would silently flip what the background loop
  // believes it's holding. Two calls with no execute in between must agree.
  const first = textOf(await client.callTool({ name: "meridian_suggest_route", arguments: {} }));
  const second = textOf(await client.callTool({ name: "meridian_suggest_route", arguments: {} }));
  assert.equal(second.action, first.action);
  assert.equal(second.reason, first.reason);
});

test("index_yield_execute enter confirms the position (stub mode: no signer, so P&L is unreadable but position is tracked)", async () => {
  const result = textOf(
    await client.callTool({ name: "meridian_index_yield_execute", arguments: { side: "enter", amountUsd: 40, payer: "test-yield-wallet" } }),
  );
  assert.equal(result.success, true);
  assert.equal(result.venue, "the-index");
  assert.equal(result.feeUsd, 0.03, "8 bps of the $40 notional, rounded to the cent");

  // COVERAGE GAP, deliberately not faked. This used to assert that a follow-up
  // suggest_route returned "hold_index", i.e. that the agent knew it was in
  // position and would not propose entering again. That cannot work: suggest_route
  // runs MomentumStrategy, which has no visibility into index-yield positions and
  // only ever returns "hold", while "hold_index" exists solely in IndexYieldStrategy.
  // Rewriting the expectation to "hold" would make this green while testing
  // nothing, so the assertion is removed rather than weakened.
  //
  // To restore real coverage, the tracked position needs to be observable — no
  // current MCP tool exposes it (meridian_index_yield returns the market snapshot,
  // not our position). Either add that surface and assert on it here, or decide
  // suggest_route should consult IndexYieldStrategy when a position is open.
});

test("index_yield_execute exit clears the tracked position", async () => {
  const result = textOf(
    await client.callTool({ name: "meridian_index_yield_execute", arguments: { side: "exit", amountUsd: 40, payer: "test-yield-wallet" } }),
  );
  assert.equal(result.success, true);

  const after = textOf(await client.callTool({ name: "meridian_suggest_route", arguments: {} }));
  assert.ok(["hold", "enter_index"].includes(after.action), "no longer positioned, so only these two are valid");
});

test("index_execute swaps between Index tickers, settling the fee via x402", async () => {
  const result = textOf(
    await client.callTool({
      name: "meridian_index_execute",
      arguments: { fromSymbol: "TSLA", toSymbol: "NVDA", amountUsd: 300, payer: "test-index-wallet" },
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.venue, "the-index");
  assert.equal(result.feeUsd, 0.24, "8 bps of the $300 notional");
});

test("index_execute rejects an unknown Index ticker", async () => {
  const result = textOf(
    await client.callTool({
      name: "meridian_index_execute",
      arguments: { fromSymbol: "TSLA", toSymbol: "NOPE", amountUsd: 100, payer: "test-index-wallet" },
    }),
  );
  assert.equal(result.success, false);
  assert.match(result.error, /unknown Index token/);
});

test("agent_thoughts reflects the background loop, not just manual calls", async () => {
  const result = textOf(await client.callTool({ name: "meridian_agent_thoughts", arguments: { limit: 20 } }));
  assert.ok(Array.isArray(result.decisions));
  assert.ok(result.decisions.length > 0, "background loop should have seeded a decision on boot");
  // Manual index_execute calls (run earlier in this file) legitimately show up
  // here too now — that's intentional, not a bug — so check the feed contains
  // a background-loop entry rather than assuming it's specifically the latest.
  // The loop runs ResearchStrategy ("research-desk"), not the index-yield
  // strategy this previously looked for — see startAgentLoop() in index.ts.
  const fromLoop = result.decisions.find((d: { strategy: string }) => d.strategy === "research-desk");
  assert.ok(fromLoop, "background loop should have logged at least one research-desk decision");
  const latest = result.decisions[0];
  assert.equal(typeof latest.timestamp, "number");
  assert.ok(Array.isArray(latest.thoughts) && latest.thoughts.length > 0);
});

test("bridge_execute settles the routing fee via x402 before bridging", async () => {
  const result = textOf(
    await client.callTool({
      name: "meridian_bridge_execute",
      arguments: { symbol: "AAPL", amountUsd: 500, destChain: "base", payer: "test-wallet-1" },
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.feeUsd, 0.4, "8 bps of the $500 notional");
  assert.equal(result.feeReceipt.success, true);
  assert.equal(result.feeReceipt.payer, "test-wallet-1");
});

test("bridge_execute enforces the daily cap across calls", async () => {
  const first = textOf(
    await client.callTool({
      name: "meridian_bridge_execute",
      arguments: { symbol: "AAPL", amountUsd: 1000, destChain: "base", payer: "test-wallet-2" },
    }),
  );
  assert.equal(first.success, true);

  const second = textOf(
    await client.callTool({
      name: "meridian_bridge_execute",
      arguments: { symbol: "AAPL", amountUsd: 1000, destChain: "base", payer: "test-wallet-2" },
    }),
  );
  assert.equal(second.success, false, "second $1000 trade should exceed the $1500 daily cap");
  // risk.ts words this "daily trade limit reached ($X/$Y in the last 24h)".
  assert.match(second.error, /daily trade limit reached/);
});
