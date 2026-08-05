import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer, type McpAudience } from "./mcp/server.js";
import { config, assertTreasuryIsLive } from "./config.js";
import { PaymentGate, type PaymentAmount, type SettlementAsset } from "./payments/PaymentGate.js";
import { ponsDeployment } from "./launch/pons.js";
import { RevenueLedger } from "./payments/RevenueLedger.js";
import { startAgentLoop } from "./agentLoop.js";
import { startLpGuard, openInPool } from "./lpGuard.js";
import { startMemeFastWatch } from "./memeGuard.js";
import { assetScorecard } from "./assetScorecard.js";
import { listSkills } from "./skills/registry.js";
import { runLearningPass } from "./learn/harness.js";
import { assessTokenForMM, prepareMMBand } from "./skills/marketMaking.js";
import { lpPositionsWithValue } from "./venues/lpPositions.js";
import { market, decisionLog, universe } from "./state.js";
import { executeIndexTrade } from "./actions/executeIndexTrade.js";
import { validateProfile, recordReservation, provisionUserAgent } from "./deploy/userAgents.js";
import { runConsoleCommand } from "./console.js";
import { routeCli, describeSettings } from "./cli/commands.js";
import { GatewayClient } from "@openhermit/sdk";
import { issueChallenge, linkAccount, accountData, mintSession, verifySession } from "./accounts.js";
import { ensureUserAgent, messageUserAgent, userAgentHistory, streamUserAgent, sanitizeChunk, setUserAgentSettings, agentDisplayName, userAgentSettings } from "./deploy/myAgent.js";
import { vaultStatus, buildVaultSetup, buildVaultRevoke, vaultAdapterAddress } from "./custody/vault.js";
import { custodyEnabled } from "./custody/session.js";
import { provisionResearchFleet, triggerResearchRun, houseMaxTokens } from "./research/orchestration.js";
import { rateLimitOk, tryBeginTurn, endTurn, acquireSlot, releaseSlot, chatLoad, streamIdleTimeoutMs } from "./chatLimits.js";
import { chatSpendBlocked, chatSpendStatus, recordTurn } from "./spendGuards.js";
import {
  balanceOf,
  trySpend,
  refundCredit,
  addPurchase,
  creditsEnforced,
  FREE_CREDITS,
  packs,
  packsForApi,
  merdAsset,
  merdCreditsEnabled,
} from "./credits.js";
import { pendingLaunchFor, clearPendingLaunch } from "./launch/pendingLaunches.js";
import { ResearchStrategy } from "./strategy/ResearchStrategy.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { walletOps24h } from "./risk.js";
import { securityHeaders, globalRateLimit, authRateLimit, routeKey } from "./httpGuards.js";
import { startBackups, backupStatus } from "./backup.js";
import { initLedger, ledgerStatus } from "./ledger.js";
import { scheduleOpenDeploy, runOpenDeploy, openDeployPreview } from "./openDeploy.js";
import { lpProfit } from "./lpProfit.js";
import { startEquitySnapshotter } from "./performance.js";
import { startBookSnapshotter, readBookHistory } from "./bookSnapshot.js";
import { marketMakingProof } from "./marketMakingPnl.js";
import { scanOpportunities, startLpAllocator } from "./lpAllocator.js";
import { startBasisLogger } from "./research/basisLogger.js";
import { startLighterLogger } from "./research/lighterLogger.js";
import { startYieldLogger, yieldSummary } from "./research/yieldLogger.js";
import { opportunitiesSnapshot } from "./signals/opportunities.js";
import { swarmFeed, swarmTotals, onSwarmRow } from "./swarm/feed.js";
import { rosterHealth, publicIdFor, publicIdForWallet } from "./swarm/roster.js";
import { standingFor } from "./swarm/learning.js";
import { runExchange, sidelinedIds } from "./swarm/exchange.js";
import { startSwarmLoop, swarmEnabled, dailyBudget } from "./swarm/loop.js";
import { validateFleet, recordFleet, exportBundle } from "./deploy/fleets.js";
import { getAgentSigner, getAgentAddress, getPublicClient, assertSignerIsHouseWallet } from "./venues/signer.js";
import { earnOpportunities, prepareCarry } from "./earn/carry.js";
import { prepareIndexYield } from "./earn/yieldPosition.js";
import { stakingState, prepareStake } from "./earn/staking.js";
import { runScout, scoutAllowed, bountyBoard, settleBounties, pendingPayouts, recordExternalPayout } from "./earn/scout.js";
import { knobsState, setKnob } from "./platformKnobs.js";
import { fundingHealth, logFundingHealthAtBoot } from "./fundingHealth.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { openPositionsOnChain, withdrawPosition } from "./venues/lpPositions.js";
import { realSellStockForUsdg, isTradable, tradableSymbols } from "./venues/stockPools.js";
import { fetchEthUsd } from "./venues/uniswapV4.js";
import { parseAbiItem } from "viem";

/**
 * Meridian MCP server.
 *
 * Meridian is a layer on top of OpenHermit (https://github.com/HCF-STUDIOS/openhermit):
 * OpenHermit provides the operable agent runtime (durable state, sandboxed
 * execution, fleet management), and this process supplies the RWA-DEX domain as
 * MCP tools that an OpenHermit agent connects to over Streamable HTTP.
 *
 * Register it with a gateway:
 *   POST /api/admin/mcp-servers
 *   { "id": "meridian", "name": "Meridian", "url": "http://host:8787/mcp",
 *     "headers": { "Authorization": "Bearer $MERIDIAN_MCP_TOKEN" } }
 */
// This process manages real money unattended (the LP guard withdraws/mints on
// its own). A stray async rejection anywhere — a transient RPC blip, a
// malformed upstream response — would otherwise crash the whole operator and
// silently stop it managing the position. So: log unhandled rejections and
// KEEP RUNNING (they're near-always transient and recoverable); on a truly
// uncaught synchronous exception the process state is unknown, so log and exit
// for a clean supervised restart (Railway restarts on non-zero exit).
process.on("unhandledRejection", (reason) => {
  console.error("[operator] unhandledRejection (continuing):", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[operator] uncaughtException (exiting for clean restart):", err.stack ?? err);
  process.exit(1);
});

const app = express();
// Behind Railway's proxy: trust one hop so req.ip is the real client (needed for
// per-IP rate limiting), and stop advertising Express as the server.
app.set("trust proxy", 1); // ONE hop (Railway's proxy). NOT `true`: that trusts the whole X-Forwarded-For chain, making req.ip the client-spoofable left-most value, which would let anyone bypass the per-IP rate limits by rotating a fake header.
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(globalRateLimit);
app.use("/api/account", authRateLimit); // strict guard on the expensive sign-in path
app.use(express.json({ limit: "128kb" }));

// Lightweight in-memory request accounting so /api/ops can report live load
// without an external APM. Resets on restart, like the other counters.
//
// Keyed by routeKey(), an allowlist of the prefixes this server actually
// serves, with everything else bucketed as "other". The key used to be the
// caller's own path, which made this map unbounded: a few thousand requests for
// random URLs would have grown it forever, and the rows they added were noise.
const reqStats = { total: 0, since: Date.now(), byRoute: new Map<string, number>() };
app.use((req: Request, _res: Response, next: NextFunction) => {
  reqStats.total += 1;
  const route = routeKey(req.path);
  reqStats.byRoute.set(route, (reqStats.byRoute.get(route) ?? 0) + 1);
  next();
});

// Operator-only ops snapshot: how we're handling load right now — chat
// concurrency vs the cap, request volume, unique signups, memory, uptime.
// Bearer-gated (MERIDIAN_MCP_TOKEN). All in-memory, so it resets on deploy.
app.get("/api/ops", async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
  let signups = 0;
  try {
    const p = dataPath("accounts.jsonl");
    if (existsSync(p)) {
      const addrs = new Set<string>();
      for (const l of readFileSync(p, "utf8").split("\n")) {
        if (!l.trim()) continue;
        try { addrs.add(String(JSON.parse(l).address).toLowerCase()); } catch {}
      }
      signups = addrs.size;
    }
  } catch {}
  const chat = chatLoad();
  const windowSec = Math.max(1, Math.round((Date.now() - reqStats.since) / 1000));
  // Money health, so an underfunded wallet is visible here rather than
  // discovered when a payout quietly does not happen.
  const funding = await fundingHealth().catch(() => null);
  res.json({
    funding,
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMB: mb(mem.rss), heapUsedMB: mb(mem.heapUsed) },
    chat: { ...chat, utilizationPct: Math.round((chat.active / chat.max) * 100) },
    chatSpend: chatSpendStatus(), // charged turns in the trailing 24h vs both daily ceilings
    mcpSessions: transports.size,
    wallet: walletOps24h(), // house-wallet circuit-breaker state: 24h op count + notional vs caps
    yields: yieldSummary(), // measured syrupUSDG APY (pool-price drift) + $INDEX distribution APR
    backups: backupStatus(), // Postgres mirror of the durable files: alive, last run, restores
    ledger: ledgerStatus(), // real-time row mirror: ready, inserted, failed, backfilled
    requests: {
      total: reqStats.total,
      perMin: Math.round((reqStats.total / windowSec) * 60),
      byRoute: Object.fromEntries([...reqStats.byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    },
    signups,
    now: Date.now(),
  });
});

// Live sessions keyed by the id the transport hands out on initialize. The
// OpenHermit client keeps one session across initialize -> tools/list -> calls,
// so the transport must persist between requests.
//
// Sessions are created anonymously (initialize needs no auth, x402 is the
// paywall on the tools themselves), so this map is reachable by anyone. Two
// bounds keep it finite: a hard cap on concurrent sessions, and an idle sweep,
// because a client that walks away without sending DELETE never fires onclose
// and its transport would otherwise sit here for the life of the process.
const MCP_SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS ?? 30 * 60 * 1000);
const MCP_MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS ?? 500);
const MCP_SWEEP_MS = 60_000;

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}
const transports = new Map<string, McpSession>();

/** Look a session up and stamp it as alive. Anything not looked up decays. */
function touchSession(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
  if (!sessionId) return undefined;
  const entry = transports.get(sessionId);
  if (!entry) return undefined;
  entry.lastSeenAt = Date.now();
  return entry.transport;
}

function sweepMcpSessions(): void {
  const cutoff = Date.now() - MCP_SESSION_TTL_MS;
  let closed = 0;
  for (const [id, entry] of transports) {
    if (entry.lastSeenAt > cutoff) continue;
    transports.delete(id);
    closed++;
    // Best effort: closing frees the underlying stream, and a throw here must
    // not stop the sweep from reaching the rest of the map.
    try {
      void entry.transport.close();
    } catch {}
  }
  if (closed) console.error(`[meridian-mcp] swept ${closed} idle session(s); ${transports.size} live`);
}
const mcpSweepTimer = setInterval(sweepMcpSessions, MCP_SWEEP_MS);
mcpSweepTimer.unref?.();

