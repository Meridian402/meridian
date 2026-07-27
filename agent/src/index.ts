import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dataPath } from "./dataDir.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./mcp/server.js";
import { config, assertTreasuryIsLive } from "./config.js";
import { PaymentGate } from "./payments/PaymentGate.js";
import { RevenueLedger } from "./payments/RevenueLedger.js";
import { startAgentLoop } from "./agentLoop.js";
import { startLpGuard, openInPool } from "./lpGuard.js";
import { lpPositionsWithValue } from "./venues/lpPositions.js";
import { market, decisionLog, universe } from "./state.js";
import { executeIndexTrade } from "./actions/executeIndexTrade.js";
import { validateProfile, recordReservation, provisionUserAgent } from "./deploy/userAgents.js";
import { runConsoleCommand } from "./console.js";
import { GatewayClient } from "@openhermit/sdk";
import { issueChallenge, linkAccount, accountData, mintSession, verifySession } from "./accounts.js";
import { ensureUserAgent, messageUserAgent, userAgentHistory, streamUserAgent, sanitizeChunk, setUserAgentSettings, agentDisplayName, userAgentSettings } from "./deploy/myAgent.js";
import { vaultStatus, buildVaultSetup, buildVaultRevoke } from "./custody/vault.js";
import { provisionResearchFleet, triggerResearchRun } from "./research/orchestration.js";
import { rateLimitOk, tryBeginTurn, endTurn, acquireSlot, releaseSlot, chatLoad } from "./chatLimits.js";
import { pendingLaunchFor, clearPendingLaunch } from "./launch/pendingLaunches.js";
import { ResearchStrategy } from "./strategy/ResearchStrategy.js";
import { withHouseWalletLock } from "./houseWallet.js";
import { walletOps24h } from "./risk.js";
import { securityHeaders, globalRateLimit, authRateLimit } from "./httpGuards.js";
import { startBackups, backupStatus } from "./backup.js";
import { initLedger, ledgerStatus } from "./ledger.js";
import { scheduleOpenDeploy, runOpenDeploy, openDeployPreview } from "./openDeploy.js";
import { lpProfit } from "./lpProfit.js";
import { performanceSummary, startEquitySnapshotter } from "./performance.js";
import { marketMakingProof } from "./marketMakingPnl.js";
import { scanOpportunities, startLpAllocator } from "./lpAllocator.js";
import { startBasisLogger } from "./research/basisLogger.js";
import { startLighterLogger } from "./research/lighterLogger.js";
import { startYieldLogger, yieldSummary } from "./research/yieldLogger.js";
import { opportunitiesSnapshot } from "./signals/opportunities.js";
import { validateFleet, recordFleet, exportBundle } from "./deploy/fleets.js";
import { getAgentSigner, getAgentAddress, getPublicClient } from "./venues/signer.js";
import { earnOpportunities, prepareCarry } from "./earn/carry.js";
import { prepareIndexYield } from "./earn/yieldPosition.js";
import { runScout, scoutAllowed, bountyBoard, settleBounties } from "./earn/scout.js";
import { readStockBalances } from "./venues/positionAccounting.js";
import { openPositionsOnChain, withdrawPosition } from "./venues/lpPositions.js";
import { realSellStockForUsdg, isTradable, TRADABLE_SYMBOLS } from "./venues/stockPools.js";
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
const reqStats = { total: 0, since: Date.now(), byRoute: new Map<string, number>() };
app.use((req: Request, _res: Response, next: NextFunction) => {
  reqStats.total += 1;
  const route = "/" + req.path.split("/").filter(Boolean).slice(0, 2).join("/");
  reqStats.byRoute.set(route, (reqStats.byRoute.get(route) ?? 0) + 1);
  next();
});

// Operator-only ops snapshot: how we're handling load right now — chat
// concurrency vs the cap, request volume, unique signups, memory, uptime.
// Bearer-gated (MERIDIAN_MCP_TOKEN). All in-memory, so it resets on deploy.
app.get("/api/ops", (req: Request, res: Response) => {
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
  res.json({
    uptimeSec: Math.round(process.uptime()),
    memory: { rssMB: mb(mem.rss), heapUsedMB: mb(mem.heapUsed) },
    chat: { ...chat, utilizationPct: Math.round((chat.active / chat.max) * 100) },
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
const transports = new Map<string, StreamableHTTPServerTransport>();

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
// running normally and misdirecting every payment.
assertTreasuryIsLive();
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
// has AGENT_SIGNER_PRIVATE_KEY runs the LP guard (startLpGuard is unconditional)
// and therefore writes the real lp-positions/executions rows; the other side is
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

// The track record: annotated, on-chain-audited performance history. Open,
// read-only — the public proof surface behind the "nothing to hide" thesis.
app.get("/api/performance", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    res.json(await performanceSummary());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "performance unavailable" });
  }
});

// The proof instrument: isolated market-making P&L (fees - impermanent loss -
// gas, vs holding). The honest, on-chain-reproducible answer to "is the agent
// profitable." Open, read-only.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

