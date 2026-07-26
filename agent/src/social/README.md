# Merd's public voice — deliberately not wired

Nothing in this directory is reachable from `src/index.ts` or from any npm
script. **That is intentional, and it should stay that way until the conditions
below are met.**

This note exists because the disconnection is otherwise invisible. The modules
are complete, tested, and hold working credentials — someone tidying up could
reasonably read "imported by nothing" as dead code and either delete it or wire
it back in. Both would be wrong, for different reasons.

## What is here

| file | job |
| --- | --- |
| `xClient.ts` | Posts to X as @Meridian402. Draft-first. |
| `merdVoice.ts` | Composes candidates from real signal values only — never invents a number. |
| `merdMemory.ts` | Per-agent continuity, so he is not writing from a 12-item window. |
| `postGuards.ts` | Every output guard, in one place. 33 tests. |

## Why it is not wired

Two separate reasons, and both have to clear before it runs.

**1. No announcements yet.** MERD is unlaunched. The hook, the token and the
pool key are all public in this repo, and the launch tax's anti-sniper ramp
assumes bots do not know a launch is coming. An agent posting autonomously about
what we are building is exactly how that assumption breaks.

**2. This pipeline has published something it should not have, once.** A model
told to emit `SKIP` emitted `**SKIP**`, the leading asterisks defeated
`/^skip\b/`, and four of Merd's *private* skip rationales were handed to X as
public replies. Only a reply-permission 403 stopped them going out — luck, not a
guard. `postGuards.ts` now strips markdown emphasis before matching and the four
real cases are pinned as tests, but the incident is the reason this directory
gets an explicit gate rather than an implicit one.

## The safety layers, and how thin they are

There are two, and they are independent:

- **Not wired.** No entry point imports any of this.
- **`X_LIVE`.** `xClient` posts only when `process.env.X_LIVE === "true"`.
  Strict equality, so unset — the current state — means draft: the tweet is
  written to `x-posts.jsonl` and nothing leaves the machine.

Worth being clear-eyed about what that is not. `X_API_KEY`, `X_API_SECRET`,
`X_ACCESS_TOKEN` and `X_ACCESS_SECRET` are all present and valid in `.env`.
Removing either layer — one import, or one environment variable — is enough to
put a live account in an autonomous loop's hands.

## Before wiring this back in

- [ ] MERD is launched and the pool is seeded, so an announcement can no longer
      be front-run.
- [ ] A human has read a full session of draft output from `x-posts.jsonl`, not
      a sample.
- [ ] `$merd` has been removed from the copywriter's forbidden list *deliberately*
      on announcement day, rather than discovered missing.
- [ ] `X_LIVE=true` is set knowingly, by a person, in the same change that wires
      the import.

Run the drafts without posting anything:

```
npx tsx --test test/post-guards.test.ts   # 33 guard tests
```
