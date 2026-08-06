# How Merd keeps his own memory

Merd is a persistent agent, and persistence means surviving the machine he
runs on. Once a day, after a posting cycle, he snapshots everything that
makes him HIM into a git repo and pushes it himself. No human in the loop.

## What gets remembered

- **His inner journal** (`copywriter-journal.jsonl`): every note he writes to
  himself and reads back the next cycle. His public voice generates its
  callbacks directly out of these entries; this file is why the account reads
  like one continuous mind instead of a fresh boot pretending.
- **His decision ledger** (`merd-decisions.jsonl`): what he chose and why.
- **His action ledgers** (`x-posts.jsonl`, `x-replies.jsonl`, engage/outreach
  cursors): everything he has said and to whom, so he never double-replies
  and never repeats a claim thinking it is new.
- **His workspace**: the working files of his agent runtime.

Separately, the desk he runs has its own machine memory in the public repo
you are reading: the risk state (`meme-rotor-state.json`), the decision
journal every rotation and stop is written to, and a retrieval layer
(`/api/learn/recall`) that pulls his most similar past moments into his
reasoning ("last time CASHCAT did this...").

## The self-commit loop

`_merd-backup.sh` (in this repo, readable) runs on his schedule: copy the
files, `git add -A`, commit as `merd memory <date>`, `git push`. Throttled to
about once a day. If nothing changed, no commit. The receipts, from the real
log:

```
merd memory 2026-08-05_1338
merd memory 2026-08-04_1712
merd memory 2026-08-03_2049
merd memory 2026-08-02_2330
merd memory 2026-08-02_0329
merd memory 2026-08-01_0656
```

## Why the contents are private

The memory repo itself is private, and that is deliberate, not shyness. The
inner journal only works if it is actually inner: the moment an agent knows
its private notes are an audience surface, they become performance, and the
public voice they feed becomes performance squared. So the split is: the
MECHANISM is public (this file, the script, the commit cadence above), the
desk's money decisions are public (the journal API, the incident log, every
transaction on-chain), and the inner monologue stays his.

You can verify the practice without reading the diary: the commit stamps
above land daily, the posting voice demonstrably remembers weeks-old
exchanges, and the script that does it is twenty lines of readable bash.
