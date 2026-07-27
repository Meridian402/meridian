import { TREASURY_WALLET } from "./merd/wallets.js";

export const config = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  wormholeRpcUrl: process.env.WORMHOLE_RPC_URL ?? "",
  // Robinhood Chain RPC — set this to move IndexTrader off its stub and
  // actually submit swaps to The Index's Uniswap v4 pools.
  robinhoodRpcUrl: process.env.ROBINHOOD_RPC_URL ?? "",

  // --- RPC latency architecture (see AGENTS.md / RPC notes) --------------------
  // READS use a fallback list: primary first (a dedicated provider like Alchemy),
  // then an optional explicit fallback, then the public endpoint as a last
  // resort, so a provider throttle or outage fails over instead of taking the
  // agent down. Deduped, so if the primary IS the public endpoint the list is
  // just the one.
  robinhoodReadRpcUrls: [
    ...new Set(
      [
        process.env.ROBINHOOD_RPC_URL,
        process.env.ROBINHOOD_RPC_FALLBACK_URL,
        "https://rpc.mainnet.chain.robinhood.com", // public, sequencer-backed — always the final fallback
      ].filter((u): u is string => Boolean(u)),
    ),
  ],
  // WRITES (transaction submission) go straight to the sequencer for the fewest
  // hops to inclusion — a third-party RPC relays a tx to the sequencer anyway,
  // adding latency. Defaults to the public Robinhood endpoint (sequencer-backed)
  // even when reads move to a dedicated provider. Override only for a private
  // sequencer endpoint. This is the transaction-speed edge, so keep it direct.
  robinhoodWriteRpcUrl: process.env.ROBINHOOD_WRITE_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  x402FacilitatorUrl: process.env.X402_FACILITATOR_URL ?? "",
  maxTradeUsd: Number(process.env.AGENT_MAX_TRADE_USD ?? 1000),
  maxDailyUsd: Number(process.env.AGENT_MAX_DAILY_USD ?? 5000),

  // Master kill-switch for autonomous execution — the background loop only
  // acts on its own enter_index/exit_index decisions when this is explicitly
  // "true", on top of ROBINHOOD_RPC_URL and AGENT_SIGNER_PRIVATE_KEY both
  // being set. Deliberately three separate opt-ins, not one: setting an RPC
  // URL for read access (e.g. live pool prices) should never silently start
  // spending real money. Defaults off.
  liveTradingEnabled: process.env.AGENT_LIVE_TRADING === "true",

  // Every cross-chain execution settles its routing fee via x402 before the
  // bridge moves anything — this is what makes cross-chain RWA trading
  // actually run over x402, not just the signal paywall below. Basis points
  // on trade notional. The transfer is signed by the executing house wallet
  // (X402Client always signs with getAgentSigner); the tool's `payer` field is
  // recorded for attribution and never chooses the signer.
  bridgeFeeBps: Number(process.env.BRIDGE_FEE_BPS ?? 8),

  // How often the background agent loop re-evaluates the strategy and logs a
  // new "thought" — this is what the live monitor's cadence is set by.
  agentThinkIntervalMs: Number(process.env.AGENT_THINK_INTERVAL_MS ?? 20_000),

  // Trailing lookback window (minutes) the momentum signal is computed over.
  // Was 15m — the 2026-07-13 churn incident (NVDA->AAPL->NVDA in 2h at the
  // open, -2.8%) showed 15-minute signals decay faster than the fees they
  // incur. 4h default matches the signal horizon to the cost horizon.
  momentumLookbackMinutes: Number(process.env.AGENT_MOMENTUM_LOOKBACK_MINUTES ?? 240),

  // Minimum leader-vs-laggard spread (percentage points over the lookback
  // window) before a rotation fires. This is the BASE bar — the strategy
  // raises it per-pair to rotationCostMultiple x that pair's real round-trip
  // pool fees (rotating into a 1%-fee pool must clear ~3x more than a 0.3%
  // one). Lower deliberately, not casually.
  minMomentumSpreadPct: Number(process.env.AGENT_MIN_SPREAD_PCT ?? 2),

  // Post-churn guards (2026-07-13). Persistence: the spread must hold above
  // the bar continuously this long before a trade fires — opening gaps and
  // single-swap spikes fail it, multi-hour trends pass, and it works the
  // same at 3am Sunday as 9:31 Monday (no market-hours dependence).
  rotationPersistenceMinutes: Number(process.env.AGENT_SPREAD_PERSISTENCE_MINUTES ?? 30),
  // Cooldown: at most one trade per this window, measured from the durable
  // executions ledger so restarts can't forget.
  rotationCooldownHours: Number(process.env.AGENT_ROTATION_COOLDOWN_HOURS ?? 24),
  // The cost-aware bar: required spread >= this multiple of the pair's real
  // round-trip fee percentage.
  rotationCostMultiple: Number(process.env.AGENT_ROTATION_COST_MULTIPLE ?? 3),

  // Receiving side of x402: the wallet Meridian's own signal/data tools get paid
  // into, and the per-call price of each gated tool. Placeholder prices —
  // tune once there's real usage data. A tool with no entry here is free.
  treasuryAddress: process.env.MERIDIAN_TREASURY_ADDRESS ?? "",
  toolPricesUsd: {
    meridian_market_data: Number(process.env.PRICE_MARKET_DATA_USD ?? 0.01),
    meridian_suggest_route: Number(process.env.PRICE_SUGGEST_ROUTE_USD ?? 0.05),
    meridian_market_universe: Number(process.env.PRICE_MARKET_UNIVERSE_USD ?? 0.02),
    // Revenue tools for platform agents: the live pool-vs-market basis feed
    // (the premium signal) and current yield-carry terms.
    meridian_basis_feed: Number(process.env.PRICE_BASIS_FEED_USD ?? 0.1),
    meridian_perp_feed: Number(process.env.PRICE_PERP_FEED_USD ?? 0.05),
    meridian_carry_quote: Number(process.env.PRICE_CARRY_QUOTE_USD ?? 0.02),
    meridian_lp_score: Number(process.env.PRICE_LP_SCORE_USD ?? 0.05),
  } as Record<string, number>,

  // MCP server (the layer an OpenHermit agent connects to).
  mcpHost: process.env.MERIDIAN_MCP_HOST ?? "127.0.0.1",
  mcpPort: Number(process.env.MERIDIAN_MCP_PORT ?? 8787),
  // When set, callers must present `Authorization: Bearer <token>`. This is the
  // value you put in the OpenHermit MCP server record's headers. It gates the
  // research-pipeline write tool; it deliberately does NOT gate fund-moving
  // tools (see executeToken) so that an agent holding this shared token still
  // cannot move the house wallet.
  mcpToken: process.env.MERIDIAN_MCP_TOKEN ?? "",
  // Separate, stricter secret for the fund-moving execute tools. It is NEVER
  // embedded in any gateway MCP-server registration, so no hosted agent (house
  // fleet or user chat agent) can execute trades via MCP — only an operator
  // presenting this token out-of-band. The house's own trading runs in-process,
  // not through /mcp, so it is unaffected. Unset => fund-moving tools answer
  // loopback only (fail closed).
  executeToken: process.env.MERIDIAN_EXECUTE_TOKEN ?? "",
  // The URL an OpenHermit gateway uses to reach this MCP server — usually a
  // publicly routable host, not mcpHost (which may be a bind address like 0.0.0.0).
  publicMcpUrl:
    process.env.MERIDIAN_PUBLIC_MCP_URL ??
    `http://${process.env.MERIDIAN_MCP_HOST ?? "127.0.0.1"}:${process.env.MERIDIAN_MCP_PORT ?? 8787}/mcp`,

  // The OpenHermit gateway the research fleet is provisioned on.
  gatewayUrl: process.env.OPENHERMIT_GATEWAY_URL ?? "http://127.0.0.1:4000",
  gatewayAdminToken: process.env.GATEWAY_ADMIN_TOKEN ?? "",

  // Scout-to-earn: what one validated novel finding accrues, and the caps that
  // bound the worst case (a sybil farm's daily take is maxDailyTotal, full stop).
  // Settlement below scoutMinPayoutUsd is skipped so dust never pays gas.
  scoutBountyUsd: Number(process.env.SCOUT_BOUNTY_USD ?? 0.1),
  scoutMaxPerWalletPerDay: Number(process.env.SCOUT_MAX_PER_WALLET_PER_DAY ?? 3),
  scoutMaxDailyTotalUsd: Number(process.env.SCOUT_MAX_DAILY_TOTAL_USD ?? 5),
  scoutMinPayoutUsd: Number(process.env.SCOUT_MIN_PAYOUT_USD ?? 0.5),
};

