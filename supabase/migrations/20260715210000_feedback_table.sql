-- In-app feedback fra beta-testere (fejl/forslag) med automatisk metadata,
-- saa en rapport altid kan kobles til build, OS og enhed. Insert-only for
-- authenticated (kun egne raekker); ingen select-policy = brugere kan aldrig
-- laese andres feedback. Laeses via dashboardet (service_role).
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('bug', 'idea')),
  message text not null check (char_length(message) between 1 and 4000),
  app_version text,
  build_number text,
  os text,
  os_version text,
  device_model text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

create policy feedback_insert_own on public.feedback
  for insert to authenticated
  with check (auth.uid() = user_id);
