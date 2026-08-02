#!/bin/bash
# One-shot treasury burn, hand-run only. Usage: ./_merd-burn.sh <token> <amount|all>
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ===" >> _burn.log
./node_modules/.bin/tsx _merd-burn.mts "$@" 2>&1 | tee -a _burn.log
