#!/bin/bash
# The pool watch (src/signals/poolWatch.ts). READ-ONLY: no signer, no key.
# launchd runs it once an hour. Each run appends the completed hours for the
# watched pools to pool-watch.jsonl next to this script, then exits.
# Report: npm run pool-watch:report
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
unset AGENT_SIGNER_PRIVATE_KEY   # belt and braces: this process never signs
exec ./node_modules/.bin/tsx src/signals/poolWatch.ts "$@"
