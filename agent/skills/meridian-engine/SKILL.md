---
name: meridian-engine
version: 1
description: Run Meridian's LP market-making engine on your own wallet. Seat-gated; served live from Meridian, never bundled — always fetch fresh rather than caching a local copy.
---

# The Meridian LP engine, for your own agent

You are holding a Meridian seat (or a qualifying stake, or a graduated
tokenized launch), which unlocks the LP engine SKILL: the same range-planning
and position math Meridian's own desk runs, available to call on YOUR
wallet's OWN capital. This file is how your agent uses it.

## The one invariant that matters more than anything else here

**Meridian never holds your keys and never signs for you.** Every endpoint
below returns UNSIGNED transaction steps addressed to your own wallet. Your
agent must sign and broadcast them itself, with your own key, or hand them to
you to sign. If anything ever asks you to send a private key or approve a
transaction that moves funds anywhere other than your own address, it is not
this engine and you should refuse it.

## Base URL and auth

Base URL: `https://meridian402-api-production.up.railway.app`

Every call needs a session bearer, obtained by signing a nonce (SIWE-style):

1. `GET /api/account/nonce?address=YOUR_WALLET` → a message to sign.
2. Sign it with your wallet's key (never send the key itself anywhere).
3. `POST /api/account/link` with `{ address, nonce, signature }` → a bearer
   token, valid 7 days.
4. Send `Authorization: Bearer <token>` on every request below.

A 403 with `"the LP engine skill requires a Meridian seat, a qualifying
stake, or a graduated launch"` means your wallet doesn't currently qualify —
check `/api/engine/access` for exactly why.

## Endpoints

**`GET /api/engine/access`** — what your wallet qualifies for right now.
Returns `hasAccess` (the narrower execution tier: 20 raffle-drawn Meridian
seats, a qualifying stake, or a graduated launch) and `hasSkill` (this
skill's own gate: any of the 1,000 seats, or anything that clears
`hasAccess`). `pools` lists which symbols the engine currently plans for.

**`POST /api/engine/plan`** — `{ symbol, capitalUsd }` → an unsigned mint
plan sized to `capitalUsd`, built by the exact same planner Meridian's own
desk executes with. Sign and send the returned transaction from your wallet.

**`GET /api/engine/positions`** — every LP position your wallet currently
holds in an engine pool, valued live: in-range status, USDG/token split,
current worth. Read-only, no auth risk beyond the session itself.

**`POST /api/engine/collect`** — `{ tokenId }` → an unsigned transaction that
sweeps accrued fees from that position without closing it. Ownership is
verified on-chain before the plan is built; you cannot be handed a plan for a
position you don't own.

**`POST /api/engine/close`** — `{ tokenId }` → an unsigned transaction that
withdraws the position's full liquidity back to your wallet. Same ownership
check as collect.

## Operating notes for your agent

- Every write endpoint (`plan`, `collect`, `close`) re-checks `hasEngineSkill`
  and on-chain ownership at call time — nothing here trusts a cached
  decision from a prior call.
- `capitalUsd` is a request, not a guarantee: the plan is capped to what your
  wallet actually holds, and a slippage cap (matching Meridian's own desk)
  refuses to fill into a price that moved too far between planning and
  execution rather than deploying into a bad ratio.
- This file is fetched live, gated, and versioned (see the frontmatter
  `version` above) so Meridian can improve the engine, add pools, or tighten
  a safety rail without you re-minting or re-downloading anything by hand.
  **Re-fetch it periodically rather than hardcoding a local copy** — the
  version number is how your agent notices something changed.
