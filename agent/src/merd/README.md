# MERD's own launch — operator tooling, not platform code

Nothing in this directory is imported by the running server. It is a one-time
toolkit for launching Meridian's own token: mining addresses, deploying the
token, hook, lock and buyback, and seeding the pool.

**This is not the same thing as `src/launch/`,** and the two were tangled in one
directory until they were split. The distinction is the one that matters:

| | `src/launch/` | `src/merd/` (here) |
| --- | --- | --- |
| What | A **platform feature**: a user's agent deploys *their* token via a third-party launchpad | **Our own** token launch, once |
| Who runs it | Any signed-in user, through the MCP tools and `/api/my-agent/*` | An operator, by hand, one time |
| Imported by the server | Yes — `mcp/server.ts`, `deploy/myAgent.ts`, `index.ts` | **No. Nothing.** |
| Lifetime | For as long as the product exists | Ends the day the pool is seeded |

Keeping them apart matters for more than tidiness. A reader who sees "launch"
and finds MERD's treasury hook reasonably concludes the platform ships that hook
to users, which it does not. And the server importing this directory would drag
an unlaunched token's addresses into a process that answers public requests.

## What is here

Deploy order is a dependency chain, not a checklist — each step produces a value
the next one needs, and a v4 pool's hook is fixed at creation:

1. `hookMiner.ts` — CREATE2 salt search; v4 reads hook permissions out of the address
2. `deployHook.ts` — the treasury hook (decaying tax, fee split)
3. `deployToken.ts` — MERD itself
4. `deployLock.ts` — permanent custody for the LP position
5. `seedPool.ts` — creates and seeds the pool atomically, with a squat preflight
6. `merd.ts` — every pinned parameter and address, the single source of truth
7. `v4Pool.ts`, `wallets.ts` — verified venue addresses and the wallet topology

## Rules

- **The server must never import from here.** If something in this directory is
  needed at runtime, that is a signal the boundary is wrong, not that the import
  is fine.
- Addresses here are a function of their constructor arguments. Changing the
  treasury, the schedule or the compiler settings moves all four, and the tests
  in `test/merd-*.test.ts` fail loudly when a recorded address stops reproducing.
- None of this is public yet. See `src/social/README.md` for what Merd may say.
