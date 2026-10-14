#!/usr/bin/env bash
# One-time setup on a Mac for the free configuration (local Claude Code + Piper voice).
set -euo pipefail
cd "$(dirname "$0")"
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
brew list poppler >/dev/null 2>&1 || brew install poppler
command -v node >/dev/null || brew install node@22
command -v claude >/dev/null || { echo "Install Claude Code, then run: claude login"; echo "  npm install -g @anthropic-ai/claude-code"; }
npm install
./scripts/get-voice.sh
[ -f .env ] || cp .env.example .env
npm run build
echo
echo "Done. Start it with:  npm start   then open http://localhost:3000"
