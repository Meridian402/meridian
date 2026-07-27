#!/bin/bash
# Snapshot Merd's memory + action logs into his PRIVATE repo so they survive this
# machine WITHOUT being public. Self-throttles to ~once a day (FORCE=1 overrides).
export PATH="/usr/local/bin:$PATH"
AGENT="$(cd "$(dirname "$0")" && pwd)"
MEM="$HOME/meridian-memory"   # PRIVATE repo (louz514/meridian-memory)
STAMP="$HOME/.merd-backup-stamp"

if [ "$FORCE" != "1" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(cat "$STAMP" 2>/dev/null || echo 0) )) -lt 72000 ]; then
  exit 0
fi
[ -d "$MEM/.git" ] || { echo "private memory repo missing at $MEM"; exit 1; }

mkdir -p "$MEM/workspace"
cp -Rf ~/.openhermit/workspaces/merd/. "$MEM/workspace/" 2>/dev/null
# x-replies is the engage/outreach dedupe ledger and the *-state files are the
# mention/outreach cursors; losing any of them means double-replies, not a gap.
cp -f "$AGENT/x-posts.jsonl" "$AGENT/merd-decisions.jsonl" "$AGENT/x-replies.jsonl" \
      "$AGENT/merd-engage-state.json" "$AGENT/merd-outreach-state.json" "$MEM/" 2>/dev/null
cd "$MEM" || exit 1
git add -A >/dev/null 2>&1
if ! git diff --cached --quiet; then
  git commit -q -m "merd memory $(date +%F_%H%M)"
  git push -q -u origin HEAD 2>/dev/null && echo "merd memory backed up to PRIVATE repo"
fi
date +%s > "$STAMP"
