import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChainId } from "../types.js";
import { SEGMENTS } from "../research/segments.js";
import { market, strategy, bridge, x402, risk, universe, decisionLog, indexYieldData } from "../state.js";
import { routingFeeUsd } from "../fees.js";
import { executeIndexTrade } from "../actions/executeIndexTrade.js";
import { executeIndexYieldTrade } from "../actions/executeIndexYieldTrade.js";
import { basisSnapshot } from "../signals/basis.js";
import { carryQuote } from "../signals/carry.js";
import { perpSnapshot } from "../signals/perpFeed.js";
import { lpScores } from "../signals/lpScore.js";
import { buildStandardLaunch, simulateLaunch, flapDeployment } from "../launch/flapPortal.js";
import { parseEther, formatEther } from "viem";

const CHAIN_IDS = ["solana", "ethereum", "base", "polygon", "robinhood"] as const;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Build a Meridian MCP server: the RWA-DEX domain (market data, cross-chain
 * routing, x402 settlement) exposed as tools an OpenHermit agent connects to.
 * Tools surface inside the agent namespaced as `mcp__meridian__<tool>`.
 *
 * Stateless — one instance per request is fine; the shared singletons (market
 * data, risk limiter, decision log, ...) live in ../state.ts and are
 * process-local by design, shared with the background agent loop.
 */

const VenueSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  segment: z.string().optional(),
  chains: z.array(z.string()).optional(),
  tokenizes: z.string().optional(),
  tvlUsd: z.string().optional(),
  tvlAsOf: z.string().optional(),
  yieldPct: z.string().optional(),
  assetTickers: z.array(z.string()).optional(),
  custodyModel: z.string().optional(),
  accessModel: z.string().optional(),
  jurisdiction: z.string().optional(),
  integrationNotes: z.string().optional(),
  dataSourceType: z.string().optional(),
  sources: z.array(z.string()).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  // signal data points
  tvlTrend: z.enum(["rising", "falling", "stable"]).optional(),
  prevTvlUsd: z.string().optional(),
  yieldTrend: z.enum(["rising", "falling", "stable"]).optional(),
  prevYieldPct: z.string().optional(),
  liquidityUsd: z.string().optional(),
  volumeUsd24h: z.string().optional(),
  riskFlags: z.array(z.string()).optional(),
  redemptionTerms: z.string().optional(),
  feeStructure: z.string().optional(),
  listingDate: z.string().optional(),
  // deliberation verdict
  signalScore: z.number().optional(),
  signalNote: z.string().optional(),
  signalAsOf: z.string().optional(),
});

