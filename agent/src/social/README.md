# Merd's public voice — wired, in draft mode

`cadence.ts` is started from `src/index.ts` and composes a candidate a few times
a week. **Nothing publishes**: `xClient` posts only when `X_LIVE === "true"`,
and that variable is unset, so candidates are written to `x-posts.jsonl` and go
no further.

The launch itself remains off limits. MERD is built and unlaunched, the whole
PoolKey is public in this repo, and v4's `initialize` is permissionless — so
anyone who learns a launch is imminent can open our pool first at a price of
their choosing, and the 10% anti-sniper ramp assumes bots do not know it is
coming.

This note exists because the safety here rests on one environment variable, and
that is easy to miss. The credentials are real and the account is real; only
`X_LIVE` stands between a draft and a published tweet.

## What is here

| file | job |
| --- | --- |
| `xClient.ts` | Posts to X as @Meridian402. Draft-first. |
| `merdVoice.ts` | Composes candidates from real signal values only — never invents a number. |
| `merdMemory.ts` | Per-agent continuity, so he is not writing from a 12-item window. |
| `postGuards.ts` | Every output guard, in one place. 38 tests. |
| `cadence.ts` | Decides when he has something worth saying, and stays quiet otherwise. |

## Why the launch is still off limits

**1. No announcements yet.** Blocked in code, not in the prompt. A probe of nine
plausible launch sentences found that **all nine passed the guards** as they
stood — including one containing a bare contract address. `postGuards.ts` now
blocks the ticker (by CASE: the agent is named Merd, so a case-insensitive rule
would gag him saying his own name), contract addresses, contract names,
buyback-and-burn, launch mechanics, lock claims, deployment internals and hook
mechanics. All nine are pinned as tests.

**2. This pipeline has published something it should not have, once.** A model
told to emit `SKIP` emitted `**SKIP**`, the leading asterisks defeated
`/^skip\b/`, and four of Merd's *private* skip rationales were handed to X as
public replies. Only a reply-permission 403 stopped them going out — luck, not a
guard. `postGuards.ts` now strips markdown emphasis before matching and the four
real cases are pinned as tests, but the incident is the reason this directory
gets an explicit gate rather than an implicit one.

## The safety layers, and how thin they are

Only one now that the cadence is wired, so it carries all the weight:

- **`X_LIVE`.** `xClient` posts only when `process.env.X_LIVE === "true"`.
  Strict equality, so unset — the current state — means draft: the tweet is
  written to `x-posts.jsonl` and nothing leaves the machine.

Worth being clear-eyed about what that is not. `X_API_KEY`, `X_API_SECRET`,
`X_ACCESS_TOKEN` and `X_ACCESS_SECRET` are all present and valid in `.env`.
One environment variable is now the whole distance between a draft file and a
live account posting unattended.

## Before flipping X_LIVE

- [ ] A human has read a full session of draft output from `x-posts.jsonl`, not
      a sample.
- [ ] MERD is launched and the pool is seeded **before any launch content is
      unblocked** — the cadence itself can run before then, it just cannot talk
      about the token.
- [ ] `$merd` has been removed from the copywriter's forbidden list *deliberately*
      on announcement day, rather than discovered missing.
- [ ] `X_LIVE=true` is set knowingly, by a person.

Run the drafts without posting anything:

```
npx tsx --test test/post-guards.test.ts   # 38 guard tests
```

Cadence knobs: `MERD_POST_MIN_GAP_HOURS` (default 8) and
`MERD_POST_CHECK_MINUTES` (default 45).
