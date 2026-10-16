# PlanBrief in the cloud, for free

Phone-first, always on, no server bill:

- **Site**: `cloud/site/` (one static page) published on GitHub Pages.
- **Uploads, job status, videos**: a free Supabase project (storage + one table + realtime).
- **Compute**: GitHub Actions. Every new job row triggers `render.yml`, which runs the full pipeline
  (ingest → script → triple verification → narration → film) on a 4-core runner and uploads the video.
  Private repos get 2,000 free minutes a month (roughly 60 to 100 videos); public repos are unlimited.
- **Reading the documents**: Claude Code on the runner with a subscription token (`claude setup-token`),
  so no API bill. Set `ANTHROPIC_API_KEY` instead to use the API.

## Setup (once)

1. Supabase: create a free project, run `cloud/supabase.sql` in the SQL editor.
2. GitHub: create a fine-grained token with *Actions: Read and write* on this repo. Put it and `owner/repo`
   into `cloud/trigger-github.sql` and run that in the SQL editor too.
3. Repo secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN`
   (from `claude setup-token` on any machine where Claude Code is logged in) or `ANTHROPIC_API_KEY`.
4. Repo Settings → Pages → Source: GitHub Actions. Push, and the site is at `https://<owner>.github.io/planbrief/`.

Add the site to your phone's home screen: https://protrader1988.github.io/planbrief/ . Upload a PDF, close the page, come back to the link when it is done.
