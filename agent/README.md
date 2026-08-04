# @meridian/mcp

Meridian's market-making and RWA domain, exposed as an **MCP server** that an
[OpenHermit](https://github.com/HCF-STUDIOS/openhermit) agent connects to, plus
the HTTP API the live desk and per-wallet agents run on.

Meridian is a layer on top of OpenHermit. OpenHermit is the operable agent
runtime (durable state, sandboxed execution, fleet management, scheduling).
Meridian does not run its own agent loop; it supplies the capabilities as tools,
and an OpenHermit agent orchestrates them. A "Meridian agent" is an OpenHermit
agent with this MCP server enabled.

**Scoped to Robinhood Chain.** The agent makes markets in tokenized equities on
Robinhood Chain's Uniswap v4 pools. The other `ChainId` values and the Wormhole
cross-chain path are real, still-compiled code, but dormant while focus stays on
one chain.

## Tools

Namespaced inside the agent as `mcp__meridian__<tool>`. Free discovery tools let
a new caller see there is something worth paying for; the signals are metered
over x402; execution settles a fee per fill.

| Tool | Kind | Cost | Purpose |
|------|------|------|---------|
| `meridian_list_chains` | read | free | Supported chains and bridging status |
| `meridian_list_assets` | read | free | Tokenized assets, optionally filtered by chain |
| `meridian_universe_status` | read | free | Coverage summary from the research fleet |
| `meridian_agent_thoughts` | read | free | Recent decisions and reasoning from the live loop |
| `meridian_index_yield` | read | free | Distribution yield on the $INDEX token |
| `meridian_market_data` | read | **$0.01** | Live price and momentum for a ticker, or all |
| `meridian_carry_quote` | read | **$0.02** | Where to park idle cash in yield-bearing RWAs, with terms and route |
| `meridian_market_universe` | read | **$0.02** | The on-chain map of tokenized assets: tradable, depth, what to avoid |
| `meridian_lp_score` | read | **$0.05** | Which pools actually pay to make markets in, net of getting picked off |
| `meridian_suggest_route` | read | **$0.05** | Strategy decision plus step-by-step reasoning (advisory) |
| `meridian_basis_feed` | read | **$0.10** | How far each stock's on-chain price has drifted from the real market |
| `meridian_index_execute` | write | fee / fill | Atomic swap between tokenized-equity tickers on Robinhood Chain |
| `meridian_index_yield_execute` | write | fee / fill | Enter the $INDEX yield position |
| `meridian_bridge_execute` | write | fee / fill | Cross-chain move (dormant) |
| `meridian_submit_research` | write | internal | Research agents upsert venue findings (name-deduped) |

Prices are env-configurable (`PRICE_*_USD`, see `.env.example`). Spend and size
caps in `src/risk.ts` are enforced server-side, so a prompt cannot exceed them.

## Market-making engine

The core of the agent is a liquidity-provision engine, not a directional
trader. The 24/7 autonomous meme-family desk (rotation, concentration, fee
banking, the never-stuck exit ladder, the public decision journal) is
documented in [DESK.md](DESK.md); the equity-family engine below shares the
wallet and the house lock. It:

- **Discovers pools dynamically** (`src/lpAllocator.ts`, `src/signals/lpScore.ts`):
  scans candidate tokenized-equity pools across fee tiers, measures real swap
  flow, and scores each on fee revenue net of toxicity (getting picked off).
- **Runs a phase machine** (`src/lpGuard.ts`): open, hold, rebalance, recover.
  It re-centers and rebalances only when the expected gain clears a
  cost-aware bar (multiple of the round-trip pool fees), with persistence and
  cooldown guards so it does not churn.
- **Executes on-chain** through Robinhood Chain's Uniswap v4 (a standard
  v4 `PositionManager` for liquidity, a forked `UniversalRouter` for swaps).
  Every mint, swap, collect, and liquidation is a real transaction.
- **Accounts honestly** (`src/lpProfit.ts`): realized net = fees collected minus
  the taker fees paid to build and unwind positions, plus uncollected accrued.

## Live monitor

`src/agentLoop.ts` re-evaluates the strategy on a timer
(`AGENT_THINK_INTERVAL_MS`, default 20s) even with no caller connected, and logs
every evaluation (`src/decisionLog.ts`) with its full reasoning trace, not just
the final action. The loop is read-only: it never executes or spends. Execution
stays a deliberate call by a real agent (or the frontend) with a real wallet.

Two ways to watch it think:
- `meridian_agent_thoughts` (MCP tool, free) for any OpenHermit agent.
- `GET /api/agent-thoughts` (plain JSON, CORS-open), what the frontend's live
  desk polls. A lightweight REST route rather than making the browser speak the
  full MCP protocol for a read-only display.

## x402 payment rail

