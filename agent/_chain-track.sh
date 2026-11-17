#!/bin/bash
# The chain track (src/signals/chainTrack.ts). READ-ONLY: no signer, no key, and
# on chains where the desk holds nothing. launchd runs it once an hour. Each run
# appends the completed hours for the watched pools on BNB Chain, Base and
# Ethereum to <chain>-track.jsonl next to this script, then exits. One chain
# failing does not stop the others.
# Reports: npm run chain-track:rank     npm run chain-track -- base --report
# Scans:   npm run chain-track -- eth --scan
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
unset AGENT_SIGNER_PRIVATE_KEY   # belt and braces: this process never signs
if [ "$#" -gt 0 ]; then
  exec ./node_modules/.bin/tsx src/signals/chainTrack.ts "$@"
fi
for chain in bnb base eth; do
  ./node_modules/.bin/tsx src/signals/chainTrack.ts "$chain" || echo "[chainTrack $chain] run failed, continuing"
done
# Token signals (src/signals/tokenSignals.ts), same hour, all four chains: who
# is trading and holding each watched token, and whether the pool is trending.
# From the public pool index only; it reads no chain and decides nothing.
# Report: npm run token-signals:report
./node_modules/.bin/tsx src/signals/tokenSignals.ts || echo "[tokenSignals] run failed, continuing"
