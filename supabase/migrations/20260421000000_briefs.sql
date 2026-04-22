-- Daily-brief feature — schema + RLS + cron extensions.
-- The actual cron.schedule() call lives in schedule-daily-brief.sql.template
-- so its service-role bearer token isn't committed to the repo.

create table if not exists public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('morning','evening')),
  headline text not null,
  body jsonb not null,
  weather jsonb,
  tone text check (tone in ('calm','busy','heads-up')),
  generated_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz
);

-- Index uses an explicit UTC cast because plain `generated_at::date` is
-- STABLE (depends on session timezone) — Postgres rejects it in an index
-- expression. `AT TIME ZONE 'UTC'` is IMMUTABLE.
create unique index if not exists briefs_user_kind_day_idx
  on public.briefs (user_id, kind, ((generated_at at time zone 'UTC')::date));

create index if not exists briefs_user_generated_idx
  on public.briefs (user_id, generated_at desc);

alter table public.briefs enable row level security;

create policy "briefs owner access" on public.briefs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create extension if not exists pg_cron;
create extension if not exists pg_net;
