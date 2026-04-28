alter table public.user_profiles
  add column if not exists work_calendar_provider text
    check (work_calendar_provider in ('google', 'microsoft')),
  add column if not exists work_calendar_id text,
  add column if not exists personal_calendar_provider text
    check (personal_calendar_provider in ('google', 'microsoft')),
  add column if not exists personal_calendar_id text;

alter table public.user_profiles
  add constraint work_calendar_consistency
    check ((work_calendar_provider is null) = (work_calendar_id is null)),
  add constraint personal_calendar_consistency
    check ((personal_calendar_provider is null) = (personal_calendar_id is null));

alter table public.user_profiles
  add column if not exists previous_calendar_labels jsonb default null;

comment on column public.user_profiles.previous_calendar_labels is
  'Transient snapshot written by disconnect handler; read once by reconnect
   handler for the restore-prompt flow, then cleared. Unwritten in v2 (reserved
   for v2.x restore-prompt). Not read by Edge Functions.';
