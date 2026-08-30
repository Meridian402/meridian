#!/bin/bash
# Install (or refresh) Merd's launchd jobs from wherever this repo currently lives.
#
# launchd will not expand $HOME inside a plist, so the job definitions need real
# absolute paths. Rather than commit those (they leak local paths into a public
# repo, and they break the moment the repo moves) the plists are generated here
# from this script's own location. Moving the repo means re-running this.
#
#   bash install-agents.sh              generate the plists and load the jobs
#   bash install-agents.sh --uninstall  unload the jobs and remove the plists
#
# Loading never fires a job immediately: RunAtLoad is false, so the first run is
# one StartInterval away. Re-running is idempotent.
set -euo pipefail

AGENT="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"

# label | runner | interval (seconds) | log file
# Outreach runs on the longest cadence of the three: replying into other
# people's conversations should read as considered, not constant.
JOBS=(
  "com.meridian.merdx|_merd-post.sh|7200|merd-autopilot.log"
  "com.meridian.merdengage|_merd-engage.sh|120|merd-engage.log"
  "com.meridian.merdoutreach|_merd-outreach.sh|10800|merd-outreach.log"
  # The Daily Print ticks every 15 minutes and gates itself: one post per day,
  # the first tick at or after 9:15am ET, so a sleeping Mac posts on wake
  # instead of skipping the day. See _merd-daily-print.mts.
  "com.meridian.merddailyprint|_merd-daily-print.sh|900|merd-daily-print.log"
)

if [ "${1:-}" = "--uninstall" ]; then
  for job in "${JOBS[@]}"; do
    IFS='|' read -r label _ _ _ <<<"$job"
    plist="$LAUNCH_DIR/$label.plist"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "removed $label"
  done
  exit 0
fi

mkdir -p "$LAUNCH_DIR" "$LOG_DIR"

for job in "${JOBS[@]}"; do
  IFS='|' read -r label runner interval log <<<"$job"
  script="$AGENT/$runner"
  [ -f "$script" ] || { echo "missing runner: $script" >&2; exit 1; }
  chmod +x "$script"

  plist="$LAUNCH_DIR/$label.plist"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$script</string>
  </array>
  <key>StartInterval</key>
  <integer>$interval</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/$log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/$log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

  plutil -lint "$plist" >/dev/null || { echo "generated a bad plist: $plist" >&2; exit 1; }
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load -w "$plist"
  echo "installed $label -> $script (every ${interval}s)"
done

echo
echo "loaded:"
launchctl list | grep -E "com\.meridian\." || echo "  none found"