// Constant-time bearer check. Token comparison with `===` leaks length and
// prefix through timing; this matches the timingSafeEqual pattern already used
// for session/nonce verification in accounts.ts.
function bearerMatches(req: Request, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(req.header("authorization") ?? "");
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Loopback-only fallback, used by every gate when its token is unconfigured so
// that a deployment which forgets the token is unreachable rather than open.
// Safe behind Railway because `trust proxy` is 1, so req.ip is the real client
// and cannot be spoofed via X-Forwarded-For.
function isLoopback(req: Request): boolean {
  const ip = req.ip ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// Shared-bearer gate for operator write tools. Fails CLOSED: with no token
// configured it answers loopback only, matching tradeAuthorized/executeAuthorized.
// It previously returned true for everyone when the token was blank, which made
// a prod deploy that forgot MERIDIAN_MCP_TOKEN accept anonymous research writes
// into the pipeline the strategy consumes.
function authorized(req: Request): boolean {
  if (config.mcpToken) return bearerMatches(req, config.mcpToken);
  return isLoopback(req);
}

// FUND-MOVING tools: they sign the house wallet. Gated by the SEPARATE execute
// token (config.executeToken), which is never placed in any gateway MCP-server
// registration — so no hosted agent (house fleet or a user's chat agent) can
// ever move the house wallet through /mcp, even one that holds the shared
// mcpToken. The house's own trading runs in-process, not via /mcp.
const EXECUTE_TOOLS = new Set([
  "meridian_index_execute",
  "meridian_index_yield_execute",
  "meridian_bridge_execute",
]);

// Operator tools that WRITE to our research pipeline. Require the shared bearer
// (the trusted research fleet holds it via the "meridian" registration). Not
// fund-moving, so the shared token is an acceptable gate here.
const OPERATOR_ONLY_TOOLS = new Set([
  "meridian_submit_research",
]);

/**
 * MCP access policy, evaluated per tool call. Session plumbing (initialize,
 * tools/list, notifications, ping) and data/signal tools are open (x402 is the
 * paywall). Research-write tools require the shared bearer. Fund-moving tools
 * require the stricter execute token — and crucially, holding the shared
 * mcpToken does NOT grant fund-moving access (no blanket allow), so a user's
 * chat agent that inherits the shared token via the gateway still cannot trade.
 */
function mcpRequestAllowed(req: Request): boolean {
  const body = req.body as { method?: string; params?: { name?: string } } | undefined;
  const method = body?.method ?? "";
  if (method !== "tools/call") return true; // initialize / tools/list / notifications / ping
  const tool = body?.params?.name ?? "";
  if (EXECUTE_TOOLS.has(tool)) return executeAuthorized(req);
  if (OPERATOR_ONLY_TOOLS.has(tool)) return authorized(req);
  return true; // data/signal tools; priced ones hit the x402 gate downstream
}

/**
 * Which tool list a session is served. Both gateway registrations point at this
 * one /mcp endpoint (the operator "meridian" server carries the shared bearer
 * in its headers, the credential-free "meridian-public" one carries nothing),
 * so the audience has to be a property of the REQUEST, not of the route.
 *
 * A caller that could pass a write gate gets the full historical surface; a
 * credential-free caller gets the tools it can actually use, which is the whole
 * saving: definitions are re-sent on every model turn.
 *
 * This is NOT a gate and must never be mistaken for one. mcpRequestAllowed
 * still runs on every tools/call, so a caller that names a tool missing from
 * its own list is refused by exactly the same token check as before. Sessions
 * hold whichever server they were built with, and session ids are random
 * UUIDs, so an audience cannot be swapped mid-session by guessing one.
 */
function mcpAudience(req: Request): McpAudience {
  return authorized(req) || executeAuthorized(req) ? "operator" : "public";
}

// The trade route signs with the agent's real wallet, so it gets a stricter
// gate than /mcp: a configured token is required from everywhere, and with no
// token configured it only answers loopback (local dev). Never open to the
// network by default — a public deployment that forgets the token must fail
// closed, not fall open.
function tradeAuthorized(req: Request): boolean {
  if (config.mcpToken) return bearerMatches(req, config.mcpToken);
  return isLoopback(req);
}

// Fund-moving MCP tools use this stricter gate: the dedicated execute token,
// which lives in NO gateway registration. Fails closed — with no token
// configured, only loopback may execute, never the open network.
function executeAuthorized(req: Request): boolean {
  if (config.executeToken) return bearerMatches(req, config.executeToken);
  return isLoopback(req);
}

// Before anything can be quoted a price, prove we are not collecting into a
// wallet we retired. Throwing here stops the process; the alternative is
// running normally and misdirecting every payment. Same doctrine for the
// signer: a key that is present must be the pinned house wallet, or everything
// that explains the money follows the wrong address.
assertTreasuryIsLive();
assertSignerIsHouseWallet();
const paymentGate = new PaymentGate(config.treasuryAddress, config.x402FacilitatorUrl);
const revenue = new RevenueLedger();

/**
 * x402 gating for priced tools. MCP multiplexes every tool call through this
 * one JSON-RPC endpoint, so gating happens here rather than per-route: peek at
 * `tools/call` requests, and for a priced tool, require an X-PAYMENT header
 * before letting the request reach the MCP transport at all. Free tools and
 * every other JSON-RPC method (initialize, tools/list, ...) pass straight
 * through. Returns false (and has already written the response) if the
 * request was short-circuited with a 402.
 */
async function checkPayment(req: Request, res: Response): Promise<boolean> {
  const body = req.body as { method?: string; params?: { name?: string } } | undefined;
  if (body?.method !== "tools/call") return true;

  const toolName = body.params?.name;
  const priceUsd = toolName ? config.toolPricesUsd[toolName] : undefined;
  if (!priceUsd) return true; // free tool

  const paymentHeader = req.header("x-payment");
  if (!paymentHeader) {
    res.status(402).json(paymentGate.requirements(priceUsd, toolName!));
    return false;
  }

  const result = await paymentGate.verify(paymentHeader, priceUsd, toolName!);
  if (!result.ok) {
    res.status(402).json({ error: result.error ?? "payment verification failed" });
    return false;
  }

  revenue.record(toolName!, priceUsd, result.txHash);
  return true;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "meridian-mcp", version: "0.1.0" });
});

// The RWA universe the research swarm has gathered. Read-only, open (the census
// is public knowledge, not wallet/payment data). Surfaces what the discovery
// agents have found so we can watch the swarm's output grow.
// Realized LP profit (ground truth): fees collected − taker fees paid on churn,
// plus uncollected accrued. Read-only, open — no wallet/payment surface.
app.get("/api/lp-pnl", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json({ ok: true, ...(await lpProfit()) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/research-universe", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const venues = universe.all();
  const discoveries = venues.filter((v) => !v.isAnchor).length;
  const sourced = venues.filter((v) => (v.sources?.length ?? 0) > 0 || !!v.url).length;
  const recent = [...venues]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit)
    .map((v) => ({
      name: v.name,
      segment: v.segment,
      chains: v.chains ?? [],
      tokenizes: v.tokenizes,
      confidence: v.confidence,
      sources: v.sources ?? (v.url ? [v.url] : []),
      isAnchor: !!v.isAnchor,
      submittedBy: v.submittedBy,
    }));
  res.json({ ...universe.status(), discoveries, sourced, recent });
});

// Read-only, intentionally open (CORS: *) — this is what the frontend's live
// "agent thoughts" monitor polls. No wallet/payment data crosses this route,
// just the strategy's public reasoning over public market data, so an open
// CORS policy here doesn't carry the same risk it would on /mcp.
app.get("/api/agent-thoughts", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3, stale-while-revalidate=10"); // let browsers/CDN absorb the poll
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : 20;
  res.json({ decisions: decisionLog.recent(limit), liveTradingEnabled: config.liveTradingEnabled });
});

// Live prices for the monitored basket (18 Index tickers) — what AssetTable
// renders instead of a frozen mock file. Same open-CORS, read-only pattern as
// /api/agent-thoughts: public market data, no wallet/payment surface.
// Grounded opportunity feed: deterministic ranking over the measured samplers.
// Public read (only observed on-chain/market data, no wallet surface), cached.
app.get("/api/opportunities", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.json(opportunitiesSnapshot());
});

app.get("/api/market-data", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=15");
  res.json({ assets: market.listAssets(), source: market.dataSource() });
});

// The agent wallet's REAL holdings — stock tokens (valued at live market
// prices), USDG, and native ETH — so the frontend's position card reflects
// what's actually on-chain, not just what a strategy narrates. Same open-CORS
// read-only pattern; the wallet address is public on-chain data anyway.
// Cached briefly: each refresh is ~20 RPC reads and multiple UI clients poll.
const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const balanceOfAbi = [parseAbiItem("function balanceOf(address) view returns (uint256)")];
let portfolioCache: { at: number; payload: unknown } | null = null;

app.get("/api/portfolio", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=15");
  const walletAddress = getAgentAddress();
  if (!walletAddress) {
    res.json({ available: false, reason: "no wallet configured" });
    return;
  }
  if (portfolioCache && Date.now() - portfolioCache.at < 10_000) {
    res.json(portfolioCache.payload);
    return;
  }
  try {
    const client = getPublicClient();
    const prices = new Map(market.listAssets().map((a) => [a.symbol, a.priceUsd]));
    const [stockBalances, ethRaw, usdgRaw, ethUsd] = await Promise.all([
      readStockBalances(walletAddress),
      client.getBalance({ address: walletAddress }),
      client.readContract({ address: USDG_ADDR, abi: balanceOfAbi, functionName: "balanceOf", args: [walletAddress] }),
      fetchEthUsd().catch(() => null),
    ]);
    const holdings = Object.entries(stockBalances)
      .filter(([, tokens]) => tokens > 1e-6)
      .map(([symbol, tokens]) => ({ symbol, tokens, valueUsd: tokens * (prices.get(symbol) ?? 0) }))
      .filter((h) => h.valueUsd >= 0.01)
      .sort((a, b) => b.valueUsd - a.valueUsd);
    // Capital deployed as LP liquidity lives in the PositionManager, not the
    // wallet — without this the portfolio would show the cash gone and the
    // position invisible.
    const lp = await lpPositionsWithValue().catch(() => []);
    const eth = Number(ethRaw) / 1e18;
    const usdg = Number(usdgRaw) / 1e6;
    const ethValueUsd = ethUsd != null ? eth * ethUsd : null;
    const totalUsd =
      holdings.reduce((s, h) => s + h.valueUsd, 0) + lp.reduce((s, p) => s + p.valueUsd, 0) + usdg + (ethValueUsd ?? 0);
    const payload = {
      available: true,
      wallet: walletAddress,
      holdings,
      lp: lp.map((p) => ({
        tokenId: p.tokenId,
        symbol: p.symbol,
        valueUsd: p.valueUsd,
        inRange: p.inRange,
        rangePct: p.rangePct,
        usdgAmount: p.usdgAmount,
        tokenAmount: p.tokenAmount,
      })),
      cash: { usdg, eth, ethValueUsd },
      totalUsd,
      asOf: Date.now(),
    };
    portfolioCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    // A transient RPC hiccup (a rate-limit 429, say) shouldn't blank the UI:
    // serve the last good snapshot if we have one, flagged stale.
    if (portfolioCache) {
      res.json({ ...(portfolioCache.payload as Record<string, unknown>), stale: true });
      return;
    }
    res.status(502).json({ available: false, reason: err instanceof Error ? err.message : String(err) });
  }
});

