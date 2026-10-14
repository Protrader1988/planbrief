#!/usr/bin/env bash
# Gives the running PlanBrief a stable public HTTPS address using Tailscale Funnel (free).
# First run opens a browser to sign in to Tailscale; after that it is automatic.
set -euo pipefail
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
if ! command -v tailscale >/dev/null; then
  brew install --cask tailscale-app 2>/dev/null || brew install tailscale
fi
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
if ! "$TS" status >/dev/null 2>&1; then
  open -a Tailscale 2>/dev/null || true
  echo "Sign in to Tailscale in the window that opened, then re-run this script."
  exit 0
fi
"$TS" funnel --bg 3000
echo
echo "Phone address:"
"$TS" funnel status 2>/dev/null | grep -Eo 'https://[^ ]+' | head -1
echo "(Set APP_PASSWORD in .env before sharing this address.)"
