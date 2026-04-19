-- Phase 3 completion: server-side provider refresh tokens.
-- Client upserts refresh tokens here after Supabase's OAuth exchange so the
-- poll-mail edge function can mint fresh access tokens for Gmail/Graph.
--
-- Storing refresh tokens implies sensitive data at rest. Supabase Postgres
-- has encryption at rest for the disk, and RLS restricts access to the
-- owning user (edge function bypasses via service role). If you want
-- column-level encryption, pgsodium can be added later; out of scope here.

create table if not exists public.user_oauth_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  refresh_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_oauth_tokens enable row level security;

drop policy if exists "user_oauth_tokens: owner can read" on public.user_oauth_tokens;
create policy "user_oauth_tokens: owner can read"
  on public.user_oauth_tokens for select
  using (auth.uid() = user_id);

drop policy if exists "user_oauth_tokens: owner can insert" on public.user_oauth_tokens;
create policy "user_oauth_tokens: owner can insert"
  on public.user_oauth_tokens for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_oauth_tokens: owner can update" on public.user_oauth_tokens;
create policy "user_oauth_tokens: owner can update"
  on public.user_oauth_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_oauth_tokens: owner can delete" on public.user_oauth_tokens;
create policy "user_oauth_tokens: owner can delete"
  on public.user_oauth_tokens for delete
  using (auth.uid() = user_id);
