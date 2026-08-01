#!/bin/bash
# Merd pays his scouts (called by launchd on a cadence). Dormant until
# MERD_TREASURY_WALLET_KEY is set in .env by the operator.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ===" >> _payout.log
./node_modules/.bin/tsx _merd-payout.mts >> _payout.log 2>&1
