#!/bin/bash
# Merd reviews the platform dials (called by launchd on a cadence). Dormant
# until MERIDIAN_MCP_TOKEN is set in .env.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
echo "=== $(date) ===" >> _steward.log
./node_modules/.bin/tsx _merd-steward.mts >> _steward.log 2>&1