Meridian does not custody trade capital; callers bring their own funded wallet.
What Meridian sells is its data and execution, metered over
[x402](https://www.x402.org). The rail is live (`src/payments/`):

- A priced `tools/call` with no `X-PAYMENT` header gets a 402 carrying x402
  payment requirements (`payTo` = the treasury, amount = the tool's price).
- Payment is verified **on-chain**: the facilitator confirms a real USDG
  transfer to the treasury and records it in a replay-protected ledger, so the
  same payment cannot be spent twice.
- The paying side settles priced calls hands-free from the agent's own wallet.
- Revenue is written to a durable ledger (`revenue.jsonl`), not held in memory.

Because MCP multiplexes every call through one JSON-RPC endpoint, gating happens
by inspecting `tools/call` before it reaches the MCP transport, not via
per-route HTTP 402s.

## Earn surfaces (user-facing HTTP)

Two live paths let a signed-in user earn without Meridian ever taking custody
(`src/earn/`):

- **Advise-then-approve positions.** `GET /api/earn/opportunities[?address=]`
  quotes both live positions with the wallet's own balances and projections:
  the syrupUSDG carry at the MEASURED pool-drift APY (yieldLogger), and the
  $INDEX distribution yield (implied APR, the ~10k-token eligibility
  threshold, pending pot). `POST /api/earn/prepare`
  `{address, amountUsd, direction: enter|exit, kind?: carry|index-yield}`
  returns the ordered raw transactions (missing approvals, then the swap)
  that the USER's wallet signs in the frontend. $INDEX entries from USDG are
  two rounds (`complete:false, continueWith:"enter"`) because the funding leg
  and the hook-pool entry live on different routers; the caller re-prepares
  after the conversion lands so the buy is sized against real balances. This
  process holds no key for these flows and can move nothing.
- **Scout-to-earn.** `POST /api/earn/scout` (SIWE session bearer, same chat
  guards as `/api/my-agent/message`) sends the wallet's own agent on a
  scouting run for a tokenized-RWA venue the universe doesn't track yet. A
  validated novel find is upserted into the universe credited `scout:<wallet>`
  and accrues a small USDG bounty (`SCOUT_*` env caps bound the worst case;
  attribution comes from the session, never from model output).
  `GET /api/earn/bounties[?address=]` is the public board;
  `POST /api/admin/settle-bounties` (operator bearer) pays balances above the
  minimum from the house wallet through the same circuit breaker as every
  other wallet op.

## RWA research fleet

`src/research/` is a standing swarm: one OpenHermit agent per RWA market segment
(`segments.ts`), each finding and tracking venues across the tokenized-RWA
market and writing them into a shared universe (`rwa-universe.json`, via
`meridian_submit_research`) that the agent reads through
`meridian_market_universe`. Web research runs on Exa.

Each segment agent runs two skills on two cadences, split by cost:

| Skill | Cost | Cadence | Job |
|-------|------|---------|-----|
| `skills/rwa-discover` | expensive (broad search) | weekly-ish | find venues not known yet |
| `skills/rwa-refresh` | cheap (targeted fetch) | daily / hourly | re-check known venues |

Every scheduled wake pays a fixed cost before any real work, so running
discovery-grade search on every wake would multiply cost for no benefit.
Provision the fleet:

```bash
npm run provision-fleet    # dry-run without GATEWAY_ADMIN_TOKEN set
```

With `GATEWAY_ADMIN_TOKEN` set it creates/patches the agents idempotently:
registers the MCP server and both skills, sets each segment brief, pins a cheap
model tier (`RWA_FLEET_MODEL_*`), and creates the cron schedules.

## Run

```bash
npm install
cp .env.example .env    # set MERIDIAN_MCP_TOKEN to require auth
npm run dev             # http://127.0.0.1:8787/mcp  (tsx watch)
# or: npm run build && npm start
```

`GET /health` returns readiness. `POST /mcp` is the Streamable-HTTP MCP endpoint.
See [DEPLOY.md](DEPLOY.md) for deployment.

## Register with an OpenHermit gateway

```bash
curl -X POST "$OPENHERMIT_GATEWAY_URL/api/admin/mcp-servers" \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "meridian",
    "name": "Meridian",
    "description": "RWA market-making tools",
    "url": "http://<meridian-host>:8787/mcp",
    "headers": { "Authorization": "Bearer <MERIDIAN_MCP_TOKEN>" }
  }'

# enable it for one agent (or "*" for the whole fleet)
curl -X POST "$OPENHERMIT_GATEWAY_URL/api/admin/mcp-servers/meridian/enable" \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "main" }'
```

## Config

| Env | Default | Meaning |
|-----|---------|---------|
| `MERIDIAN_MCP_HOST` | `127.0.0.1` | Listen host |
| `MERIDIAN_MCP_PORT` | `8787` | Listen port |
| `MERIDIAN_MCP_TOKEN` | _(empty)_ | If set, `/mcp` requires `Authorization: Bearer <token>` |
| `ROBINHOOD_RPC_URL` | _(empty)_ | Robinhood Chain RPC for on-chain reads and execution |
| `X402_FACILITATOR_URL` | _(empty)_ | x402 facilitator used to verify payments |
| `MERIDIAN_TREASURY_ADDRESS` | _(empty)_ | Wallet priced tools are paid into |
| `AGENT_MAX_TRADE_USD` | `1000` | Per-trade notional cap |
| `AGENT_MAX_DAILY_USD` | `5000` | Daily notional cap |
| `OPENHERMIT_GATEWAY_URL` | `http://127.0.0.1:4000` | Gateway the research fleet is provisioned on |
| `GATEWAY_ADMIN_TOKEN` | _(empty)_ | Admin token for provisioning; unset = dry run |
| `RWA_FLEET_MODEL_PROVIDER` / `RWA_FLEET_MODEL_ID` | `anthropic` / `claude-haiku-4-5` | Cheap model tier for research agents |
