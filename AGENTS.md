# Working agreement: two agents, one repo

Two agents operate on this project and both can push to `main`. This file is the
contract that keeps them from overwriting each other. It happened once (an env
edit clobbered a documentation change and had to be untangled by hand); these
rules exist so it doesn't again.

## Who owns what

| Domain | Owner | Source of truth |
| --- | --- | --- |
| Money, live config, project direction, fund movements | **OpenHermit Merd** (project manager / fund manager) | **Railway** environment |
| Backend code, bug fixes, tests, documentation | **Claude Code** (engineering, in the editor) | **git `main`** |

The trading engine in `agent/` is an execution layer. It signs and market-makes
with capital it has been handed. The **treasury is separate**: revenue and funds
live in the fund manager's wallet, which funds the trading wallet when it wants
the engine to trade. Neither wallet needs the other's key.

## Rules

1. **`git pull --rebase` before every push.** Both sides, every time. This alone
   prevents nearly all collisions.

2. **Real config values live in Railway, never in the repo.** Addresses, private
   keys, tokens, spend caps, and the like are set in Railway (the fund manager's
   domain) — that is also the only place they take effect. `.env.example` is
   **documentation only**: variable names, comments, and placeholder/blank
   values. Never commit a real address or key to it. If you need to change what
   an address *is*, change it in Railway, not here.

3. **Stay in your lane.** The fund manager sets config in Railway and directs the
   project; it does not edit application code or `.env.example` values. Engineering
   edits code and docs; it does not decide fund movements or set live money config.
   When something needs both (e.g. a new env var), engineering adds the
   documented placeholder to `.env.example`, and the fund manager sets the real
   value in Railway.

4. **Small, frequent commits**, pushed promptly, so the window for divergence
   stays small.

## Deploy notes

- Railway does **not** auto-deploy on git push. Code changes go live via
  `railway up -s meridian402-api --detach` from `agent/`. Config-only changes
  take effect on the next redeploy.
- The public track record (`/api/performance`) and the site are outward-facing.
  Treat changes to them as publishing: confirm before they go out.

## Operator levers (fund manager)

The engine ships **idle**. There are two separate businesses here with different
switches, and conflating them wastes time:

### Market-making (LP) — what the agent actually does

`AGENT_LIVE_TRADING` is **not** involved. `startLpGuard()` runs unconditionally.

1. **Fund the signer wallet** with ETH (gas) *and* USDG (capital). Its address is
   the `AGENT_SIGNER_PRIVATE_KEY` wallet. Without ETH it cannot pay gas even when
   it holds USDG, so both are required.
2. **Open a position** — nothing auto-deploys idle cash:
   `POST /api/lp-open {"symbol":"NVDA"}` with the `MERIDIAN_MCP_TOKEN` bearer.
   Tradable: NVDA / TSLA / META (0.3%), AAPL / GOOGL (1%).

The guard then manages it: tight ±1% in market hours, wide ±4% over weekends,
auto-collect above `MERIDIAN_COLLECT_THRESHOLD_USD`.

**To stop:** close the position (`POST /api/lp-close`). Clearing
`AGENT_LIVE_TRADING` does *not* stop the LP guard.

### Directional / momentum trading — retired, off

3. **Set `AGENT_LIVE_TRADING=true`** and redeploy to re-enable the rotation loop.
   It defaults to `false`; while false, the loop logs decisions and signs
   nothing. This is the strategy behind the 2026-07-13 churn incident; leaving it
   off is the deliberate posture.

**To stop:** set `AGENT_LIVE_TRADING=false` and redeploy.

### Exactly one host may hold the signer key

Setting `AGENT_SIGNER_PRIVATE_KEY` makes that process an LP guard over the house
wallet. The house-wallet lock is in-process only and cannot coordinate across
machines, so two key-holding processes each manage the same position
independently — a genuine double-spend path. It stays invisible while the wallet
is empty. Any additional instance that only needs to read sets
`MERIDIAN_WALLET_ADDRESS` instead. **As deployed today the key is in Railway, so
the cloud is the guard** — which also means `/api/sync-state` must not be used to
push local ledgers over it (whole-file replace).

**Guardrails** (Railway, lower to tighten — do not raise casually): per-trade and
daily caps `AGENT_MAX_TRADE_USD` / `AGENT_MAX_DAILY_USD`, and the house-wallet
circuit breakers `MERIDIAN_MAX_DAILY_NOTIONAL_USD` /
`MERIDIAN_MAX_DAILY_WALLET_OPS`.

`MERIDIAN_MAX_RECOVERY_USD` is the ceiling on unattended redeployment: if a
retile fails or a weekend drift-pull leaves the wallet flat, the guard re-enters
the same pool on its own, but never above this. It is a **ceiling, not a target**,
and it must exceed the book — set below the deployable balance it silently never
fires, so a flat wallet stays flat and out of the market. `0` disables recovery
entirely. Every knob here reads `Number(...)`, so `0` is a real value, not "unset".

**One caveat, so "trading off" is not misread as "nothing moves":** the LP guard
is position protection, not signal trading, and it runs *even with*
`AGENT_LIVE_TRADING=false` — it can re-center, widen, or withdraw an existing LP
position on its own. If you need the engine to touch nothing at all, it must also
hold no open LP positions.
