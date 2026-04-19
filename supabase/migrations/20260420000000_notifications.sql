-- Phase 3: push tokens + mail watcher state.
-- Tables are row-level-secured so each user can only see their own rows;
-- the poll-mail edge function runs with the service role key and bypasses RLS.

create extension if not exists pgcrypto;

-- One row per (user, device-token). Same device re-registering the same
-- token is an upsert via the composite unique constraint.
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null,
  platform text,
  device_id text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint push_tokens_user_token_unique unique (user_id, token)
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens: owner can read" on public.push_tokens;
create policy "push_tokens: owner can read"
  on public.push_tokens for select
  using (auth.uid() = user_id);

drop policy if exists "push_tokens: owner can insert" on public.push_tokens;
create policy "push_tokens: owner can insert"
  on public.push_tokens for insert
  with check (auth.uid() = user_id);

drop policy if exists "push_tokens: owner can update" on public.push_tokens;
create policy "push_tokens: owner can update"
  on public.push_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "push_tokens: owner can delete" on public.push_tokens;
create policy "push_tokens: owner can delete"
  on public.push_tokens for delete
  using (auth.uid() = user_id);


-- One row per (user, provider). Stores the watermark the poll-mail function
-- advances each cycle. `enabled` mirrors the user's newMail toggle.
create table if not exists public.mail_watchers (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  enabled boolean not null default true,
  last_history_id text,
  last_delta_link text,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.mail_watchers enable row level security;

drop policy if exists "mail_watchers: owner can read" on public.mail_watchers;
create policy "mail_watchers: owner can read"
  on public.mail_watchers for select
  using (auth.uid() = user_id);

drop policy if exists "mail_watchers: owner can insert" on public.mail_watchers;
create policy "mail_watchers: owner can insert"
  on public.mail_watchers for insert
  with check (auth.uid() = user_id);

drop policy if exists "mail_watchers: owner can update" on public.mail_watchers;
create policy "mail_watchers: owner can update"
  on public.mail_watchers for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "mail_watchers: owner can delete" on public.mail_watchers;
create policy "mail_watchers: owner can delete"
  on public.mail_watchers for delete
  using (auth.uid() = user_id);
