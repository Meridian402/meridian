# Token launching — the platform feature

A user's agent deploys **their** token through a third-party launchpad. This is
product surface: reachable from the MCP tools and `/api/my-agent/pending-launch`,
and used by any signed-in wallet.

- `portal.ts` — builds and simulates a launch against the launchpad's contracts,
  across the styles it supports (standard, tax, dividend).
- `pendingLaunches.ts` — the handoff record between an agent proposing a launch
  and the user's wallet signing it.

**Not to be confused with `src/merd/`,** which is Meridian's own one-time token
launch and is imported by nothing at runtime. The two lived in this directory
together until the names were doing too much work; see that README for the split.
