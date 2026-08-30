#!/bin/bash
# The whole X account's last 24h in one read: posts, replies, plan progress,
# the print, and job health. See X-OPS.md for what each system is.
cd "$(dirname "$0")" || exit 1

python3 - << 'EOF'
import json, datetime, os, subprocess

now = datetime.datetime.now()
day_ago = now.timestamp() * 1000 - 86400e3

def rows(path):
    out = []
    if os.path.exists(path):
        for l in open(path):
            if l.strip():
                try: out.append(json.loads(l))
                except: pass
    return out

def when(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%H:%M")

print(f"@Meridian402 · last 24h · as of {now.strftime('%a %H:%M %Z')}\n")

posts = [r for r in rows("x-posts.jsonl") if r.get("at", 0) >= day_ago]
live = [r for r in posts if r.get("posted")]
failed = [r for r in posts if not r.get("posted") and r.get("mode") == "live"]
print(f"POSTED ({len(live)}):")
for r in live:
    text = (r.get("text") or "").replace("\n", " / ")
    media = " [card]" if r.get("media") else ""
    print(f"  {when(r['at'])}{media}  {text[:110]}{'...' if len(text) > 110 else ''}")
if failed:
    print(f"FAILED ({len(failed)}):")
    for r in failed:
        print(f"  {when(r['at'])}  {r.get('error', r.get('reason', '?'))[:90]}")

plan = rows("merd-daily-plan.jsonl")
done = rows("merd-daily-done.jsonl")
today = now.strftime("%Y-%m-%d")
plan_today = [p for p in plan if p.get("day") == today]
done_today = [d for d in done if d.get("day") == today]
if plan_today:
    items = plan_today[-1].get("items", plan_today)
    n = len(items) if isinstance(items, list) else "?"
    print(f"\nPLAN: {len(done_today)}/{n} of today's plan posted")
else:
    print(f"\nPLAN: none generated yet today")

dp = rows("daily-print.jsonl")
dp_recent = [r for r in dp if r.get("ts", 0) >= day_ago]
if dp_recent:
    r = dp_recent[-1]
    print(f"PRINT: day {r.get('day')} {'posted ' + when(r['ts']) if r.get('posted') else 'FAILED: ' + str(r.get('reason'))[:60]}")
else:
    print("PRINT: none in the last 24h" + (" (before 9:15am)" if now.hour < 9 or (now.hour == 9 and now.minute < 15) else " <- check merd-daily-print.log"))

print("\nJOBS (launchd, last exit):")
out = subprocess.run(["launchctl", "list"], capture_output=True, text=True).stdout
for line in out.splitlines():
    if "com.meridian" in line:
        pid, code, label = line.split("\t")
        state = "running" if pid != "-" else ("ok" if code == "0" else f"EXIT {code}")
        print(f"  {label.replace('com.meridian.', ''):<14} {state}")
EOF