// Writes a trade — still CORS-open like /api/agent-thoughts (no auth model
// exists yet for the frontend), but POST + JSON means browsers preflight with
// OPTIONS first, so that needs a response too, not just the actual POST.
function setTradeCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("/api/index-trade", (_req: Request, res: Response) => {
  setTradeCors(res);
  res.sendStatus(204);
});

app.post("/api/index-trade", async (req: Request, res: Response) => {
  setTradeCors(res);
  if (!tradeAuthorized(req)) {
    res.status(401).json({ success: false, error: "live execution is restricted to the Meridian agent on this deployment" });
    return;
  }
  const { fromSymbol, toSymbol, amountUsd, payer } = req.body ?? {};
  if (!fromSymbol || !toSymbol || !amountUsd || !payer) {
    res.status(400).json({ success: false, error: "fromSymbol, toSymbol, amountUsd, and payer are required" });
    return;
  }
  const outcome = await executeIndexTrade({ fromSymbol, toSymbol, amountUsd: Number(amountUsd), payer });
  res.json(outcome);
});

// Ledger sync between a key-holding operator machine and a read-only instance.
//
// WHICH SIDE IS AUTHORITATIVE FOLLOWS THE SIGNER KEY, NOT THE HOSTNAME. Whoever
// has AGENT_SIGNER_PRIVATE_KEY plus MERIDIAN_LP_ENGINE=on runs the LP guard and
// therefore writes the real lp-positions/executions rows; the other side is
// the one that goes stale and needs this push.
//
// As deployed today the KEY IS SET IN RAILWAY, so the cloud is the guard and the
// cloud's ledgers are the truth. In that topology this route must NOT be used to
// push a laptop's copies up: it is a whole-file REPLACE, so a stale local file
// would silently overwrite prod's real position and execution history — the same
// history /api/proof and /api/lp-pnl compute from. scripts-pushState.sh does
// exactly that and is deliberately left unscheduled.
//
// Bearer-gated, strict filename allowlist.
const SYNCABLE_FILES = new Set(["lp-positions.jsonl", "executions.jsonl", "equity-snapshots.jsonl"]);
app.post("/api/sync-state", (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { file, content } = (req.body ?? {}) as { file?: string; content?: string };
  if (!file || !SYNCABLE_FILES.has(file) || typeof content !== "string" || content.length > 5_000_000) {
    res.status(400).json({ error: "file must be one of the syncable ledgers, content a string" });
    return;
  }
  writeFileSync(dataPath(file), content);
  res.json({ ok: true, file, bytes: content.length });
});

// The proof instrument: isolated market-making P&L (fees - impermanent loss -
// gas, vs holding). The honest, on-chain-reproducible answer to "is the agent
// profitable." Open, read-only.
// The desk's decision journal: every rotation, collect, bank, expansion,
// migration and stop-loss, with the reason it happened. Read-only, public,
// because the whole posture is that the decisions are checkable; Merd's
// autopilot reads this to narrate the desk on the timeline.
// Per-asset performance across multiple metric points: market side (price,
// measured drift, liquidity, holders) and the desk's own results (collects,
// stops, rotations from the journal). Public, like every number here.
// The agent skills catalog: what a creator's agent can turn on, with honest
// state and custody. Public and read-only.
// The learning harness scoreboard (SHADOW): how much data, is the model
// beating the dumb baseline out-of-sample yet. Nothing here drives a trade.
// The book series that drives the live chart: server-sampled every 2 minutes,
// one shared continuous line for every visitor. Public, read-only.
app.get("/api/book-history", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json({ points: readBookHistory() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "book history unavailable" });
  }
});

app.get("/api/learn/status", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json(runLearningPass());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "learn status unavailable" });
  }
});

app.get("/api/skills", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ skills: listSkills() });
});

// Market-making skill, front door: can the desk quote this token, at what
// price. Read-only; no funds move.
// Prepare a signable market-making band for a creator's own wallet
// (self-custody; Meridian signs nothing). Returns the unsigned tx.
app.get("/api/skills/mm/prepare", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = String(req.query.token ?? "");
  const creator = String(req.query.creator ?? "");
  const eth = Number(req.query.eth ?? 0);
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    res.status(400).json({ error: "token and creator must be 0x-prefixed 40-hex addresses" });
    return;
  }
  if (!(eth > 0) || eth > 100) {
    res.status(400).json({ error: "eth must be a positive amount under 100" });
    return;
  }
  try {
    res.json(await prepareMMBand(token as `0x${string}`, creator as `0x${string}`, eth));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "cannot prepare a band for this token" });
  }
});

app.get("/api/skills/mm/assess", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = String(req.query.token ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    res.status(400).json({ error: "token must be a 0x-prefixed 40-hex address" });
    return;
  }
  try {
    res.json(await assessTokenForMM(token as `0x${string}`));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "assessment unavailable" });
  }
});

app.get("/api/asset-scorecard", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json(await assetScorecard());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "scorecard unavailable" });
  }
});

app.get("/api/desk-journal", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const path = dataPath("meme-rotations.jsonl");
    const lines = existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).slice(-100)
      : [];
    const entries = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ entries, count: entries.length });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "journal unavailable" });
  }
});

app.get("/api/proof", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json(await marketMakingProof());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "proof unavailable" });
  }
});

// The LP opportunity scanner: every LP-viable pool ranked by expected net $/day,
// plus a report-only move recommendation. Open, read-only.
//
// Served at /api/lp-scan, NOT /api/opportunities — this was registered as a
// second handler on that path, and Express serves the first match, so it had
// been dead code since the day it was added: the `capital` query silently did
// nothing and callers got the deterministic snapshot instead. /api/opportunities
// stays the snapshot (Merd's autopilot consumes that shape).
//
// No `capital` query => sized from the wallet's REAL deployable capital. Pass
// one to ask "what would $X earn"; that answer is explicitly excluded from the
// cache the autonomous rebalancer reads.
app.get("/api/lp-scan", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const raw = Number(req.query.capital);
    const capital = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 10), 100000) : undefined;
    res.json(await scanOpportunities(capital));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "scan unavailable" });
  }
});

// The public console: read-only commands answered from live agent state.
// Safe for the open internet by construction — see console.ts.
app.options("/api/console", (_req: Request, res: Response) => {
  setTradeCors(res);
  res.sendStatus(204);
});

app.post("/api/console", async (req: Request, res: Response) => {
  setTradeCors(res);
  const cmd = typeof req.body?.cmd === "string" ? req.body.cmd : "";
  res.json({ lines: await runConsoleCommand(cmd) });
});

// Wallet-as-account sign-in. Connect → sign a challenge → the wallet is a
// verified account, and everything keyed to it (reserved profiles, later
// agents + spend) is "theirs." Open CORS: called from the browser, no secrets.
app.options("/api/account/challenge", (_req: Request, res: Response) => { setTradeCors(res); res.sendStatus(204); });
app.post("/api/account/challenge", (req: Request, res: Response) => {
  setTradeCors(res);
  const challenge = issueChallenge((req.body ?? {}).address);
  if (!challenge) { res.status(400).json({ error: "valid address required" }); return; }
  res.json(challenge);
});

app.options("/api/account/link", (_req: Request, res: Response) => { setTradeCors(res); res.sendStatus(204); });
app.post("/api/account/link", async (req: Request, res: Response) => {
  setTradeCors(res);
  const { address, nonce, signature } = req.body ?? {};
  const result = await linkAccount({ address, nonce, signature });
  if (!result.ok) { res.status(401).json({ ok: false, error: result.error }); return; }
  res.json({ ok: true, account: result.account, session: mintSession(result.account.address) });
});

app.get("/api/account/:address", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const data = accountData(req.params.address);
  if (!data) { res.status(400).json({ error: "invalid address" }); return; }
  res.json(data);
});

// ---- Your own agent (wallet-native, day one) --------------------------------
// These routes are gated by the SIWE session bearer minted at /api/account/link.
// The wallet IS the account: the bearer proves control, and every route acts
// only on that wallet's own agent. No funds move here; this is conversation.
function setWalletCors(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // X-Payment is not optional here. The x402 flow settles in two calls: the
  // first gets a 402 challenge and carries no proof, the second carries the
  // payment in an X-PAYMENT header. Leaving it out of the allow-list let the
  // challenge through and blocked the settlement, so a browser sent real USDG
  // on-chain and then failed the verification call with "Failed to fetch". The
  // money moved, the credits did not, and nothing server-side ever saw it. Any
  // header the client actually sends has to be listed here.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Payment");
}

/** Resolve the wallet a request proves, or write a 401 and return null. */
function requireWallet(req: Request, res: Response): string | null {
  const header = req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const address = verifySession(token);
  if (!address) {
    res.status(401).json({ ok: false, error: "sign in with your wallet to reach your agent" });
    return null;
  }
  return address;
}

// Synchronous chat guards: #1 the daily spend ceilings, then #4 per-wallet rate
// limit, then #2 per-wallet single-flight. Returns an error to send, or null to
// proceed. When it returns null the caller holds the wallet's single-flight lock
// and MUST endTurn().
function chatGuardSync(address: string): { status: number; error: string; code?: string } | null {
  // The daily ceilings first: they are the only guard that BOUNDS spend rather
  // than shaping it, and they are the cheapest to evaluate (one cached fold).
  // Rejecting here also costs no token from the bucket and takes no lock, so a
  // capped wallet cannot be told it is capped and rate limited on the same try.
  const ceiling = chatSpendBlocked(address);
  if (ceiling) return { status: ceiling.status, error: ceiling.error, code: ceiling.code };
  if (!rateLimitOk(address)) {
    return { status: 429, error: "you're sending messages faster than your agent can think — give it a moment" };
  }
  if (!tryBeginTurn(address)) {
    return { status: 409, error: "your agent is still responding to your last message" };
  }
  return null;
}

