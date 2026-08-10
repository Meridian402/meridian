# Deploying the Meridian backend

One long-running Node process (agent loop + MCP server + REST API). Any
container host works: Fly.io, Railway, Render, a VPS.

## READ THIS FIRST: pushing does not deploy. Anywhere.

Neither repo has a working GitHub integration since the org rename to
Meridian402 (both remotes still print "This repository moved" on every push,
which is the tell). A push updates main and changes NOTHING in production.
Every deploy is manual:

**Backend (this repo) -> Railway:**

    npm --prefix agent run build        # verify it compiles before uploading
    cd agent && railway up --detach -s meridian402-api

**Frontend (meridian-frontend repo) -> Vercel:**

    vercel build --prod --yes           # rebuilds .vercel/output FRESH
    vercel deploy --prebuilt --prod --yes

For the frontend, never skip the `vercel build` step: `deploy --prebuilt`
ships whatever is sitting in `.vercel/output`, silently, even if it is days
stale. That exact mistake shipped an old bundle on 2026-08-10. Verify the
artifact before shipping when the change matters (grep the built output for
the string you changed).

Two real incidents this causes, both already paid for: code running in prod
that was never committed (the earnings tx field, found only because the next
deploy would have silently reverted it), and commits on main that never ran
in prod (three desk fixes sat inert for hours on 2026-08-09 while the desk
stayed frozen). After deploying, diff your assumption: check a log line or an
API field that only the new code produces. Reconnecting the GitHub
integrations in the Railway and Vercel dashboards would retire this whole
section; until someone does, this is the procedure.

## Required env

- `ROBINHOOD_RPC_URL` — chain RPC
- `AGENT_SIGNER_PRIVATE_KEY` — the agent wallet key. THIS LIVES ON THE HOST.
  Fund it only with what you'd accept losing to a host compromise.
- `AGENT_LIVE_TRADING` — `true` to trade, `false` for observe-only
- `MERIDIAN_LP_ENGINE`: `on` to run the autonomous liquidity loops (LP guard +
  allocator); anything else boots API-only and moves no funds. Set it only on
  the one instance that holds the signer key.
- `MERIDIAN_MCP_TOKEN` — bearer token gating /mcp and /api/index-trade
- `MERIDIAN_MCP_HOST=0.0.0.0` — bind publicly inside the container
- `MERIDIAN_TREASURY_ADDRESS` — x402 payTo
- Optional: `GATEWAY_ADMIN_TOKEN` + `OPENHERMIT_GATEWAY_URL` (auto-provision
  reservations), `MERIDIAN_PUBLIC_MCP_URL` (advertised MCP URL for fleets).

## Shipping to Railway: pushing to GitHub does NOT deploy

The Railway service has **no GitHub source connected** (`source: null`). Deploys
are manual, from a local working tree:

    cd agent && npm run build && railway up -s meridian402-api

**A `git push` changes nothing in production.** Verified 2026-08-09: two fixes
were committed, pushed, and sat inert for hours while the desk kept running the
previous build. `railway deployment list` is the truth about what is live; the
git log is not.

Two consequences worth holding onto:

- **Production and `main` can drift silently, in both directions.** `railway up`
  uploads the working tree, so anything uncommitted ships. That is how the `tx`
  receipt field ran in production for an unknown length of time while
  `origin/main` did not have it, and why the next deploy would have silently
  removed it. Before deploying, confirm `git status` is clean and HEAD matches
  `origin/main`, or you cannot say afterwards what is running.
- **A deploy carries everything committed since the last one**, including work
  that was deliberately left unshipped. Read `git log origin/main..HEAD` and the
  diff against the live deployment before running `railway up`, and check for
  commits whose message says NOT DEPLOYED.

Connecting the repo so pushes deploy would remove this whole class of problem.
Until then, treat `railway up` as the only thing that ships and check what it is
about to carry.

## Persistence

`reservations.jsonl`, `fleets.jsonl`, `basis-log.jsonl`, `position-state.json`
are append-only files in the workdir — mount a volume or they reset on deploy.

## After it's up

1. The API is live on Railway at `https://meridian402-api-production.up.railway.app`;
   the frontend's `VITE_MERIDIAN_API_URL` already points there.
2. OPTIONAL — for a clean API domain: add `api.meridian402.xyz` as a custom domain
   on the Railway service, point its DNS at Railway, then set BOTH
   `VITE_MERIDIAN_API_URL` and `MERIDIAN_PUBLIC_MCP_URL` to it and redeploy.
   (Not set up today — the bare `api.meridian402.xyz` host is a dead Vercel record.)
3. Public surface: GET feeds + POST /api/reserve-profile + /api/fleet/export
   are open by design; /mcp and /api/index-trade require the bearer token.

## Fly.io quickstart (once `flyctl auth login` is done)

    fly launch --no-deploy          # accepts this Dockerfile
    fly volumes create meridian_data --size 1
    fly secrets set ROBINHOOD_RPC_URL=... AGENT_SIGNER_PRIVATE_KEY=... \
      MERIDIAN_MCP_TOKEN=... MERIDIAN_TREASURY_ADDRESS=... AGENT_LIVE_TRADING=true
    fly deploy