export function buildServer(): McpServer {
  const server = new McpServer({ name: "meridian", version: "0.1.0" });

  server.registerTool(
    "meridian_list_chains",
    {
      title: "List chains",
      description:
        "List the chains Meridian can source RWA liquidity on, with their current bridging status.",
      inputSchema: {},
    },
    async () => json({ chains: market.listChains() }),
  );

  server.registerTool(
    "meridian_list_assets",
    {
      title: "List RWA assets",
      description:
        "List tradable real-world-asset tokens, optionally filtered to a single chain.",
      inputSchema: { chain: z.enum(CHAIN_IDS).optional() },
    },
    async ({ chain }) => json({ assets: market.listAssets(chain as ChainId | undefined), source: market.dataSource() }),
  );

  server.registerTool(
    "meridian_market_data",
    {
      title: "Get market data",
      description:
        "Get current price and APR for one RWA symbol (e.g. T-BILL-3M), or all assets if no symbol is given.",
      inputSchema: { symbol: z.string().optional() },
    },
    async ({ symbol }) => {
      const source = market.dataSource();
      if (!symbol) return json({ assets: market.listAssets(), source });
      const asset = market.getAsset(symbol);
      if (!asset) return json({ error: `unknown symbol: ${symbol}` });
      return json({ asset, source });
    },
  );

  server.registerTool(
    "meridian_suggest_route",
    {
      title: "Suggest a trade route",
      description:
        "Run Meridian's rotation strategy and return its decision (hold, or a trade posture), with the step-by-step reasoning that led to it. Advisory only — does not execute. Returned to the caller only; it does NOT write to the public agent-thoughts feed, which narrates the house agent's live market-making.",
      inputSchema: {},
    },
    async () => {
      const decision = await strategy.evaluate(market.listAssets());
      // Deliberately not recorded to decisionLog: that feed is the house agent's
      // market-making narration, and a route suggestion is a different thing.
      return json({ strategy: strategy.name, ...decision });
    },
  );

  server.registerTool(
    "meridian_index_yield",
    {
      title: "Get $INDEX distribution-yield snapshot",
      description:
        "Real-time snapshot of theindex.finance's $INDEX distribution mechanic: price, eligibility threshold, pending pot, holder count, next distribution countdown, and the trailing distributed-value trend Meridian's strategy reasons over. Read from the product's own public /live and /indexer endpoints — free, no key required.",
      inputSchema: {},
    },
    async () => json(await indexYieldData.snapshot()),
  );

  server.registerTool(
    "meridian_basis_feed",
    {
      title: "Pool-vs-market basis feed",
      description:
        "Live gap between 24/7 on-chain pool prices and the latest real-equity-market print, for every depth-verified ticker. The pools keep trading when NYSE is closed, so the basis (and its convergence at the open) is a tradable signal. Priced per call via x402.",
      inputSchema: {},
    },
    async () => json(await basisSnapshot()),
  );

  server.registerTool(
    "meridian_perp_feed",
    {
      title: "Perp venue feed (Lighter on Robinhood Chain)",
      description:
        "Live snapshot of the zero-fee zk-orderbook perp venue on Robinhood Chain: all markets with price, 24h volume, trade count, Lighter-native funding (flagged when it moves off baseline), Binance reference funding, and spot-vs-perp basis against Meridian's depth-verified v4 pools. The venue carries ~1000x the AMM's flow; this feed is the only machine-readable view of it. Priced per call via x402.",
      inputSchema: {},
    },
    async () => json(await perpSnapshot()),
  );

  server.registerTool(
    "meridian_carry_quote",
    {
      title: "Yield-carry quote",
      description:
        "Current terms for parking idle dollars in yield-bearing RWAs on Robinhood Chain (Maple syrupUSDG): pool price vs par, real depth at 2% impact, fee tier, and route. Deep enough that agent-scale size is noise. Priced per call via x402.",
      inputSchema: {},
    },
    async () => json(await carryQuote()),
  );

  server.registerTool(
    "meridian_lp_score",
    {
      title: "LP opportunity score",
      description:
        "Which pools are safe to make markets in: real swap volume, fee flow, and 30-minute markout (post-trade drift against LPs) measured from on-chain events over a trailing window. fees minus markout is what LPs actually earned. First call after a cold cache scans days of logs and can take ~1 minute; results cache for an hour. Priced per call via x402.",
      inputSchema: { windowDays: z.number().min(0.5).max(7).optional() },
    },
    async ({ windowDays }) => json(await lpScores(windowDays ?? 2.5)),
  );

  server.registerTool(
    "meridian_agent_thoughts",
    {
      title: "Recent agent decisions and reasoning",
      description:
        "The trading strategy's recent evaluations — action taken (or held), the reasoning trace behind it, and when. Populated by a background loop that re-evaluates on a timer (AGENT_THINK_INTERVAL_MS) even with no caller, plus every meridian_suggest_route call. Read-only, free — this is the same feed the frontend's live monitor polls.",
      inputSchema: { limit: z.number().int().positive().max(50).optional() },
    },
    async ({ limit }) => json({ decisions: decisionLog.recent(limit ?? 20) }),
  );

  server.registerTool(
    "meridian_bridge_quote",
    {
      title: "Quote a cross-chain bridge",
      description:
        "Quote moving an RWA position to another chain via the Wormhole routing layer. Read-only estimate; does not move funds. Includes the x402 routing fee the executing wallet will settle at execute time.",
      inputSchema: {
        symbol: z.string().describe("RWA symbol to bridge, e.g. PCF-A"),
        amountUsd: z.number().positive(),
        destChain: z.enum(CHAIN_IDS),
      },
    },
    async ({ symbol, amountUsd, destChain }) => {
      const asset = market.getAsset(symbol);
      if (!asset) return json({ error: `unknown symbol: ${symbol}` });
      if (asset.chain === destChain)
        return json({ error: `${symbol} is already on ${destChain}; no bridge needed` });
      const sized = risk.size(amountUsd);
      return json({
        route: `${asset.chain} -> wormhole -> ${destChain}`,
        symbol,
        amountUsd: sized,
        clampedFromRequested: sized !== amountUsd ? amountUsd : undefined,
        estBridgeMinutes: 15,
        estFeeUsd: routingFeeUsd(sized),
        feeSettledVia: "x402",
      });
    },
  );

  server.registerTool(
    "meridian_bridge_execute",
    {
      title: "Execute a cross-chain bridge",
      description:
        "Execute a cross-chain move of an RWA position via Wormhole. Mutating: subject to Meridian's per-trade and daily spend caps. Settles the routing fee via x402 from the given payer wallet before moving anything — the trade itself is never x402-gated, only the routing fee is. Gate this behind an OpenHermit approval policy in production.",
      inputSchema: {
        symbol: z.string(),
        amountUsd: z.number().positive(),
        destChain: z.enum(CHAIN_IDS),
        payer: z.string().describe("Wallet the trade executes from and the x402 routing fee is paid from"),
      },
    },
    async ({ symbol, amountUsd, destChain, payer }) => {
      const asset = market.getAsset(symbol);
      if (!asset) return json({ error: `unknown symbol: ${symbol}` });
      const sized = risk.size(amountUsd);
      const gate = risk.check(sized);
      if (!gate.ok) return json({ success: false, error: gate.reason });

      const feeUsd = routingFeeUsd(sized);
      const feeReceipt = await x402.pay({
        amountUsd: feeUsd,
        payer,
        memo: `bridge routing fee: ${symbol} -> ${destChain}`,
      });
      if (!feeReceipt.success) {
        return json({ success: false, error: feeReceipt.error ?? "x402 fee settlement failed" });
      }

      const result = await bridge.moveValue({ asset, amountUsd: sized, destChain: destChain as ChainId });
      if (result.success) risk.record(sized);
      return json({ ...result, amountUsd: sized, feeUsd, feeReceipt, spentTodayUsd: risk.spentTodayUsd });
    },
  );

  server.registerTool(
    "meridian_index_execute",
    {
      title: "Execute a trade on The Index",
      description:
        "Swap between tokenized equities on The Index (theindex.finance — Uniswap v4 pools on Robinhood Chain). Same-chain execution, distinct from meridian_bridge_execute's cross-chain moves: an Index rotation never leaves Robinhood Chain. Settles a routing fee via x402 from the given payer before swapping; subject to per-trade and daily spend caps.",
      inputSchema: {
        fromSymbol: z.string().describe("Index ticker to sell, e.g. TSLA"),
        toSymbol: z.string().describe("Index ticker to buy, e.g. NVDA"),
        amountUsd: z.number().positive(),
        payer: z.string().describe("Wallet the trade executes from and the x402 routing fee is paid from"),
      },
    },
    async ({ fromSymbol, toSymbol, amountUsd, payer }) =>
      json(await executeIndexTrade({ fromSymbol, toSymbol, amountUsd, payer })),
  );

  server.registerTool(
    "meridian_index_yield_execute",
    {
      title: "Enter or exit the $INDEX yield position",
      description:
        "Execute the ETH<->$INDEX leg IndexYieldStrategy's enter_index/exit_index decisions describe — distinct from meridian_index_execute, which swaps between stock tickers. Settles a routing fee via x402 before swapping; subject to per-trade and daily spend caps. On success, confirms the strategy's tracked position (evaluate() itself only proposes, never mutates state).",
      inputSchema: {
        side: z.enum(["enter", "exit"]).describe("enter: ETH -> $INDEX. exit: $INDEX -> ETH."),
        amountUsd: z.number().positive(),
        payer: z.string().describe("Wallet the trade executes from and the x402 routing fee is paid from"),
      },
    },
    async ({ side, amountUsd, payer }) => {
      const outcome = await executeIndexYieldTrade({ side, amountUsd, payer });
      decisionLog.record("index-yield-manual", {
        timestamp: Date.now(),
        action: side === "enter" ? "enter_index" : "exit_index",
        reason: `manual $INDEX ${side}`,
        thoughts: [`Executed directly (not the background loop): ${side === "enter" ? "bought" : "sold"} $${amountUsd} of $INDEX.`],
        execution: {
          success: outcome.success,
          txHash: "txHash" in outcome ? outcome.txHash : undefined,
          amountReceived: "amountReceived" in outcome ? outcome.amountReceived : undefined,
          error: outcome.error,
        },
      });
      return json(outcome);
    },
  );

  server.registerTool(
    "meridian_settle_x402",
    {
      title: "Settle via x402",
      description:
        "Settle a micropayment (e.g. a routing/venue fee) through the x402 facilitator flow.",
      inputSchema: {
        amountUsd: z.number().positive(),
        payer: z.string().describe("Payer wallet address"),
        memo: z.string().optional(),
      },
    },
    async ({ amountUsd, payer, memo }) => {
      const receipt = await x402.pay({ amountUsd, payer, memo });
      return json({ receipt });
    },
  );

  server.registerTool(
    "meridian_market_universe",
    {
      title: "Query the RWA market universe",
      description:
        "Search the venues discovered by Meridian's RWA research fleet — every tokenized-RWA venue/issuer/protocol collected so far, across every segment (treasuries, private credit, real estate, equities, commodities, MMFs, bonds, trade finance, carbon, funds, aggregators, cross-chain infra). Filter by segment, chain, or free-text query; omit all three to get everything (capped at 200).",
      inputSchema: {
        segment: z.string().optional().describe("substring match against a venue's segment, e.g. 'treasur'"),
        chain: z.string().optional().describe("substring match against a venue's chains, e.g. 'ethereum'"),
        query: z.string().optional().describe("free-text match against name/segment/tokenizes/tickers/chains"),
      },
    },
    async ({ segment, chain, query }) => {
      let results = universe.all();
      if (segment) results = results.filter((v) => (v.segment ?? "").toLowerCase().includes(segment.toLowerCase()));
      if (chain) results = results.filter((v) => (v.chains ?? []).some((c) => c.toLowerCase().includes(chain.toLowerCase())));
      if (query) results = universe.search(query).filter((v) => results.includes(v));
      const CAP = 200;
      return json({
        count: results.length,
        venues: results.slice(0, CAP),
        truncated: results.length > CAP ? results.length - CAP : undefined,
      });
    },
  );

  server.registerTool(
    "meridian_universe_status",
    {
      title: "RWA research fleet coverage status",
      description:
        "Summary of the research fleet's coverage: total venues discovered, venues per segment, and which of the 12 taxonomy segments have data yet vs. are still queued.",
      inputSchema: {},
    },
    async () => {
      const s = universe.status();
      const taxonomy = SEGMENTS.map((seg) => ({
        key: seg.key,
        title: seg.title,
        venuesFound: s.segmentCounts[seg.title] ?? 0,
      }));
      return json({ totalVenues: s.totalVenues, updatedAt: s.updatedAt, segments: taxonomy });
    },
  );

  server.registerTool(
    "meridian_submit_research",
    {
      title: "Submit RWA research findings",
      description:
        "Called by a segment research agent to upsert venues it has discovered/enriched into Meridian's shared RWA universe. Matches on venue name (case/punctuation-insensitive) — resubmitting an existing venue updates its fields rather than duplicating it.",
      inputSchema: {
        submittedBy: z.string().optional().describe("the research agent's id, e.g. rwa-research-treasuries"),
        venues: z.array(VenueSchema).min(1),
      },
    },
    async ({ submittedBy, venues }) => {
      const result = universe.upsertMany(venues, submittedBy);
      return json({ ok: true, ...result });
    },
  );

  /**
   * Token launching, agent-native.
   *
   * Deliberately NOT in EXECUTE_TOOLS, and that is a design statement rather
   * than an oversight: this tool returns unsigned calldata and holds no signer,
   * so it is structurally incapable of moving anyone's funds — ours or the
   * caller's. That is precisely what makes it safe to expose on the
   * credential-free "meridian-public" registration every user's chat agent
   * connects through. A gate would add no safety and would lock out the exact
   * audience the feature is for.
   *
   * The user signs. newTokenV5 is payable and msg.value is the creator's own
   * initial buy, so the transaction can only ever originate from their wallet,
   * and Flap's TokenCreated event records THEM as creator — not us.
   */
  server.registerTool(
    "meridian_launch_token",
    {
      title: "Prepare a token launch on Robinhood Chain",
      description:
        "Prepare a standard (non-tax) ERC-20 launch on Robinhood Chain via Flap's Portal, and simulate it against the live chain before returning. Returns an UNSIGNED transaction for the user to sign in their own wallet — this tool never signs, never holds funds, and never spends. The token address is deterministic (CREATE2) and is reported before signing. Tokens trade on a bonding curve and graduate to a Uniswap V2 pair at ~80% of supply sold; before graduation, transfers to or from any pool are blocked by the protocol.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Token name, e.g. 'Meridian Test'"),
        symbol: z.string().min(1).max(16).describe("Ticker, e.g. MTEST"),
        creator: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe("The wallet that will sign, fund and own the launch. Must be the user's own wallet."),
        initialBuyEth: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe("Creator's own first buy in ETH, paid as msg.value. Optional; 0 means launch without buying."),
        meta: z
          .string()
          .optional()
          .describe("IPFS CID from Flap's upload API. Without it the token has no image or description in any terminal."),
      },
    },
    async ({ name, symbol, creator, initialBuyEth, meta }) => {
      const dep = flapDeployment();
      let built;
      try {
        built = buildStandardLaunch(
          { name, symbol, meta, creator: creator as `0x${string}`, quoteAmt: parseEther(String(initialBuyEth ?? 0)) },
          dep,
        );
      } catch (e) {
        return json({ ok: false, error: (e as Error).message });
      }

      // Simulating is not optional. The Portal implementation's source is
      // unverified, so this is the only proof the encoding is right before a
      // user is asked to sign and pay gas.
      const sim = await simulateLaunch(built, creator as `0x${string}`, dep);
      if (!sim.ok) {
        return json({
          ok: false,
          network: dep.chainId === 4663 ? "robinhood-mainnet" : "robinhood-testnet",
          error: sim.error,
          underfunded: sim.underfunded ?? false,
          ...(sim.underfunded ? { needsWei: String(sim.requiredWei), needsEth: formatEther(sim.requiredWei ?? 0n) } : {}),
        });
      }

      return json({
        ok: true,
        network: dep.chainId === 4663 ? "robinhood-mainnet" : "robinhood-testnet",
        chainId: built.chainId,
        tokenAddress: sim.token,
        addressMatchedPrediction: sim.matchesPrediction,
        explorer: `${dep.explorer}/address/${sim.token}`,
        // What the user signs. Nothing here is broadcast by us.
        transaction: { to: built.to, data: built.data, value: String(built.value) },
        simulated: true,
        note:
          "Simulated successfully against the live chain. Sign this from the creator wallet to launch. " +
          "The token trades on a bonding curve and graduates to a Uniswap V2 pair at ~80% of supply sold.",
      });
    },
  );

  return server;
}
