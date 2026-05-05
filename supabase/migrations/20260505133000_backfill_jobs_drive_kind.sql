-- supabase/migrations/20260505133000_backfill_jobs_drive_kind.sql

-- Extend backfill_jobs.kind to allow 'drive' alongside 'mail' and
-- 'calendar'. The Drive backfill (Google only) reads file metadata —
-- name, owners, modifiedTime, lastModifyingUser — and feeds it through
-- the same Claude pipeline as the mail/calendar backfills, surfacing
-- collaboration patterns and project ownership signals.

alter table public.backfill_jobs
  drop constraint if exists backfill_jobs_kind_check;

alter table public.backfill_jobs
  add constraint backfill_jobs_kind_check
  check (kind in ('mail', 'calendar', 'drive'));
