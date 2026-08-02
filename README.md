<p align="center">
  <img src="assets/banner.png" alt="Meridian" width="100%" />
</p>

**Autonomous AI market-making for tokenized equities on Robinhood Chain.**

Meridian is a platform for the agentic economy. An autonomous agent named Merd
makes markets in tokenized stocks (AAPL, NVDA, TSLA, GOOGL, META and more) on
Robinhood Chain, entirely on-chain and fully transparent. Sign in with a wallet
and you get your own Merd to talk to and put to work: it quantifies real,
self-custodied ways to earn and you sign each one yourself. Agents pay per call,
from their own wallets, for the same market data and execution tools Merd runs
on, metered over [x402](https://www.x402.org).

**Live:** [meridian402.xyz](https://meridian402.xyz) · Watch the agent reason in
real time on the live desk. Every position and swap is on-chain and public.

## What it does

- **Makes markets autonomously.** Merd provides concentrated liquidity in
  tokenized-equity pools on Robinhood Chain's Uniswap v4, discovers which pools
  are worth being in, re-centers and rebalances as price moves, and enforces its
  own risk caps in code. Every position and every swap is on-chain and public.
- **Gives every user their own agent.** Connect a wallet (sign a message, no
  account, no keys) and Meridian provisions a personal Merd instance you can
  chat with immediately. It reasons over the live market and tells you what it
  would do. It never touches your funds.
- **Lets you earn from day one, self-custodied.** Your agent quantifies real,
  on-chain earning paths and hands you the transaction to sign yourself: park
  idle USDG at a measured rate, hold a position that pays out in tokenized
  stocks from real trading fees, or send your agent scouting the RWA market for
  USDG bounties on genuinely new venues it surfaces. You sign every transaction;
  Meridian builds the calldata but holds no key and can move nothing.
- **Sells its edge to other agents.** The signals and execution paths Merd
  trades on are exposed as tools any agent can call and pay for per use over
  x402: market data, LP scoring, carry quotes, the RWA universe map, and atomic
  execution. No subscriptions, no API keys.
- **Shows its work.** A live desk streams Merd's reasoning as it happens, and
  every position and swap is on-chain, so the book can be checked against the
  explorer instead of taken on trust.

## Architecture

Three things flow through Meridian: **users**, who sign in with a wallet to talk
to their own agent, watch the live desk, or take a self-custodied earn path;
**other agents**, who pay per call over x402 for the same tools and signals Merd
runs on; and **the agents themselves**, which reason, trade, and talk to each
other in a swarm. The backend coordinates but never takes custody. Platform
revenue lands in a wallet the agent itself holds, kept separate from the
operator-held key that signs engine operations, and everything settles on
Robinhood Chain where it can be checked by transaction hash.

```mermaid
flowchart TB
    U([Human user])
    EA([External AI agent])

    subgraph FE["Surfaces · Vercel"]
        AUTH[Wallet sign-in · SIWE]
        CHAT[Your agent · chat / CLI]
        DESK[Live desk]
        EARN[Earn surface]
    end

    subgraph BE["The desk · Railway"]
        API[HTTP API]
        MCP["MCP server<br/>x402-metered tools"]
        CRED[Credits ledger]
        subgraph ENGINE["Market-making engine"]
            SCORE[Discover + score pools]
            GUARD[Rebalance phase machine]
            EXEC[On-chain execution]
        end
        X402["x402 rail + revenue ledger"]
        RISK[Risk + spend caps]
        ORCH[Research orchestration]
    end

    subgraph OH["Agent runtime · OpenHermit"]
        MERID[Per-wallet Merd agents]
        SWARM["Agent-to-agent swarm"]
        DB[(Postgres)]
    end

    subgraph CHAIN["Robinhood Chain · Uniswap v4"]
        TREAS["Agent treasury<br/>agent-custodied"]
        SIGNER["Engine signer<br/>operator key"]
        POOLS[Tokenized-equity pools]
        TOKEN["MERD token + contracts"]
    end

    OR[[OpenRouter LLMs]]
    WEB[[Web research]]

    U --> AUTH --> CHAT --> API
    U --> DESK -->|poll reasoning| API
    U --> EARN -->|you sign every tx| POOLS
    EA -->|pay per call · x402| MCP

    API --> MERID
    API --> CRED
    MERID -->|call tools| MCP
    MERID <-->|exchange| SWARM
    MERID --> OR
    MERID --- DB

    MCP --> X402
    X402 -->|revenue · USDG| TREAS

    API --> SCORE
    SCORE --> GUARD --> EXEC
    EXEC --> RISK --> SIGNER --> POOLS

    ORCH --> SWARM
    SWARM --> OR
    SWARM --> WEB
    SWARM -->|new venues| MCP
```

Built as a layer on [OpenHermit](https://github.com/HCF-STUDIOS/openhermit):
OpenHermit is the agent runtime (durable state, sandboxed execution, fleet
management, scheduling). Meridian supplies the domain and does not run its own
agent loop. A "Meridian agent" is an OpenHermit agent with the Meridian tools
enabled.

This repository is the Meridian backend and its contracts.

```
agent/      MCP tool server, the market-making engine, on-chain execution
            (Uniswap v4 on Robinhood Chain), the x402 payment rail, per-wallet
            agent provisioning, and the RWA research swarm.
contracts/  The MERD token and its periphery (treasury hook, position lock,
            buyback, and the USDG revenue-share staking design). Drafts,
            unaudited; see contracts/STAKING.md for the honest posture.
```

The live desk and interface (Vite + React) is a separate app, deployed at
[meridian402.xyz](https://meridian402.xyz).

Key pieces in `agent/src`:

- `venues/` and `lp*.ts` — pool discovery, LP scoring, and the market-making
  engine (phase machine, cost-aware rebalancing, realized-net accounting).
- `deploy/myAgent.ts` — provisions and drives each user's personal Merd.
- `earn/` — the advise-then-approve earn surface: quotes and user-signed
  calldata for the carry and payout positions, plus scout-to-earn (agents hunt
  new RWA venues for capped USDG bounties). Builds transactions; holds no key.
- `payments/` — the x402 rail: an on-chain USDG facilitator with a replay
  ledger, and the paying side that settles tool calls hands-free.
- `research/` — a fleet that maps the on-chain RWA universe and feeds the
  agent's grounding.
- `risk.ts` — spend and size caps enforced server-side, so a prompt cannot
  exceed them.

## Status

Honest about where this is.

- **Live and real.** On-chain swaps and LP positions on Robinhood Chain's
  Uniswap v4, the x402 revenue rail, per-wallet agents, the three self-custodied
  earn paths (carry, the stock-payout position, scout-to-earn bounties), and the
  research swarm are all running against mainnet. Positions are real capital
  on-chain, verifiable by transaction hash, not a backtest.
- **Small.** The house book runs at low size and is roughly break-even at
  current scale. Market-making margins are thin until volume and depth grow. We
  say this plainly rather than dress it up: the edge is meant to be real and
  checkable, not reliably profitable yet.
- **MERD is live.** The token trades on Robinhood Chain and its address is
  published on the site. Platform revenue collects to a wallet the agent itself
  custodies, separate from the key that signs engine operations. The staking and
  fee-routing contracts around the token are drafts, unaudited and not deployed
  (see [`contracts/STAKING.md`](contracts/STAKING.md)). None of this holds your
  funds; self-custody is unchanged.
- **Coming next.** Today your agent quantifies each earning path and you sign
  it yourself. Letting the agent trade *your* funds on its own requires
  delegated, scoped signing (session keys); until that ships, it advises and
  approves, and never has custody of your wallet.

## Quickstart

```bash
cd agent
npm install
cp .env.example .env    # fill in the values you need
npm run dev             # MCP server on http://127.0.0.1:8787
```

See [agent/README.md](agent/README.md) for the tool catalog and
[agent/DEPLOY.md](agent/DEPLOY.md) for deployment.

## Stack

Robinhood Chain (chain id 4663), Uniswap v4, viem, x402 / MPP, the OpenHermit
SDK, TypeScript, React, and Vite.

---

Not financial advice. Tokenized assets are volatile and you can lose money.
