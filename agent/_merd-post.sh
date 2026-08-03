#!/bin/bash
# Merd X runner (called by launchd on a cadence). Daily-plan strategy: a plan of
# 3-5 to-dos is generated once per day and one pending to-do is posted per
# eligible tick. The old ambient poster is _merd-autopilot.mts, kept for revert.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
export X_LIVE=true
echo "=== $(date) ===" >> _daily.log
./node_modules/.bin/tsx _merd-daily.mts >> _daily.log 2>&1
# back up Merd's memory to GitHub (self-throttles to ~once/day)
bash _merd-backup.sh >> _daily.log 2>&1
