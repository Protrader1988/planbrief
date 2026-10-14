-- PlanBrief cloud schema. Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  original_name text not null,
  upload_path text not null,
  status text not null default 'queued',
  progress int not null default 0,
  message text not null default 'Queued',
  page_count int,
  brief jsonb,
  verification jsonb,
  video_url text,
  duration_sec numeric,
  segment_starts jsonb,
  page_urls jsonb,
  error text
);

alter table public.jobs enable row level security;

-- Anyone with the site can create jobs and watch them (the site is open by design).
drop policy if exists "public insert" on public.jobs;
create policy "public insert" on public.jobs for insert to anon with check (true);
drop policy if exists "public read" on public.jobs;
create policy "public read" on public.jobs for select to anon using (true);

-- Storage: PDFs go to 'uploads' (anyone can upload), videos come back in 'videos' (public read).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('uploads', 'uploads', false, 209715200, array['application/pdf'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
insert into storage.buckets (id, name, public, file_size_limit)
  values ('videos', 'videos', true, 524288000)
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit;

drop policy if exists "anon upload pdf" on storage.objects;
create policy "anon upload pdf" on storage.objects for insert to anon with check (bucket_id = 'uploads');
drop policy if exists "public read videos" on storage.objects;
create policy "public read videos" on storage.objects for select to anon using (bucket_id = 'videos');

-- Realtime so the phone page updates live.
do $$ begin
  alter publication supabase_realtime add table public.jobs;
exception when duplicate_object then null; end $$;
