#!/bin/bash
# One-shot treasury bridge, hand-run only. Usage: MERD_TREASURY_WALLET_KEY=0x... ./_merd-bridge.sh <amountEth>
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
KEY="$MERD_TREASURY_WALLET_KEY"   # capture BEFORE sourcing .env so .env can never supply it
set -a; [ -f .env ] && source .env; set +a
export MERD_TREASURY_WALLET_KEY="$KEY"
echo "=== $(date) ===" >> _bridge.log
./node_modules/.bin/tsx _merd-bridge.mts "$@" 2>&1 | tee -a _bridge.log
