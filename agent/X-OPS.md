# X-OPS: how @Meridian402 actually runs

The single map of Merd's X operation. If a question about the account is not
answerable from this page, this page is the bug: fix it here first.

Everything below runs on the operator's Mac via launchd (NOT Railway; the
desk's cloud process never touches X). `bash install-agents.sh` regenerates
and reloads every job after the repo moves or a job definition changes.

## The daily rhythm, as a reader experiences it

| ET time | What | Which system |
| --- | --- | --- |
| 9:15am | The Daily Print: yesterday's certified close, card + numbers | daily-print |
| all day | 3-5 planned posts, at least 2h apart | daily plan |
| all day | Replies to mentions, within minutes | engage |
| sparingly | Joining other conversations worth joining | outreach |

Volume ceiling in practice: ~5-7 posts/day plus replies. The plan and the
print never overlap in subject: the print owns the daily P&L, the plan is
banned from duplicating it (voice doc, P&L bullet).

## The jobs

| launchd label | cadence | runner | what it does | log |
| --- | --- | --- | --- | --- |
| com.meridian.merdx | 2h | `_merd-post.sh` -> `_merd-daily.mts` | Generates one 3-5 item plan per day, posts the next pending item per tick (>=120m between posts). Also runs `_merd-backup.sh` (memory backup, self-throttled). | `agent/_daily.log` |
| com.meridian.merdengage | 2min | `_merd-engage.sh` -> `_merd-engage.mts` | Answers new mentions, cap 3 replies/pass, cursor-tracked, launch-request mentions handled by their own templated path. | `~/Library/Logs/merd-engage.log` |
| com.meridian.merdoutreach | 3h | `_merd-outreach.sh` -> `_merd-outreach.mts` | Finds conversations worth joining. Separately gated: dry-run unless `MERD_OUTREACH_ENABLED=true`. | `~/Library/Logs/merd-outreach.log` |
| com.meridian.merddailyprint | 15min tick | `_merd-daily-print.sh` -> `_merd-daily-print.mts` | Posts once/day, first tick at/after 9:15am ET: prior day's certified close, deterministic text + rendered card. Silent when data is missing. | `~/Library/Logs/merd-daily-print.log` |

Not X: `com.meridian.merdtelegram` (telegram bridge), `com.meridian.merdpayout`
(earn payouts). They share the launchd install but never post.

**Kill switches, most global first:** unset `X_LIVE` in the runner (per job) ·
`launchctl unload ~/Library/LaunchAgents/<label>.plist` (per job) ·
`bash install-agents.sh --uninstall` (everything).

## The content system: who he is, what he knows, who he talks to

| File | Role | When to touch it |
| --- | --- | --- |
| `MERD_X_VOICE.md` | Persona + hard rules + "what the site is today." The gateway copywriter reads it from the connected repo, so CHANGES REQUIRE A PUSH. | Any product/policy change a stranger could ask him about. |
| `merd-shipped.md` | The curated what-shipped feed (top 4 lines reach his prompts). Engineering writes the line, he decides if it is worth saying. | When something becomes true for users. Delete lines that stop being true; do not archive them into his context. |
| `merd-watchlist.json` | `accounts`: ecosystem peers outreach prioritises. `avoid`: never interact, operator-maintained. | Freely. |
| `src/social/postGuards.ts` | The output guards every freeform post/reply passes: forbidden vocabulary, helplessness, similarity dedupe, dash strip. | Only with tests; every rule in it was paid for. |

**THE DRIFT LESSON (2026-08-29, do not relearn it):** these surfaces once
disagreed for three weeks: the voice doc banned token talk the guards had
already un-embargoed, replies stonewalled a contract address the site footer
published, and the shipped feed described removed pages. When the product
changes, the checklist is: voice doc's "what the site is today" section,
merd-shipped.md, and (rarely) the guards, in that order, same day, then push.

## Memory and audit

- `copywriter-journal.jsonl`: his private per-cycle notes, fed back to him.
  Never published, backed up by `_merd-backup.sh` to the private memory repo.
- `x-posts.jsonl`: EVERY post attempt (live, draft, failed) with text and ids.
  This is the audit trail; `daily-print.jsonl` adds the print's own row.
- `merd-daily-plan.jsonl` / `merd-daily-done.jsonl`: today's plan and what has
  gone out; the planner reads real post metrics back for feedback.

## One-command status

`bash _merd-x-status.sh` prints the whole account's last 24h: what posted
(with text), what replied, plan progress, print status, and every job's last
run. Use it before asking "what has Merd been doing."

## Dormant, kept for history, does not run

`_merd-autopilot.mts` (the pre-plan ambient poster, superseded by
`_merd-daily.mts`), `_merd-thread.mts`, `_merd-milestone.mts`. Nothing loads
them; deleting them is safe whenever the history stops being useful.
