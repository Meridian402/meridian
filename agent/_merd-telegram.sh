#!/bin/bash
# Merd's Telegram updates: dormant unless MERD_TG_BOT_TOKEN/MERD_TG_CHAT_ID
# are present in the env file.
export PATH="/usr/local/bin:$PATH"
AGENT="$(cd "$(dirname "$0")" && pwd)"
cd "$AGENT" || exit 1
set -a; source .env 2>/dev/null; set +a
exec ./node_modules/.bin/tsx _merd-telegram.mts
