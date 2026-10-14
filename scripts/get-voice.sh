#!/usr/bin/env bash
# Installs the free offline narration voice (Piper + en-us-lessac-medium).
set -euo pipefail
cd "$(dirname "$0")/.."
pip3 install -q piper-tts --break-system-packages 2>/dev/null || pip3 install -q piper-tts
mkdir -p data/voices && cd data/voices
if [ ! -f en-us-lessac-medium.onnx ]; then
  curl -sSL -o v.tar.gz https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-us-lessac-medium.tar.gz
  tar xzf v.tar.gz && rm v.tar.gz
fi
echo "Voice ready: $(pwd)/en-us-lessac-medium.onnx"
