#!/bin/bash
# The launch-hour watcher (D1 of LAUNCH-HOUR-SPEC.md). READ-ONLY: no signer,
# no key. launchd keeps it alive; it polls the chain every few seconds and
# writes launch-watch.jsonl + launch-watch-state.json next to this script.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
unset AGENT_SIGNER_PRIVATE_KEY   # belt and braces: this process never signs
exec ./node_modules/.bin/tsx src/launch/watch.ts
