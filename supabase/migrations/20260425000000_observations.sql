-- Persist generated observations so users can browse past days.
-- Mirrors the briefs pattern: client writes after successful generation,
-- RLS scopes everything to the owning user.

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  generated_at timestamptz not null default now(),
  source_date date not null,
  text text not null,
  cta text not null default '',
  mood text not null check (mood in ('calm','thinking','happy')),
  action_kind text check (action_kind in ('openMail','prompt','chat')),
  action_payload jsonb,
  -- Dedup: a regeneration on the same source_date that produces the same
  -- text upserts to a single row.
  unique (user_id, source_date, text)
);

create index if not exists observations_user_generated_idx
  on public.observations (user_id, generated_at desc);

alter table public.observations enable row level security;

create policy "observations owner access" on public.observations
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
