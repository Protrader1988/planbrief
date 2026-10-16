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

-- v2: printable guide and output choice ('video' = guide + video, 'guide' = guide only)
alter table public.jobs add column if not exists outputs text not null default 'video';
alter table public.jobs add column if not exists guide_url text;

-- v3: first-pass quantity takeoff
alter table public.jobs add column if not exists takeoff jsonb;
alter table public.jobs add column if not exists takeoff_url text;

-- v4: drawing scales, sharper sheet images, and measurements people take on the sheets
alter table public.jobs add column if not exists measure jsonb;
alter table public.jobs add column if not exists sheet_urls jsonb;

create table if not exists public.measurements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sheet int not null,
  kind text not null,               -- length | area | count
  name text not null default '',
  assembly text,                    -- assembly key for the buy list
  points jsonb not null,            -- [[x,y],...] in sheet-image pixel coordinates
  value numeric not null,           -- LF, SF or EA
  unit text not null,
  height_ft numeric,                -- for walls
  deleted boolean not null default false
);
alter table public.measurements enable row level security;
drop policy if exists "public measurements insert" on public.measurements;
create policy "public measurements insert" on public.measurements for insert to anon with check (true);
drop policy if exists "public measurements select" on public.measurements;
create policy "public measurements select" on public.measurements for select to anon using (true);
drop policy if exists "public measurements update" on public.measurements;
create policy "public measurements update" on public.measurements for update to anon using (true) with check (true);

-- v5: trade packages
alter table public.jobs add column if not exists trades jsonb;
alter table public.jobs add column if not exists trades_url text;