app.options("/api/my-agent/ensure", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/my-agent/ensure", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  try {
    const result = await ensureUserAgent(address);
    res.json({ ok: true, ...result, name: agentDisplayName(address), settings: userAgentSettings(address), credits: balanceOf(address) });
  } catch (err) {
    console.error("[my-agent] ensure failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, error: "could not reach the agent runtime — try again shortly" });
  }
});


// Customize this wallet's agent (session-gated). Today: rename. The settings
// store is an extensible object, so future knobs land here without a new route.
app.options("/api/my-agent/settings", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });

// The read side of the same object, so the customize panel can render current
// state (including joinSwarm, this wallet's opt-in to the public agent feed)
// without having to POST first. Same settings object /ensure returns.
app.get("/api/my-agent/settings", (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  const settings = userAgentSettings(address);
  res.json({ ok: true, settings, joinSwarm: settings.joinSwarm === true });
});

// The Meridian CLI. One typed line in, lines of text out.
//
// Customising an agent used to mean finding a button in the chat panel, opening
// a modal, filling a form and saving it. This puts the same capabilities next to
// the conversation as commands, where /help discovers them and the agent can
// tell you what to type.
//
// The routing is PURE (src/cli/commands.ts) and this route is the only thing
// that can act. Every settings change goes through setUserAgentSettings, the
// same path the form used, so the CLI cannot become a second laxer door onto
// values that end up interpolated into the agent's persona prompt. Desk
// commands are handed to runConsoleCommand rather than reimplemented, so the
// CLI and the public desk can never disagree about what "status" means.
//
// Chat is deliberately NOT handled here: it returns an intent and the client
// posts to /stream, so a conversational turn keeps its streaming, its credit
// debit, and its guards instead of acquiring a second, quieter path.
app.options("/api/cli", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/cli", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  const line = typeof (req.body ?? {}).line === "string" ? (req.body.line as string) : "";
  if (line.length > 2000) { res.status(400).json({ ok: false, lines: ["that is too long for one line."] }); return; }

  try {
    const before = userAgentSettings(address);
    const routed = routeCli(line, before);

    switch (routed.effect.kind) {
      case "none":
      case "clear":
        res.json({ ok: !routed.error, lines: routed.lines, effect: routed.effect.kind, suggest: routed.suggest });
        return;

      case "chat":
        // The client streams this. Handing back the text rather than proxying it
        // keeps one implementation of a chat turn instead of two.
        res.json({ ok: true, lines: [], effect: "chat", text: routed.effect.text });
        return;

      case "settings": {
        const result = await setUserAgentSettings(address, routed.effect.patch);
        if ("error" in result) { res.json({ ok: false, lines: [result.error], effect: "settings" }); return; }
        // Echo the new state rather than "saved": the point of a CLI is that you
        // can see what you just did without opening anything.
        res.json({ ok: true, lines: describeSettings(result.settings), effect: "settings", settings: result.settings });
        return;
      }

      case "read": {
        if (routed.effect.what === "settings") {
          res.json({ ok: true, lines: describeSettings(before), effect: "read" });
          return;
        }
        if (routed.effect.what === "credits") {
          const balance = balanceOf(address);
          const enforced = creditsEnforced();
          // The cost model is worth stating every time, because it is the thing
          // a CLI makes legible that a chat box could not: a command is routed
          // and read locally, a message calls a model. Only one of those costs.
          res.json({
            ok: true,
            effect: "read",
            lines: enforced
              ? [
                  `${balance} credits`,
                  ``,
                  `  1 credit   one message to your agent`,
                  `  free       every /command, including the desk ones`,
                  `  free       earn: park idle cash, stock payouts, scout to earn`,
                  ``,
                  // Stated plainly because it is the part people will not
                  // assume: running out of credits stops the conversation, not
                  // the earning. Scouting is capped at three runs a day on its
                  // own terms and never looks at this balance.
                  `running out stops the conversation, not your agent's earning.`,
                  ``,
                  balance > 0 ? `/buy to top up before you run out.` : `you are out. /buy to keep going.`,
                ]
              : [
                  `${balance} credits, but charging is OFF right now, so messages are free.`,
                  ``,
                  `nothing is being deducted and nothing is for sale until that changes.`,
                  `the balance is real and will be there when it turns on.`,
                ],
          });
          return;
        }
        if (routed.effect.what === "swarm") {
          // The one place opting in is argued for or against honestly. When the
          // agent is out, state the trade rather than the feature: what it gets,
          // then what it costs, then the command. When it is in, show the actual
          // sentences it brought back, because those are the whole return and
          // they were previously visible to nobody.
          const standing = standingFor(publicIdForWallet(address));
          const on = before.joinSwarm === true;
          if (!on) {
            res.json({
              ok: true,
              effect: "read",
              lines: [
                `swarm is off. your agent only ever talks to you.`,
                ``,
                `turned on, it gets put in conversation with our own desks, about what`,
                `the house book actually did that day. it argues its corner, and it keeps`,
                `one conclusion from each conversation. those go into its instructions, so`,
                `it comes back to you knowing them.`,
                ``,
                `what it costs you: those conversations are public on the swarm tab, under`,
                `the name you gave it. your wallet is not, and never appears there. it is`,
                `told not to discuss you, your balance or your goal. it is not charged.`,
                ``,
                // Someone who has been in and left still has the conclusions in
                // their agent. Leaving withdraws the conversations from the feed,
                // not the agent's own reasoning, and a toggle whose leftovers are
                // invisible is a toggle people are right not to trust.
                ...(standing.takeaways.length
                  ? [
                      `you have been in before. the ${standing.takeaways.length} thing${standing.takeaways.length === 1 ? "" : "s"} your agent concluded back then are`,
                      `dormant while it is out, and come back if you rejoin. nothing was deleted.`,
                      ``,
                    ]
                  : []),
                `  /swarm on`,
              ],
            });
            return;
          }
          if (!standing.exchanges) {
            res.json({
              ok: true,
              effect: "read",
              lines: [
                `swarm is on. your agent has not been picked for a conversation yet.`,
                `pairing rotates through everyone, so it will be. /swarm again to check.`,
              ],
            });
            return;
          }
          const met = standing.partners.slice(0, 3).join(", ");
          res.json({
            ok: true,
            effect: "read",
            lines: [
              `swarm is on. ${standing.exchanges} conversation${standing.exchanges === 1 ? "" : "s"} so far${met ? `, with ${met}` : ""}.`,
              ...(standing.takeaways.length
                ? [
                    ``,
                    `what it took from them, newest first. these are in its instructions now,`,
                    `so it brings them into your conversations too:`,
                    ``,
                    ...standing.takeaways.map((t) => `  - ${t}`),
                    ``,
                    `read the conversations in full on the swarm tab. /swarm off to leave.`,
                  ]
                : [`it has spoken but not concluded anything yet. /swarm off to leave.`]),
            ],
          });
          return;
        }
        if (routed.effect.what === "packs") {
          if (!creditsEnforced()) {
            res.json({
              ok: true,
              effect: "read",
              lines: [
                `nothing to buy: charging is off, so messages are free right now.`,
                `your ${balanceOf(address)} credits stay yours for when it turns on.`,
              ],
            });
            return;
          }
          const rows = packs().map(
            (p) => `  ${p.id.padEnd(9)} $${String(p.usd).padEnd(4)} ${p.credits} credits${p.bonusPct ? `  (+${p.bonusPct}%)` : ""}`,
          );
          res.json({
            ok: true,
            effect: "read",
            lines: [`credit packs, paid in USDG:`, ``, ...rows, ``, `/buy <pack> to start. you sign the payment in your wallet.`],
          });
          return;
        }
        const status = swarmEnabled();
        res.json({ ok: true, effect: "read", lines: [`the public agent feed is ${status ? "running" : "paused"}.`, `your agent is ${before.joinSwarm === true ? "in it" : "not in it"} (/swarm on|off).`] });
        return;
      }

      case "buy": {
        // Captured before the first call: TypeScript drops the narrowing on a
        // property access once an arbitrary function has run in between.
        const wanted = routed.effect.pack;
        if (!creditsEnforced()) {
          res.json({ ok: false, effect: "buy", lines: [`charging is off, so there is nothing to buy right now. messages are free.`] });
          return;
        }
        const pack = packs().find((p) => p.id === wanted);
        if (!pack) {
          res.json({
            ok: false,
            effect: "buy",
            lines: [`no pack called "${wanted}".`, `choose one of: ${packs().map((p) => p.id).join(", ")}`],
          });
          return;
        }
        // The client takes it from here: it holds the wallet, so it runs the
        // x402 challenge and the signature. Returning the pack rather than a
        // half-finished purchase keeps signing in exactly one place.
        res.json({
          ok: true,
          effect: "buy",
          pack: pack.id,
          lines: [`${pack.credits} credits for $${pack.usd} in USDG.`, `check your wallet to approve the payment.`],
        });
        return;
      }

      case "desk": {
        const lines = await runConsoleCommand(routed.effect.command);
        res.json({ ok: true, lines, effect: "desk" });
        return;
      }
    }
  } catch (err) {
    console.error("[cli] failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, lines: ["something broke running that. try again shortly."] });
  }
});

app.post("/api/my-agent/settings", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  try {
    const result = await setUserAgentSettings(address, req.body ?? {});
    if ("error" in result) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, settings: result.settings });
  } catch (err) {
    console.error("[my-agent] settings failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, error: "could not update your agent — try again shortly" });
  }
});

