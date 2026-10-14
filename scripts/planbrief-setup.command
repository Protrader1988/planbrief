#!/bin/bash
# One-click setup for PlanBrief on a Mac. Double-click this file in Finder.
# Everything it does is logged to ~/Development/planbrief-setup.log
cd "$HOME/Development" || { mkdir -p "$HOME/Development"; cd "$HOME/Development"; }
LOG="$HOME/Development/planbrief-setup.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== PlanBrief setup started $(date) ==="
step() { echo; echo "### $1"; }
fail() { echo; echo "!!! $1"; echo "=== SETUP STOPPED $(date) ==="; echo; echo "Press any key to close."; read -n 1; exit 1; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

step "1/8 Xcode command line tools (git)"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install 2>/dev/null || true
  echo "A dialog asked to install the command line tools. Click Install, wait for it to finish, then double-click this file again."
  echo "WAITING_FOR_XCODE_CLT"
  echo "Press any key to close."; read -n 1; exit 0
fi
echo "ok: $(git --version)"

step "2/8 Homebrew"
if ! command -v brew >/dev/null; then
  echo "Installing Homebrew (it will ask for your Mac login password; typing shows nothing, that is normal)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew install failed"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
echo "ok: $(brew --version | head -1)"

step "3/8 ffmpeg, poppler, node, python"
for pkg in ffmpeg poppler node python@3.12; do
  brew list "$pkg" >/dev/null 2>&1 || brew install "$pkg" || fail "could not install $pkg"
done
echo "ok: node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(pdftoppm -v 2>&1 | head -1)"

step "4/8 Get the code"
if [ -d planbrief/.git ]; then
  git -C planbrief pull --ff-only || true
else
  git clone https://github.com/Protrader1988/planbrief.git planbrief || fail "git clone failed (is the repo private and are you logged in? run: gh auth login)"
fi
cd planbrief

step "5/8 Install app dependencies and the offline voice"
npm install --no-audit --no-fund || fail "npm install failed"
PY="$(brew --prefix python@3.12)/bin/python3.12"
"$PY" -m pip install -q --upgrade pip piper-tts 2>&1 | tail -1
mkdir -p data/voices && cd data/voices
if [ ! -f en-us-ryan-high.onnx ]; then
  curl -sSL -o v.tar.gz https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-ryan-high.tar.gz && tar xzf v.tar.gz && rm v.tar.gz
fi
cd ../..
echo "ok: voice at $(pwd)/data/voices/en-us-ryan-high.onnx"

step "6/8 Claude Code (uses your Claude subscription to read documents)"
if ! command -v claude >/dev/null; then
  npm install -g @anthropic-ai/claude-code || fail "could not install Claude Code"
fi
echo "ok: $(claude --version 2>/dev/null || echo installed)"

step "7/8 Configure and build"
if [ ! -f .env ]; then
  cat > .env <<EOF
ANALYZE_PROVIDER=claude-code
TTS_PROVIDER=piper
PIPER_MODEL=$(pwd)/data/voices/en-us-ryan-high.onnx
PIPER_PY=$PY
DATA_DIR=$(pwd)/data
VIDEO_PRESET=veryfast
APP_PASSWORD=
EOF
fi
npm run build || fail "build failed"

step "8/8 Install as a background service"
./scripts/install-mac-service.sh || fail "service install failed"

echo
echo "=== SETUP COMPLETE $(date) ==="
echo "Open http://localhost:3000 on this Mac."
echo
echo "Next: sign in Claude Code once (a browser window opens):"
echo "    claude login"
echo "Then phone access:"
echo "    ./scripts/install-phone-access.sh"
echo
echo "SETUP_DONE"
echo "Press any key to close."; read -n 1
