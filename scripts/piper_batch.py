"""Synthesize many short texts with one loaded Piper voice.
stdin: JSON lines {"text": ..., "output_file": ...}
usage: python3 scripts/piper_batch.py /path/voice.onnx
"""
import json, sys, wave
from piper import PiperVoice

voice = PiperVoice.load(sys.argv[1])
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    job = json.loads(line)
    with wave.open(job["output_file"], "wb") as w:
        voice.synthesize_wav(job["text"], w)