app.options("/api/my-agent/message", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/my-agent/message", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  const text = typeof (req.body ?? {}).text === "string" ? (req.body.text as string).trim() : "";
  if (!text) { res.status(400).json({ ok: false, error: "empty message" }); return; }
  if (text.length > 2000) { res.status(400).json({ ok: false, error: "message too long (2000 char max)" }); return; }
  const guard = chatGuardSync(address);
  if (guard) { res.status(guard.status).json({ ok: false, code: guard.code, error: guard.error }); return; }
  // One credit per user-initiated turn. Debit lives ONLY on this route and
  // /stream: system-driven turns (scout runs, sessionKind sessions) call the
  // agent directly and never charge. After the guards so a rate-limited retry
  // costs nothing, before the slot wait so a wallet at zero never occupies
  // capacity it cannot pay for.
  const spend = trySpend(address);
  if (!spend.ok) {
    endTurn(address);
    res.status(402).json({ ok: false, code: "out_of_credits", error: "you're out of credits. grab a pack to keep talking to your agent.", balance: spend.balance });
    return;
  }
  const slot = await acquireSlot();
  if (!slot) {
    // Turned away at the door under load: the turn never reached the agent, so
    // the credit goes straight back.
    refundCredit(address, 1, "refund:busy");
    endTurn(address);
    res.status(503).json({ ok: false, error: "high demand right now, try again in a few seconds" });
    return;
  }
  try {
    const reply = await messageUserAgent(address, text);
    // The gateway reports some failures as a resolved reply carrying an error
    // instead of throwing. No text means no answer, so it is refunded like any
    // other failed turn rather than silently charged.
    if (reply.error && !reply.text) {
      refundCredit(address, 1, "refund:agent-error");
      res.status(502).json({ ok: false, error: "your agent could not respond just now, try again shortly" });
      return;
    }
    res.json({ ok: true, ...reply, credits: spend.balance });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[my-agent] message failed:", msg);
    // A failed turn is never charged. The exception is a timeout: the agent
    // very likely finished the turn on its side and the answer is readable from
    // /history, so refunding there would hand out free turns to anyone who can
    // make a prompt run long.
    if (!/timed?\s*out|timeout/i.test(msg)) refundCredit(address, 1, "refund:error");
    const status = msg === "gateway_unconfigured" ? 503 : 502;
    res.status(status).json({ ok: false, error: "your agent could not respond just now, try again shortly" });
  } finally {
    releaseSlot();
    endTurn(address);
  }
});