/**
 * Refuse to run pointed at anything but the canonical treasury.
 *
 * treasuryAddress is the `payTo` of the entire x402 rail: it is the address
 * PaymentGate hands to anyone about to pay us, and the address it then checks
 * Transfer logs against when verifying that payment. Point it somewhere stale
 * and nothing errors; callers are quoted the wrong destination, their payments
 * verify against it happily, and the money lands somewhere we are not watching.
 *
 * This started as a denylist of known-retired wallets, and the 2026-07-27
 * crash-loop proved both halves of that design: it caught a stale Railway
 * value at boot (good), and it only caught it because that address had been
 * added to the list (luck). Two rotations inside three days is the actual
 * cadence, so the guard is now an allowlist: the env var must equal
 * TREASURY_WALLET in merd/wallets.ts, the one place a rotation is recorded.
 * A rotation updates that one file, and every stale or typo'd env value fails
 * loudly at the next boot instead of silently collecting into the past.
 *
 * An empty value stays allowed: PaymentGate already treats that as
 * "unconfigured" and refuses to quote a price, which fails safe. The failure
 * this catches is a value that is set, plausible, and wrong.
 */
const RETIRED_TREASURY_ADDRESSES = [
  "0x76a4ff023faa6ea3e378d9e6d74eb6b2676fb38c", // rotated out 2026-07-23
  "0x475c1fe4d1e7a703eaca6141978b04010e410bf4", // superseded 2026-07-26, custody moved to a key the operator holds
];

export function assertTreasuryIsLive(address: string = config.treasuryAddress): void {
  if (!address) return; // unconfigured fails safe elsewhere
  if (address.toLowerCase() === TREASURY_WALLET.toLowerCase()) return;
  const known = RETIRED_TREASURY_ADDRESSES.includes(address.toLowerCase());
  throw new Error(
    `MERIDIAN_TREASURY_ADDRESS is ${address}, ${known ? "a retired wallet" : "not the canonical treasury"}. ` +
      `The live treasury is ${TREASURY_WALLET} (merd/wallets.ts TREASURY_WALLET). Every x402 payment ` +
      "would otherwise be quoted and verified against an address nobody is watching.",
  );
}
