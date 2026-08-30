#!/bin/bash
# The Daily Print runner (launchd, 15-min tick; the script gates itself to one
# post per day at/after 9:15am ET). See _merd-daily-print.mts for the design.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
export X_LIVE=true
./node_modules/.bin/tsx _merd-daily-print.mts