// Synchronous chat guards: #4 per-wallet rate limit, then #2 per-wallet
// single-flight. Returns an error to send, or null to proceed. When it returns
// null the caller holds the wallet's single-flight lock and MUST endTurn().
function chatGuardSync(address: string): { status: number; error: string } | null {
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
    res.json({ ok: true, ...result, name: agentDisplayName(address), settings: userAgentSettings(address) });
  } catch (err) {
    console.error("[my-agent] ensure failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ ok: false, error: "could not reach the agent runtime — try again shortly" });
  }
});

// Customize this wallet's agent (session-gated). Today: rename. The settings
// store is an extensible object, so future knobs land here without a new route.
app.options("/api/my-agent/settings", (_req: Request, res: Response) => { setWalletCors(res); res.sendStatus(204); });
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
  if (guard) { res.status(guard.status).json({ ok: false, error: guard.error }); return; }
  const slot = await acquireSlot();
  if (!slot) { endTurn(address); res.status(503).json({ ok: false, error: "high demand right now — try again in a few seconds" }); return; }
  try {
    const reply = await messageUserAgent(address, text);
    res.json({ ok: true, ...reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[my-agent] message failed:", msg);
    const status = msg === "gateway_unconfigured" ? 503 : 502;
    res.status(status).json({ ok: false, error: "your agent could not respond just now — try again shortly" });
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
  if (guard) { res.status(guard.status).json({ ok: false, error: guard.error }); return; }
  const slot = await acquireSlot();
  if (!slot) { endTurn(address); res.status(503).json({ ok: false, error: "high demand right now — try again in a few seconds" }); return; }

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

  let deltas = 0;
  try {
    const stream = await streamUserAgent(address, text, ac.signal);
    for await (const ev of stream) {
      if (ev.type === "text_delta") { deltas++; send({ type: "delta", text: sanitizeChunk(ev.text) }); }
      else if (ev.type === "text_final") send({ type: "final", text: sanitizeChunk(ev.text) });
      else if (ev.type === "tool_call") send({ type: "tool", tool: ev.tool });
      else if (ev.type === "error") send({ type: "error", message: ev.message });
      else if (ev.type === "agent_end") break;
    }
    send({ type: "done" });
    console.error(`[my-agent] stream ok: ${deltas} deltas`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[my-agent] stream failed (aborted=${ac.signal.aborted}, deltas=${deltas}):`, msg);
    if (!ac.signal.aborted) send({ type: "error", message: "your agent could not respond just now — try again shortly" });
  } finally {
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
    res.json(await earnOpportunities(address));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg === "invalid address" ? 400 : 502).json({ error: msg });
  }
});

app.options("/api/earn/prepare", (_req: Request, res: Response) => { setTradeCors(res); res.sendStatus(204); });
app.post("/api/earn/prepare", async (req: Request, res: Response) => {
  setTradeCors(res);
  const { address, amountUsd, direction, kind } = req.body ?? {};
  try {
    const prepare = kind === "index-yield" ? prepareIndexYield : prepareCarry;
    res.json(await prepare({ address, amountUsd: Number(amountUsd), direction }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isValidation = /invalid|must be|no USDG|no syrupUSDG|no payout|not enough|above the/.test(msg);
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
  const address = typeof req.query.address === "string" ? req.query.address : "";
  try {
    res.json(await vaultStatus(address));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/invalid|address/.test(msg) ? 400 : 502).json({ enabled: false, error: msg });
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
  if (guard) { res.status(guard.status).json({ ok: false, error: guard.error }); return; }
  const slot = await acquireSlot();
  if (!slot) { endTurn(address); res.status(503).json({ ok: false, error: "high demand right now — try again in a few seconds" }); return; }
  try {
    res.json(await runScout(address));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[earn/scout] failed:", msg);
    const status = msg === "gateway_unconfigured" ? 503 : 502;
    res.status(status).json({ ok: false, error: "your agent could not scout just now — try again shortly" });
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
  try {
    const result = await provisionResearchFleet(segments);
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
    res.status(400).json({ ok: false, error: `symbol must be a tradable pool (${TRADABLE_SYMBOLS.join(", ")})` });
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
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session; send an initialize request first" },
        id: null,
      });
      return;
    }
    // New session: fresh transport + server, registered once the handshake completes.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    await buildServer().connect(transport);
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
  const transport = req.header("mcp-session-id")
    ? transports.get(req.header("mcp-session-id")!)
    : undefined;
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

startLpGuard();
startLpAllocator();
startEquitySnapshotter();
if (process.env.MERIDIAN_RUN_BASIS_LOGGER === "1") startBasisLogger();
if (process.env.MERIDIAN_RUN_LIGHTER_LOGGER === "1") startLighterLogger();
if (process.env.MERIDIAN_RUN_YIELD_LOGGER === "1") startYieldLogger();
startBackups(); // Postgres mirror of the durable JSONL/JSON state + boot-time restore
void initLedger(); // row-level Postgres ledger: table + one-time history backfill, then live dual-writes
scheduleOpenDeploy(); // one-shot capital deployment at the next open, if a plan is configured

// Global error handler (registered last): log the real error server-side and
// return a generic message, so a route exception can never leak internals
// (RPC/viem details, file paths, stack) to a caller.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[http] unhandled route error:", err instanceof Error ? err.stack : err);
  if (res.headersSent) return;
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
});
