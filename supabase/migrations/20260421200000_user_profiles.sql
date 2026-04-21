-- Minimal per-user profile row. For now this only carries the IANA
-- timezone so the daily-brief edge function can fire at the user's
-- actual local morning/evening instead of 08:00 UTC.

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

create policy "user_profiles owner access" on public.user_profiles
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