app.options("/api/my-agent/stream", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/my-agent/stream", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  const text = typeof (req.body ?? {}).text === "string" ? (req.body.text as string).trim() : "";
  if (!text) { res.status(400).json({ ok: false, error: "empty message" }); return; }
  if (text.length > 2000) { res.status(400).json({ ok: false, error: "message too long (2000 char max)" }); return; }

  // Guards BEFORE the SSE headers, so an overflow gets a clean JSON error
  // rather than a half-open stream.
  const guard = chatGuardSync(address);
  if (guard) { res.status(guard.status).json({ ok: false, code: guard.code, error: guard.error }); return; }
  // Same debit placement as /message: after the guards, before the SSE headers
  // and the slot wait, so an out-of-credits wallet gets a clean JSON 402.
  const spend = trySpend(address);
  if (!spend.ok) {
    endTurn(address);
    res.status(402).json({ ok: false, code: "out_of_credits", error: "you're out of credits. grab a pack to keep talking to your agent.", balance: spend.balance });
    return;
  }
  const slot = await acquireSlot();
  if (!slot) {
    refundCredit(address, 1, "refund:busy"); // never reached the agent, never charged
    endTurn(address);
    res.status(503).json({ ok: false, error: "high demand right now, try again in a few seconds" });
    return;
  }

  // Server-Sent Events: one JSON object per `data:` frame. X-Accel-Buffering
  // off so proxies don't buffer the stream into one chunk.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Abort the gateway stream only if the CLIENT hangs up. Use res 'close' (fires
  // on real disconnect) — req 'close' fires as soon as the POST body is consumed
  // and would abort every stream before it starts.
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  // Server-side idle watchdog. A gateway that stops emitting mid-stream leaves
  // the for-await below waiting forever, and with it a global chat slot and this
  // wallet's single-flight lock, which is how one hung upstream turn wedges a
  // wallet out of chat until the process restarts. The clock runs on the GAP
  // between events, not on the whole turn, so a long answer that keeps producing
  // is never cut off. Armed before the first await so a gateway that never
  // answers at all is covered too, re-armed on every event, cleared in finally.
  let watchdogFired = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // The client got there first, so this is their hangup, not our timeout.
      // Claiming it would turn a cancelled stream into a refund.
      if (ac.signal.aborted) return;
      watchdogFired = true;
      console.error(`[my-agent] stream idle for ${streamIdleTimeoutMs()}ms with ${deltas} deltas, aborting a wedged turn`);
      ac.abort();
    }, streamIdleTimeoutMs());
  };
  // The watchdog aborts the SAME controller the client hangup uses, so
  // `ac.signal.aborted` alone can no longer mean "the user left". Refund and
  // error-frame decisions below ask this instead.
  const clientHungUp = () => ac.signal.aborted && !watchdogFired;

  let deltas = 0;
  let sawError = false;
  try {
    armWatchdog();
    const stream = await streamUserAgent(address, text, ac.signal);
    for await (const ev of stream) {
      armWatchdog();
      if (ev.type === "text_delta") { deltas++; send({ type: "delta", text: sanitizeChunk(ev.text) }); }
      else if (ev.type === "text_final") send({ type: "final", text: sanitizeChunk(ev.text) });
      else if (ev.type === "tool_call") send({ type: "tool", tool: ev.tool });
      else if (ev.type === "error") { sawError = true; send({ type: "error", message: ev.message }); }
      else if (ev.type === "agent_end") break;
    }
    // A stream that ends normally but produced only an error frame and no text
    // is a failed turn wearing a clean exit. Refund it like a thrown one.
    const balance = sawError && deltas === 0 ? refundCredit(address, 1, "refund:agent-error") : spend.balance;
    send({ type: "done", credits: balance });
    console.error(`[my-agent] stream ok: ${deltas} deltas`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[my-agent] stream failed (aborted=${ac.signal.aborted}, watchdog=${watchdogFired}, deltas=${deltas}):`, msg);
    // A hard failure before any output means the user paid for nothing: refund.
    // A client abort is the user's own hangup, and a stream that already
    // delivered text was a real (if truncated) answer, so neither refunds. A
    // watchdog abort is NOT the user leaving: they are still on the other end,
    // still owed an answer, and if nothing arrived they are owed the credit.
    if (!clientHungUp() && deltas === 0) refundCredit(address, 1, "refund:error");
    if (!clientHungUp()) {
      send({ type: "error", message: watchdogFired ? "your agent stopped responding partway through, try again shortly" : "your agent could not respond just now, try again shortly" });
    }
  } finally {
    clearTimeout(idleTimer);
    res.end();
    releaseSlot();
    endTurn(address);
  }
});

// A launch the wallet's agent has prepared and simulated, waiting to be signed.
//
// This is the structured-data channel the chat cannot be: the agent's reply is
// prose, and a transaction is not. The tool stashes the payload keyed by the
// creator wallet; only that wallet's own session can read it back.
//
// Nothing here signs or broadcasts. The worst an agent can do by naming someone
// else as creator is put a proposal in front of a person who never asked, and
// they decline it — which is why it is safe for this to be a plain read.
app.options("/api/my-agent/pending-launch", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.get("/api/my-agent/pending-launch", (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  res.json({ ok: true, launch: pendingLaunchFor(address) });
});

// Signed, or declined — either way it should stop being offered.
app.options("/api/my-agent/pending-launch/clear", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/my-agent/pending-launch/clear", (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  clearPendingLaunch(address);
  res.json({ ok: true });
});

// This wallet's credit balance plus what a pack costs. Reading the balance
// also settles the lazy signup grant, so a first-time visitor sees their free
// messages instead of a zero.
app.options("/api/my-agent/credits", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
// Where this wallet's agent stands with the swarm, as data rather than as the
// prose /swarm prints. The swarm page needs to render the decision (in or out,
// and what being in has actually produced) without parsing CLI output, and the
// two must not drift, so both read the same standingFor over the same rows.
//
// Wallet-scoped: it is about YOUR agent, and the takeaways are shown next to
// "these are in its instructions", which is only true for the owner.
app.get("/api/my-agent/swarm", (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  const standing = standingFor(publicIdForWallet(address));
  res.json({
    ok: true,
    optedIn: userAgentSettings(address).joinSwarm === true,
    enabled: swarmEnabled(),
    exchanges: standing.exchanges,
    partners: standing.partners,
    takeaways: standing.takeaways,
  });
});

app.get("/api/my-agent/credits", (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  // merdPayments and each pack's merdWei let a UI show or hide the MERD option
  // from what the server actually accepts, instead of guessing at it. Both are
  // false/absent until MERD exists and a price is set.
  res.json({
    ok: true,
    balance: balanceOf(address),
    freeMessages: FREE_CREDITS,
    packs: packsForApi(),
    // Whether a message is ACTUALLY being charged for. Without this the site
    // advertises a paywall it may not be running: the pricing page said "20 free
    // messages" and sold packs while charging was switched off, so every number
    // on it was a claim about a rule nothing was enforcing. A UI can now say
    // what is true today rather than what the price list says.
    enforced: creditsEnforced(),
    merdPayments: merdCreditsEnabled(),
    merdAsset: merdCreditsEnabled() ? merdAsset() : null,
  });
});

// Buy a credit pack. Same x402 flow as priced tools: no X-PAYMENT header gets
// the payment requirements, a verified header gets credits. The verify step
// burns the tx, so a payment can never buy two packs, and the purchase lands
// in both the credits ledger and the revenue ledger under its tx hash.
//
// Two ways to pay: USDG (the default, unchanged) or MERD, which stays refused
// until MERD is deployed AND the operator has set a flat MERD price per pack.
// Either way the pack is the same pack for the same credits.
// Credit a payment that landed on-chain but never settled, because the browser
// died between the transfer and the verification call. Operator-only, and it
// reads the payer from the transfer log rather than taking one on trust, so it
// can only ever credit the wallet whose tokens actually moved.
app.post("/api/admin/credits/settle", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const { txHash, pack: packId } = (req.body ?? {}) as { txHash?: string; pack?: string };
  const pack = packs().find((p) => p.id === packId);
  if (!pack) { res.status(400).json({ ok: false, error: `unknown pack. choose one of: ${packs().map((p) => p.id).join(", ")}` }); return; }
  if (typeof txHash !== "string") { res.status(400).json({ ok: false, error: "txHash required" }); return; }
  try {
    const settled = await paymentGate.settleStranded(txHash, pack.usd, "credits:" + pack.id);
    if (!settled.ok) { res.status(400).json({ ok: false, error: settled.error }); return; }
    const balance = addPurchase(settled.payer, pack.id, pack.credits, settled.txHash);
    try { revenue.record("credits:" + pack.id, pack.usd, settled.txHash); } catch { /* bookkeeping only */ }
    res.json({ ok: true, payer: settled.payer, added: pack.credits, balance });
  } catch (err) {
    console.error("[credits] stranded settle failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.options("/api/credits/buy", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/credits/buy", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  // Charging is off, so there is nothing to sell. Without this the route still
  // issued a 402, took real USDG, and banked credits nobody needs, while
  // /api/cli told the same user "charging is off, there is nothing to buy".
  // Taking money for a product we have stopped selling is the one outcome
  // worth a hard refusal.
  if (!creditsEnforced()) {
    res.status(409).json({
      ok: false,
      error: "chat is free right now, so credits are not for sale. Nothing was charged.",
    });
    return;
  }
  const body = req.body ?? {};
  const packId = body.pack;
  const catalogue = packs();
  const pack = catalogue.find((p) => p.id === packId);
  if (!pack) {
    res.status(400).json({ ok: false, error: `unknown pack. choose one of: ${catalogue.map((p) => p.id).join(", ")}` });
    return;
  }
  const pay = String(body.pay ?? "usdg").toLowerCase();
  if (pay !== "usdg" && pay !== "merd") {
    res.status(400).json({ ok: false, error: 'unknown payment asset. choose "usdg" or "merd"' });
    return;
  }

  // Resolve what is being charged BEFORE any challenge is issued. A 402 for an
  // asset that cannot actually be paid would send someone to a token that does
  // not exist, so an unavailable MERD is a plain 400 and never a payment
  // challenge.
  let asset: SettlementAsset | undefined;
  let price: PaymentAmount = pack.usd;
  if (pay === "merd") {
    const merd = merdAsset();
    if (!merdCreditsEnabled() || !merd || pack.merdWei === undefined) {
      res.status(400).json({
        ok: false,
        error: "paying in MERD is not available yet. MERD is not live, so credit packs are USDG only for now.",
        merdPayments: false,
      });
      return;
    }
    asset = merd;
    price = pack.merdWei;
  }

  const resource = "credits:" + pack.id;
  const header = req.header("x-payment");
  if (!header) {
    res.status(402).json({ ok: false, ...paymentGate.requirements(price, resource, asset), packs: packsForApi() });
    return;
  }
  try {
    // MERD does NOT land in the treasury: merdAsset routes it to the burn
    // address, so paying in MERD takes those tokens out of circulation at the
    // moment of payment. USDG still pays into the treasury as it always has.
    const result = await paymentGate.verify(header, price, resource, asset);
    if (!result.ok) {
      res.status(402).json({ ok: false, error: result.error ?? "payment verification failed", ...paymentGate.requirements(price, resource, asset) });
      return;
    }
    // Verification has already burned the tx, so the credits must land next and
    // nothing between may throw. Revenue accounting is bookkeeping, not the
    // user's purchase, so a failure there is logged and never costs them credits.
    // The credits are the pack's credits whatever it was paid in: MERD buys the
    // same pack, with no bonus and no discount.
    const balance = addPurchase(address, pack.id, pack.credits, result.txHash);
    try {
      // The revenue ledger's only unit is USD. A MERD sale has no USD figure we
      // are willing to state (there is no price for MERD, which is exactly why
      // its pack price is flat), so booking pack.usd here would invent dollars
      // that never arrived. It records 0 USD under a separate key, with the raw
      // amount in the reference, so the sale is auditable and the revenue total
      // stays true.
      if (asset) revenue.record(`${resource}:merd-burned`, 0, `${result.txHash ?? "unknown-tx"} ${pack.merdWei} MERD-wei burned`);
      else revenue.record(resource, pack.usd, result.txHash);
    } catch (err) {
      console.error("[credits] revenue record failed (purchase stands):", err instanceof Error ? err.message : err);
    }
    res.json({ ok: true, added: pack.credits, balance, paidIn: asset ? asset.symbol : "USDG" });
  } catch (err) {
    // Express 4 does not route a rejected async handler to the error middleware,
    // so an unhandled throw here would hang the request with no response.
    console.error("[credits] buy failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, error: "could not verify that payment just now. if it was sent, contact us and we will credit it." });
  }
});

app.options("/api/my-agent/history", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.get("/api/my-agent/history", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  try {
    res.json({ ok: true, turns: await userAgentHistory(address) });
  } catch (err) {
    console.error("[my-agent] history failed:", err instanceof Error ? err.message : err);
    res.json({ ok: true, turns: [] });
  }
});

// ---- The swarm: agents talking to each other, in public ---------------------
// Reads are open (CORS: *) like the other public GETs. A published exchange is
// public by construction, and no wallet or payment data crosses these routes.
// Only agents that may speak are ever in here: our own house agents, and a
// user's agent only once that user set joinSwarm on their own settings.
// Everything served is a real reply a real agent gave; there is no seeded,
// sample or placeholder content anywhere in this path, so an empty feed is an
// empty array and the UI says so.
app.get("/api/swarm/feed", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=15");
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 50) : 20;
  res.json({ ok: true, enabled: swarmEnabled(), exchanges: swarmFeed(limit) });
});

// `participants` counts agents that can ACTUALLY speak (present on the gateway
// and, for a user's agent, opted in), because a count of merely-configured
// agents is how an empty feed gets mistaken for a quiet one. `missing` names
// the eligible agents the gateway is not hosting, which is the usual answer to
// "why has nothing happened".
app.get("/api/swarm/status", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
  const totals = swarmTotals();
  try {
    const health = await rosterHealth();
    res.json({
      enabled: swarmEnabled(),
      participants: health.live.length,
      roster: health.live,
      missing: health.missing,
      // Present on the gateway but unable to speak. Distinct from `missing`,
      // which is not provisioned at all, and the distinction matters when
      // diagnosing an empty feed: this list means the agent exists and is broken.
      // Raw gateway ids, so they get the same redaction as the roster: a broken
      // agent is still somebody's, and "which wallets are failing" is not public.
      sidelined: sidelinedIds().map(publicIdFor),
      gatewayReachable: health.gatewayReachable,
      exchanges: totals.exchanges,
      lastAt: totals.lastAt,
    });
  } catch (err) {
    console.error("[swarm] status failed:", err instanceof Error ? err.message : err);
    res.json({ enabled: swarmEnabled(), participants: 0, roster: [], missing: [], gatewayReachable: false, exchanges: totals.exchanges, lastAt: totals.lastAt });
  }
});

// Live tail of the feed: every row is pushed the moment it is written, so the
// terminal fills in as the conversation actually happens rather than on a poll.
app.get("/api/swarm/stream", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders?.();
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "open", enabled: swarmEnabled() });
  const unsubscribe = onSwarmRow((row) => send({ type: "row", row }));
  // Idle connections die silently through proxies; a comment frame keeps the
  // pipe warm without polluting the client's message handler.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
  heartbeat.unref?.();
  res.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
    res.end();
  });
});

// Operator-only: fire ONE exchange now, so the feed can be populated (or a
// gateway problem diagnosed) without turning the scheduler on. Same bearer as
// every other privileged route.
app.options("/api/swarm/run", (_req: Request, res: Response) => { setTradeCors(res); res.sendStatus(204); });
app.post("/api/swarm/run", async (req: Request, res: Response) => {
  setTradeCors(res);
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  // The manual trigger spends exactly what a scheduled one does, so it answers
  // to the same daily budget. Without this, the cap only limits the loop and a
  // scripted caller could run all day around it.
  const budget = dailyBudget();
  if (budget.remaining <= 0) {
    res.status(429).json({ ok: false, reason: "daily_cap_reached", ...budget });
    return;
  }
  try {
    const result = await runExchange();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Earn (live): advise-then-approve carry + scout-to-earn -----------------
// /opportunities and /prepare are open reads: they quote public pool state and
// build calldata the caller's OWN wallet must sign — nothing here holds a key
// or moves funds. /scout is SIWE-gated (it spends real model tokens and accrues
// real bounty) and runs under the same chat guards as /api/my-agent/message.
app.get("/api/earn/opportunities", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const address = typeof req.query.address === "string" ? req.query.address : undefined;
  if (!address) res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
  try {
    const [opps, staking] = await Promise.all([earnOpportunities(address), stakingState(address)]);
    // staking is folded in rather than a separate call, and is present only when
    // MERD is live: while dormant it is { enabled: false } and the card hides.
    res.json({ ...opps, ...(staking.enabled ? { staking } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg === "invalid address" ? 400 : 502).json({ error: msg });
  }
});

app.options("/api/earn/prepare", (_req: Request, res: Response) => { setTradeCors(res); res.sendStatus(204); });
app.post("/api/earn/prepare", async (req: Request, res: Response) => {
  setTradeCors(res);
  const { address, amountUsd, amountMerd, direction, kind } = req.body ?? {};
  try {
    if (kind === "staking") {
      res.json(await prepareStake({ address, amountMerd: Number(amountMerd), direction }));
      return;
    }
    const prepare = kind === "index-yield" ? prepareIndexYield : prepareCarry;
    res.json(await prepare({ address, amountUsd: Number(amountUsd), direction }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isValidation = /invalid|must be|no USDG|no syrupUSDG|no payout|not enough|above the|not live|minimum stake|no staked/.test(msg);
    res.status(isValidation ? 400 : 502).json({ ok: false, error: msg });
  }
});

app.get("/api/earn/bounties", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const address = typeof req.query.address === "string" ? req.query.address : undefined;
  res.json(bountyBoard(address));
});

// ---- Custody (auto-trading vaults) · PREVIEW ----
// Behind CUSTODY_SESSION_MASTER: dormant until configured, and never exposed to
// the live site until the scope is tightened + audited. Owner actions return
// calldata the USER signs; the backend signs nothing here. Balances are public,
// so status is an open read; setup/revoke are session-gated to the user's own
// vault (the session address IS the wallet — no body address to spoof).
app.get("/api/custody/status", async (req: Request, res: Response) => {
  setTradeCors(res);
  const address = typeof req.query.address === "string" ? req.query.address.trim() : "";
  // Answer the dormant case first. Custody is off, so there is nothing to look
  // up on-chain and no reason to reach for an RPC: this used to fall through to
  // vaultStatus with an empty string and hand an unauthenticated caller a raw
  // viem message ("Address \"\" is invalid"). Internal errors are not an API.
  if (!custodyEnabled()) { res.json({ enabled: false, active: false }); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ enabled: true, error: "pass ?address=0x… to read a vault's status" });
    return;
  }
  try {
    res.json(await vaultStatus(address));
  } catch (err) {
    console.error("[custody] status failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ enabled: true, error: "could not read that vault just now" });
  }
});

app.options("/api/custody/prepare-setup", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/custody/prepare-setup", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  try {
    res.json(await buildVaultSetup(address));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg === "custody_disabled" ? 503 : 502).json({ ok: false, error: msg === "custody_disabled" ? "auto-trading isn't enabled yet" : msg });
  }
});

app.options("/api/custody/prepare-revoke", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/custody/prepare-revoke", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  try {
    res.json(await buildVaultRevoke(address));
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.options("/api/earn/scout", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
app.post("/api/earn/scout", async (req: Request, res: Response) => {
  setWalletCors(res);
  const address = requireWallet(req, res);
  if (!address) return;
  // Bounty caps BEFORE the chat guards — a capped wallet shouldn't spend a turn.
  const allowed = scoutAllowed(address);
  if (!allowed.ok) { res.status(429).json({ ok: false, error: allowed.reason }); return; }
  const guard = chatGuardSync(address);
  if (guard) { res.status(guard.status).json({ ok: false, code: guard.code, error: guard.error }); return; }
  // METERED, NEVER CHARGED.
  //
  // A scout run is a real model turn, so it is recorded against the global
  // ceiling exactly like a chat turn: the runaway stop has to see every turn we
  // pay for or it is not a stop. But it does not take a credit.
  //
  // Credits buy conversation with your agent. Earning is not conversation, and
  // charging here inverts the whole proposition: it asks somebody to spend
  // money for the chance to be paid $0.10, and it puts the paywall in front of
  // the one surface whose entire point is that value flows the other way. The
  // cost is already bounded without it, and bounded harder than credits ever
  // bounded it: three runs per wallet per day, and a global bounty pool that
  // closes for the day once it is spent. Those caps are checked above.
  recordTurn(address);
  const slot = await acquireSlot();
  if (!slot) {
    endTurn(address);
    res.status(503).json({ ok: false, error: "high demand right now, try again in a few seconds" });
    return;
  }
  try {
    // `refundable` is what the run reports when it produced nothing. There is
    // nothing to refund now, but it stays part of the result so the shape does
    // not change under callers.
    const { refundable: _refundable, ...result } = await runScout(address);
    res.json({ ...result, credits: balanceOf(address) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[earn/scout] failed:", msg);
    const status = msg === "gateway_unconfigured" ? 503 : 502;
    res.status(status).json({ ok: false, error: "your agent could not scout just now, try again shortly" });
  } finally {
    releaseSlot();
    endTurn(address);
  }
});

// Operator-only: pay accrued scout bounties in USDG from the house wallet.
app.post("/api/admin/settle-bounties", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  try {
    res.json(await settleBounties());
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// The Merd-pays flow: his treasury wallet signs payouts from the machine his
// runtime lives on, because no server here holds that key. This pair is the
// backend's half: the settle-worthy set out, the landed tx hashes back in.
// Do not run operator settle-bounties in the same window as the remote payer;
// recordExternalPayout is atomic against it, but a transfer already in flight
// on the other side cannot be un-sent.
app.get("/api/admin/pending-payouts", (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  res.json(pendingPayouts());
});

app.post("/api/admin/record-payout", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  try {
    const body = (req.body ?? {}) as { wallet?: unknown; amountUsd?: unknown; txHash?: unknown };
    res.json(await recordExternalPayout(body));
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// The dials Merd turns himself. The ranges live in platformKnobs.ts and are
// not settable over the wire: this surface can move a value inside its walls,
// never move a wall.
app.get("/api/admin/knobs", (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  res.json(knobsState());
});

app.post("/api/admin/knobs", (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const body = (req.body ?? {}) as { name?: unknown; value?: unknown; reason?: unknown; by?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  const by = typeof body.by === "string" && /^[a-z0-9_-]{1,24}$/i.test(body.by) ? body.by : "operator";
  res.json(setKnob(name, body.value, reason, by));
});

// Profiler reservations from the site. Public write-only waitlist endpoint:
// strict schema validation, append-only ledger, and (token permitting) the
// profile is provisioned as a gateway agent immediately — the ecosystem
// onboarding happens entirely back here, never named in the frontend.
app.options("/api/reserve-profile", (_req: Request, res: Response) => {
  setTradeCors(res);
  res.sendStatus(204);
});

app.post("/api/reserve-profile", async (req: Request, res: Response) => {
  setTradeCors(res);
  // Orphaned since the flow moved to SIWE chat (/api/my-agent/*). Bearer-gated
  // so the public can't spam it — it PROVISIONS a gateway agent per call, a
  // real resource-abuse/DoS vector if left open.
  if (!authorized(req) || !config.mcpToken) { res.status(403).json({ ok: false, error: "disabled — deploy via wallet sign-in" }); return; }
  const profile = validateProfile(req.body);
  if (!profile) {
    res.status(400).json({ ok: false, error: "invalid profile" });
    return;
  }
  recordReservation(profile);
  let status: "provisioned" | "queued" = "queued";
  try {
    status = await provisionUserAgent(profile);
  } catch (err) {
    console.error(`[deploy] ${profile.callsign} provisioning failed, stays queued:`, err instanceof Error ? err.message : err);
  }
  res.json({ ok: true, callsign: profile.callsign, status });
});

// Self-host fleet export: body {mandates: string[], posture, wallet?} ->
// a bundle of files the user runs against THEIR OpenHermit gateway. Public
// and unauthenticated on purpose: it contains only the caller's own inputs
// plus our public MCP URL — never a Meridian token (their agents pay per
// call via x402). This is the "graduate to your own infrastructure" path.
app.options("/api/fleet/export", (_req: Request, res: Response) => {
  setTradeCors(res);
  res.sendStatus(204);
});

app.post("/api/fleet/export", (req: Request, res: Response) => {
  setTradeCors(res);
  // Orphaned public write (appends to the fleet ledger). Bearer-gate it.
  if (!authorized(req) || !config.mcpToken) { res.status(403).json({ ok: false, error: "disabled" }); return; }
  const spec = validateFleet(req.body);
  if (!spec) {
    res.status(400).json({ ok: false, error: "invalid fleet spec: mandates (1-3 of momentum|carry|basis) and posture required" });
    return;
  }
  recordFleet(spec, "export");
  res.json({ ok: true, fleetId: spec.fleetId, agents: spec.mandates.length, files: exportBundle(spec) });
});

// Operator-only: manage provisioned gateway agents (list / delete). Bearer-
// gated. Needed to clean up or retire agents on the (private) hosted gateway.
app.get("/api/admin/agents", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!config.gatewayAdminToken) { res.status(503).json({ error: "no gateway configured" }); return; }
  try {
    const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
    res.json({ agents: (await gw.listAgents()).map((a) => ({ agentId: a.agentId, name: a.name })) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: repair a gateway agent whose stored config is incomplete.
//
// An agent can exist, appear in the roster, and still be unable to receive a
// single message: the gateway validates the STORED config when it uses the
// agent, so one provisioned with missing fields fails every call with a
// validation error rather than at creation time. Production had exactly that in
// a fleet agent (workspace_root, model.max_tokens and memory all undefined),
// and because swarm pairing is deterministic it silently killed every exchange
// that agent's slot came up for.
//
// Get-merge-put, and only ever FILLS what is missing: an existing value is never
// overwritten, so repairing a half-broken agent cannot quietly change the model
// or the memory settings of a working one. workspace_root is derived from a
// healthy sibling ON THE SAME GATEWAY rather than guessed, because the path
// convention differs between a container and a laptop and a wrong root would
// swap one silent failure for another.
app.post("/api/admin/agents/repair-config", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const agentId = (req.body ?? {}).agentId;
  if (typeof agentId !== "string" || !agentId) { res.status(400).json({ error: "agentId required" }); return; }
  try {
    const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
    const before = ((await gw.getAgentConfig(agentId)) ?? {}) as Record<string, unknown>;

    // A sibling whose config carries the fields we need, so every default we
    // apply is one this gateway is already running rather than one we invented.
    let ref: Record<string, unknown> | null = null;
    for (const a of await gw.listAgents()) {
      if (a.agentId === agentId) continue;
      const c = ((await gw.getAgentConfig(a.agentId).catch(() => null)) ?? {}) as Record<string, unknown>;
      if (typeof c.workspace_root === "string" && c.memory && typeof c.memory === "object") { ref = c; break; }
    }
    if (!ref) { res.status(409).json({ ok: false, error: "no healthy sibling agent to copy conventions from" }); return; }

    const filled: string[] = [];
    const next: Record<string, unknown> = { ...before };

    if (typeof next.workspace_root !== "string" || !next.workspace_root) {
      // Same parent directory as the sibling, this agent's own id as the leaf.
      const sibling = ref.workspace_root as string;
      const parent = sibling.slice(0, sibling.lastIndexOf("/"));
      next.workspace_root = `${parent}/${agentId}`;
      filled.push("workspace_root");
    }
    const model = { ...((before.model ?? {}) as Record<string, unknown>) };
    if (typeof model.max_tokens !== "number") {
      // Our value, not the reference agent's: copying a sibling would spread
      // whatever wrong number that one happens to be carrying.
      model.max_tokens = houseMaxTokens();
      filled.push("model.max_tokens");
    }
    if (typeof model.provider !== "string") { model.provider = (ref.model as any)?.provider ?? "openrouter"; filled.push("model.provider"); }
    if (typeof model.model !== "string") { model.model = (ref.model as any)?.model ?? "anthropic/claude-haiku-4.5"; filled.push("model.model"); }
    next.model = model;

    if (!next.memory || typeof next.memory !== "object") { next.memory = ref.memory; filled.push("memory"); }
    if (!next.channels || typeof next.channels !== "object") { next.channels = ref.channels ?? {}; filled.push("channels"); }
    if (!next.web || typeof next.web !== "object") { next.web = ref.web ?? {}; filled.push("web"); }

    if (!filled.length) { res.json({ ok: true, agentId, filled: [], note: "config already complete" }); return; }

    await gw.putAgentConfig(agentId, next);
    const after = ((await gw.getAgentConfig(agentId)) ?? {}) as Record<string, unknown>;
    console.error(`[admin] repaired config for ${agentId}: filled ${filled.join(", ")}`);
    res.json({ ok: true, agentId, filled, workspaceRoot: after.workspace_root, model: after.model });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/admin/agents/delete", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const agentId = (req.body ?? {}).agentId;
  if (typeof agentId !== "string" || !agentId) { res.status(400).json({ error: "agentId required" }); return; }
  try {
    const gw = new GatewayClient({ baseUrl: config.gatewayUrl, token: config.gatewayAdminToken });
    await gw.manageAgent(agentId, "disable").catch(() => {}); // gateway requires disabled-before-delete
    await gw.deleteAgent(agentId);
    console.error(`[admin] disabled + deleted gateway agent ${agentId}`);
    res.json({ ok: true, deleted: agentId });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: bring the RWA research swarm online. Re-registers the MCP
// servers at the current publicMcpUrl (fixes a stale 127.0.0.1 registration)
// and provisions the chosen segment agents. Runs here because only the backend
// can reach the gateway on the internal network.
app.post("/api/admin/provision-research", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const raw = (req.body ?? {}).segments;
  const segments = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
  if (!segments.length) { res.status(400).json({ ok: false, error: "provide segments: string[]" }); return; }
  // Recurring research cadence is opt-in per call: agents without schedules cost
  // nothing to keep around, agents with them wake on cron and spend every time.
  const schedules = (req.body ?? {}).schedules === true;
  try {
    const result = await provisionResearchFleet(segments, { schedules });
    console.error(`[admin] provisioned research: ${result.provisioned.join(", ") || "none"}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: manually wake one research agent to run a discovery sweep now,
// so we can watch data actually land instead of waiting for the cron.
app.post("/api/admin/research-run", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
  const agentId = (req.body ?? {}).agentId;
  if (typeof agentId !== "string" || !agentId) { res.status(400).json({ ok: false, error: "agentId required" }); return; }
  try {
    const result = await triggerResearchRun(agentId);
    res.json({ ok: true, agentId, ...result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: close all LP positions (and optionally consolidate all
// depth-verified stock to USDG). Runs ON the operator so the authoritative
// ledger is updated in-place — no split-brain. Bearer-required (moves money).
app.post("/api/lp-close", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const toCash = (req.body ?? {}).toCash === true;
  try {
    // Serialize against the LP guard's tick and any other operator action so a
    // close can't interleave with an autonomous retile on the same wallet.
    const { closed, sold } = await withHouseWalletLock("lp-close", async () => {
      const closed: Array<{ tokenId: string; symbol: string; txHash: string }> = [];
      for (const p of await openPositionsOnChain()) {
        const r = await withdrawPosition({ tokenId: p.tokenId, symbol: p.symbol, liquidity: p.liquidity });
        closed.push({ tokenId: p.tokenId, symbol: p.symbol, txHash: r.txHash });
      }
      const sold: Array<{ symbol: string; usdgReceived: number; txHash: string }> = [];
      if (toCash) {
        const addr = getAgentAddress();
        const balances = addr ? await readStockBalances(addr) : {};
        for (const [sym, qty] of Object.entries(balances)) {
          if (qty > 1e-6 && isTradable(sym)) {
            const r = await realSellStockForUsdg({ fromSymbol: sym });
            sold.push({ symbol: sym, usdgReceived: r.usdgReceived, txHash: r.hash });
          }
        }
      }
      return { closed, sold };
    });
    console.error(`[lp-close] closed ${closed.length} position(s)${toCash ? `, sold ${sold.length} holding(s) to USDG` : ""}`);
    res.json({ ok: true, closed, sold });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: the one-shot open-deploy (convert idle ETH -> USDG -> LP per
// the env plan). {dryRun:true} previews plan/prices/balances without moving
// anything; a real POST executes immediately (same guarded path the scheduler
// fires at the open). Bearer-required, same tier as lp-open/lp-close.
app.post("/api/open-deploy", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    if ((req.body ?? {}).dryRun === true) {
      res.json({ dryRun: true, ...(await openDeployPreview()) });
      return;
    }
    res.json(await runOpenDeploy());
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Operator-only: open a market-making position in a SPECIFIC tradable pool
// (e.g. a newly-discovered one like SPCX). Deploys the wallet's available USDG;
// run on a flat wallet (close the current position first). Bearer-required.
app.post("/api/lp-open", async (req: Request, res: Response) => {
  if (!authorized(req) || !config.mcpToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const symbol = String((req.body ?? {}).symbol ?? "").toUpperCase();
  const widthPct = Number((req.body ?? {}).widthPct);
  if (!symbol || !isTradable(symbol)) {
    res.status(400).json({ ok: false, error: `symbol must be a tradable pool (${tradableSymbols().join(", ")})` });
    return;
  }
  try {
    const pos = await withHouseWalletLock("lp-open", () =>
      openInPool(symbol, Number.isFinite(widthPct) && widthPct > 0 ? widthPct : undefined),
    );
    console.error(`[lp-open] opened #${pos.tokenId} in ${pos.symbol}`);
    res.json({ ok: true, ...pos });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/mcp", async (req: Request, res: Response) => {
  if (!mcpRequestAllowed(req)) {
    res.status(401).json({ error: "this tool is operator-only; data tools need no auth, just x402 payment" });
    return;
  }
  if (!(await checkPayment(req, res))) return;

  const sessionId = req.header("mcp-session-id");
  let transport = touchSession(sessionId);

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session; send an initialize request first" },
        id: null,
      });
      return;
    }
    // Sweep before refusing: the cap exists to bound the map, not to lock the
    // server out of new sessions because old ones were never closed cleanly.
    if (transports.size >= MCP_MAX_SESSIONS) sweepMcpSessions();
    if (transports.size >= MCP_MAX_SESSIONS) {
      console.error(`[meridian-mcp] session cap reached (${transports.size}/${MCP_MAX_SESSIONS}), refusing new sessions`);
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "too many open MCP sessions right now, try again shortly" },
        id: null,
      });
      return;
    }
    // New session: fresh transport + server, registered once the handshake completes.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, { transport: transport!, lastSeenAt: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    await buildServer({ audience: mcpAudience(req) }).connect(transport);
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[meridian-mcp] request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

// GET (server-initiated SSE stream) and DELETE (session teardown) reuse the
// established session transport.
async function replaySessionRequest(req: Request, res: Response) {
  // Session streams/teardown carry no tool call — same policy as plumbing.
  if (!req.header("mcp-session-id") && !authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const transport = touchSession(req.header("mcp-session-id"));
  if (!transport) {
    res.status(400).json({ error: "unknown or missing session id" });
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", replaySessionRequest);
app.delete("/mcp", replaySessionRequest);

// The public "thoughts" feed is narrated by ResearchStrategy: every cycle it
// surfaces real, measured research rather than reasoning about a position.
// The momentum `strategy` singleton stays wired to meridian_suggest_route for
// callers who want a rotation route, but it does not drive the live desk — that
// was showing momentum reasoning while the wallet was market-making.
//
// Whatever is passed here MUST be narrate-only. startAgentLoop can execute, so
// the single thing standing between this line and autonomous trading is that
// the strategy plugged into it only ever returns `hold`. ResearchStrategy has
// exactly one return statement and it is a hold. Two earlier narrators kept for
// the same reason are MarketMakingStrategy (superseded by this one) and
// IdleStrategy — the latter is a deliberate no-op kept as a drop-in kill switch
// after an uncontrolled re-entry bought 68,702.5 $INDEX with real ETH.
startAgentLoop(market, new ResearchStrategy(), decisionLog, config.agentThinkIntervalMs);

// NOTE: Merd's X voice is NOT wired here. It runs out of process, driven by
// launchd (_merd-post.sh -> _merd-autopilot.mts), where an LLM is handed live
// state and his own memory and DECIDES what to say. A template composer was
// briefly started from here and it was a downgrade in every sense: it published
// canned lines during cycles the real Merd had gone quiet in, and its output
// landed in the same ledger he reads back as his own history.
// See src/social/README.md.

// The autonomous money loops. startLpGuard withdraws, rebalances, retiles and
// mints REAL liquidity on a 5-minute tick using the house wallet's key, and
// startLpAllocator scans and moves capital between pools. Neither was gated by
// anything before, which meant `deploy` and `start managing funds` were the
// same action, including on a fresh box, on a rollback, or on a restart nobody
// intended. AGENT_LIVE_TRADING does NOT cover these; it only gates the
// momentum/index path, which is a different set of transactions entirely.
//
// Explicit opt-in, so the default of a newly deployed instance is to serve the
// API and touch nothing.
if (process.env.MERIDIAN_LP_ENGINE === "on") {
  console.log("[boot] LP engine ON: autonomous liquidity management is live");
  startLpGuard();
  startLpAllocator();
  // Seconds-scale fill detection for the meme book: flips filled bands to the
  // sell side in under a minute. Same house lock, own kill switch.
  startMemeFastWatch();
} else {
  console.log("[boot] LP engine off (set MERIDIAN_LP_ENGINE=on to enable autonomous liquidity management)");
}
// Which chain user-facing token launches land on. PONS only exists on mainnet,
// so this is stated at boot rather than inferred from an env var.
{
  const pons = ponsDeployment();
  console.log(`[boot] launchpad: PONS on chain ${pons.chainId} (${pons.factory})`);
}
startEquitySnapshotter();
startBookSnapshotter();
startSwarmLoop(); // agent-to-agent exchanges on a cadence; logs whether it is on or off
if (process.env.MERIDIAN_RUN_BASIS_LOGGER === "1") startBasisLogger();
if (process.env.MERIDIAN_RUN_LIGHTER_LOGGER === "1") startLighterLogger();
if (process.env.MERIDIAN_RUN_YIELD_LOGGER === "1") startYieldLogger();
void logFundingHealthAtBoot(); // says what the wallets can actually pay for, before anything needs them to
startBackups(); // Postgres mirror of the durable JSONL/JSON state + boot-time restore
void initLedger(); // row-level Postgres ledger: table + one-time history backfill, then live dual-writes
scheduleOpenDeploy(); // one-shot capital deployment at the next open, if a plan is configured

// Global error handler (registered last): log the real error server-side and
// return a generic message, so a route exception can never leak internals
// (RPC/viem details, file paths, stack) to a caller.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  // A body express could not parse is the CALLER's mistake, not ours, and it
  // was answering 500. That is wrong twice: it tells the client to retry
  // something that will never work, and it buries real server faults in a log
  // full of noise anyone can generate by sending a bare brace.
  const status = (err as { status?: number; type?: string } | null)?.status;
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.parse.failed" || (status === 400 && type)) {
    res.status(400).json({ error: "malformed request body" });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: "request body too large" });
    return;
  }
  console.error("[http] unhandled route error:", err instanceof Error ? err.stack : err);
  res.status(500).json({ error: "internal error" });
});

app.listen(config.mcpPort, config.mcpHost, () => {
  const auth = config.mcpToken ? "bearer-auth" : "open (no token)";
  console.log(
    `Meridian MCP server on http://${config.mcpHost}:${config.mcpPort}/mcp (${auth})`,
  );
  console.log(
    `Agent loop thinking every ${config.agentThinkIntervalMs}ms — GET /api/agent-thoughts to watch`,
  );

  // Custody moves USER funds, so its state is said out loud at boot rather than
  // inferred from two env vars nobody looks at. Arming it takes BOTH a master
  // secret and a deployed adapter, and the half-configured case is called out
  // because that is the one somebody reaches while thinking they finished.
  const master = custodyEnabled();
  const adapter = vaultAdapterAddress();
  if (master && adapter) {
    console.log(`[custody] LIVE. Session keys armed, trades scoped to adapter ${adapter}.`);
    console.log(`[custody] This moves user funds. It should not be on unless that adapter is deployed AND audited.`);
  } else if (master || adapter) {
    console.log(
      `[custody] half-configured and therefore OFF: ${master ? "master secret set, adapter missing" : "adapter set, master secret missing"}. ` +
        `Both are required, so nothing is armed.`,
    );
  } else {
    console.log(`[custody] off (no session master, no adapter). User funds are untouched by design.`);
  }
});
