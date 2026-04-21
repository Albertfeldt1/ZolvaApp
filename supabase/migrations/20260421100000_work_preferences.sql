-- Work preferences live server-side so the daily-brief edge function
-- (and any future server-side scheduler) can read the user's chosen
-- morning-brief / evening-brief times. Client continues to cache them
-- in AsyncStorage for instant hydration; Supabase is authoritative.

create table if not exists public.work_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.work_preferences enable row level security;

create policy "work_preferences owner access" on public.work_preferences
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
