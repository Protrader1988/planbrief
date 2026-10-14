# PlanBrief

Upload an RFP, RFQ, drawing set or spec book. Get back a narrated video that walks through the whole package top down, filmed over the real pages, with an on-screen pointer and highlights on whatever is being discussed. A written brief (scope, key dates, requirements, risks, questions to ask) ships alongside it.

## How it works

1. **Read** – every page is rendered to an image and its text layer extracted (poppler).
2. **Script** – Claude reads all pages (images + text) and writes a plain-English script: one segment per idea, each tied to a page, a camera focus box, and callouts (label + box + the phrase in the narration that triggers the pointer).
3. **Narrate** – each segment is voiced with OpenAI TTS (silent track if no key is set).
4. **Film** – frames are drawn on a canvas (camera moves, highlights, pointer, titles, progress bar) and piped into ffmpeg with the narration.

Everything runs in one Node process with a file-backed job queue. No database required.

## Run locally

Needs Node 22, `ffmpeg`, and poppler (`pdftoppm`, `pdftotext`, `pdfinfo`).

```bash
cp .env.example .env   # add ANTHROPIC_API_KEY and OPENAI_API_KEY
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
- Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
- Give it at least 2 GB RAM. Rendering is CPU-bound and runs about real time at 720p (a 10-minute video takes roughly 10 minutes).

Railway: New Project → Deploy from GitHub repo → add a Volume mounted at `/data` → add the variables. Render: New Web Service → Docker → add a Disk at `/data`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | required for the analysis step |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | model used to write the script |
| `OPENAI_API_KEY` | – | narration; without it the track is silent |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | `gpt-4o-mini-tts` / `onyx` | voice |
| `TTS_PROVIDER` | auto | `openai` or `silent` |
| `DATA_DIR` | `./data` | storage root |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` / `VIDEO_FPS` | 1280 / 720 / 24 | output format |
| `ANALYZE_MAX_IMAGES` | 40 | how many page images go to the model (text goes for all pages) |
| `MAX_UPLOAD_MB` | 200 | upload cap |

## Roadmap

- Accounts and per-client workspaces (needed before selling it).
- Background worker + object storage so renders can scale past one box.
- Two-pass analysis for 100+ sheet sets (index pass, then per-discipline passes).
- Editable script: fix a sentence or a highlight box, re-render only that segment.
- Subtitles burned in or as a .vtt track.
