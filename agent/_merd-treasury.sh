#!/bin/bash
# Merd manages his treasury's USDG float (called by launchd on a cadence).
# Dormant until MERD_TREASURY_WALLET_KEY is set in .env by the operator.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ===" >> _treasury.log
./node_modules/.bin/tsx _merd-treasury.mts >> _treasury.log 2>&1
