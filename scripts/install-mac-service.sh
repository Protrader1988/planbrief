#!/usr/bin/env bash
# Installs PlanBrief as a background service on this Mac (starts at login, restarts if it
# crashes) and prints how to reach it. Run from the project folder after setup-mac.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.planbrief.server.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/data/logs"
[ -f .env ] || cp .env.example .env
[ -d .next/standalone ] || npm run build
# standalone build needs the static assets next to it
rm -rf .next/standalone/.next/static && cp -R .next/static .next/standalone/.next/static
rm -rf .next/standalone/public && cp -R public .next/standalone/public
rm -rf .next/standalone/scripts && cp -R scripts .next/standalone/scripts

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.planbrief.server</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>set -a; source "$PROJECT/.env"; set +a; export DATA_DIR="$PROJECT/data"; export PORT=3000; export HOSTNAME=0.0.0.0; cd "$PROJECT/.next/standalone" && exec "$NODE" server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>StandardOutPath</key><string>$PROJECT/data/logs/server.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/data/logs/server.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
if curl -sf -o /dev/null http://localhost:3000/login || curl -sf -o /dev/null http://localhost:3000/; then
  echo "PlanBrief is running: http://localhost:3000"
else
  echo "Service installed but not answering yet; check $PROJECT/data/logs/server.err.log"
fi
