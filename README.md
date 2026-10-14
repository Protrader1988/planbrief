# PlanBrief

Upload an RFP, RFQ, drawing set or spec book. Get back a narrated video that walks through the whole package top down, filmed over the real pages, with an on-screen pointer and highlights on whatever is being discussed. A written brief (scope, key dates, requirements, risks, questions to ask) ships alongside it.

## How it works

1. **Read** – every page is rendered to an image and its text layer extracted (poppler).
2. **Script** – Claude reads all pages (images + text) and writes a plain-English script: one segment per idea, each tied to a page, a camera focus box, and callouts (label + box + the phrase in the narration that triggers the pointer). Via Claude Code (subscription), a pasted script (manual), or the API.
3. **Narrate** – each segment is voiced with Piper (free, offline) or OpenAI TTS.
4. **Film** – frames are drawn on a canvas (camera moves, highlights, pointer, titles, progress bar) and piped into ffmpeg with the narration.

Everything runs in one Node process with a file-backed job queue. No database required.

## Run it for free (recommended)

Everything runs on your own Mac. No server bill, no per-document API cost:

- **Reading the document:** the Claude Code CLI, which is included in Claude Pro and Max subscriptions. The app shells out to `claude -p` on your machine; it reads the page images and text and writes the script.
- **Narration:** Piper, an open-source offline voice.
- **Rendering:** ffmpeg on your CPU.

```bash
./setup-mac.sh        # installs ffmpeg, poppler, the voice, builds the app
claude login          # once, if Claude Code isn't logged in yet
npm start             # http://localhost:3000
```

If Claude Code isn't installed, set `ANALYZE_PROVIDER=manual` in `.env`: after upload the job page shows a prompt to paste into a Claude chat, and a box to paste the JSON script back. The app then narrates and films it.

To reach it from your phone on the same Wi-Fi, use your Mac's local address (`http://<mac-ip>:3000`); for anywhere, a free Cloudflare Tunnel.

## Run with API keys instead

Needs Node 22, `ffmpeg`, and poppler (`pdftoppm`, `pdftotext`, `pdfinfo`). Set `ANALYZE_PROVIDER=api` with `ANTHROPIC_API_KEY`, and optionally `TTS_PROVIDER=openai` with `OPENAI_API_KEY`.

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:3000
```

Smoke test without any API keys:

```bash
python3 scripts/make-sample.py data/sample.pdf
npm run test:render -- data/sample.pdf data/test.mp4
```

or run the whole web flow keyless with `ANALYZE_MOCK=1 TTS_PROVIDER=silent npm run dev`.

## Deploy (Railway, Render, Fly, any Docker host)

The `Dockerfile` installs ffmpeg and poppler and builds a standalone Next.js server.

- Mount a persistent volume at `/data` (uploads, page images and videos live there).
- Set `ANALYZE_PROVIDER=api` with `ANTHROPIC_API_KEY` (Claude Code isn't available inside the container), and `TTS_PROVIDER=openai` with `OPENAI_API_KEY` or `piper` with a voice on the volume.
- Give it at least 2 GB RAM. Rendering is CPU-bound and runs at roughly a third of real time at 1080p (a 10-minute video takes about 30 minutes on a laptop).

Railway: New Project → Deploy from GitHub repo → add a Volume mounted at `/data` → add the variables. Render: New Web Service → Docker → add a Disk at `/data`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANALYZE_PROVIDER` | `claude-code` | `claude-code`, `manual`, `api` or `mock` |
| `CLAUDE_CODE_BIN` | `claude` | path to the Claude Code CLI |
| `ANTHROPIC_API_KEY` | – | only for `ANALYZE_PROVIDER=api` |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | model used to write the script |
| `TTS_PROVIDER` | auto | `piper`, `openai` or `silent` |
| `PIPER_MODEL` | – | path to a Piper voice `.onnx` (`scripts/get-voice.sh`) |
| `OPENAI_API_KEY` | – | for `TTS_PROVIDER=openai` |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | `gpt-4o-mini-tts` / `onyx` | voice |
| `DATA_DIR` | `./data` | storage root |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` / `VIDEO_FPS` | 1920 / 1080 / 24 | output format |
| `VIDEO_CRF` / `VIDEO_PRESET` | 18 / medium | x264 quality and speed |
| `RENDER_DPI` | 150 | page rasterization; raise for very dense sheets |
| `ANALYZE_MAX_IMAGES` | 40 | how many page images go to the model (text goes for all pages) |
| `MAX_UPLOAD_MB` | 200 | upload cap |

## Roadmap

- Accounts and per-client workspaces (needed before selling it).
- Background worker + object storage so renders can scale past one box.
- Two-pass analysis for 100+ sheet sets (index pass, then per-discipline passes).
- Re-render only the changed segment when a script is edited (today the whole video is re-filmed).
- Subtitles burned in or as a .vtt track.
