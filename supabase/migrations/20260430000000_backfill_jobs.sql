-- supabase/migrations/20260430000000_backfill_jobs.sql

-- backfill_jobs: one row per (user × kind × provider). Tracks the one-time
-- onboarding backfill run after a user toggles memory-enabled. Service-role
-- writes only; users can read their own rows.

create table if not exists public.backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mail', 'calendar')),
  provider text not null check (provider in ('google', 'microsoft', 'icloud')),
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','cancelled')),
  processed int not null default 0,
  total int,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists backfill_jobs_user_kind_provider_idx
  on public.backfill_jobs (user_id, kind, provider);

alter table public.backfill_jobs enable row level security;

drop policy if exists "users read own backfill jobs" on public.backfill_jobs;
create policy "users read own backfill jobs"
  on public.backfill_jobs for select
  using (auth.uid() = user_id);

create or replace function public.backfill_jobs_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists backfill_jobs_updated_at on public.backfill_jobs;
create trigger backfill_jobs_updated_at
  before update on public.backfill_jobs
  for each row execute function public.backfill_jobs_set_updated_at();

-- consent_events.event_type has a hard-coded CHECK constraint (added in
-- 20260427130000_admin_consent_microsoft.sql). The four new event types
-- (backfill_started / backfill_completed / backfill_failed / backfill_cancelled)
-- are added by the next migration: 20260430000001_consent_events_backfill_types.sql.

-- NOTE on facts.status: as of 2026-04-30 the live constraint is
--   CHECK (status IN ('pending','confirmed','rejected'))
-- so 'pending' is already accepted. The plan called for extending the check
-- only if 'pending' was missing — it isn't, so no change here.
