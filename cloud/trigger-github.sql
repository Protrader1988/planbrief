-- Kicks off the GitHub Actions render for every new job, straight from the database.
-- Run in the Supabase SQL editor AFTER replacing the two placeholders.
--   GITHUB_PAT: a fine-grained token with "Actions: write" on the planbrief repo.
--   REPO: owner/name, e.g. Protrader1988/planbrief

create extension if not exists pg_net;

create or replace function public.dispatch_render()
returns trigger
language plpgsql
security definer
as $$
declare
  pat text := '__GITHUB_PAT__';
  repo text := '__REPO__';
begin
  perform net.http_post(
    url := 'https://api.github.com/repos/' || repo || '/actions/workflows/render.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'planbrief-supabase',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('job_id', new.id::text))
  );
  return new;
end;
$$;

drop trigger if exists jobs_dispatch_render on public.jobs;
create trigger jobs_dispatch_render
  after insert on public.jobs
  for each row execute function public.dispatch_render();
