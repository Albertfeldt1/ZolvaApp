-- supabase/migrations/20260511180000_agent_foundations.sql

-- Autonomous-agent foundations: tables that back the background agent
-- loop introduced in spec 2026-05-11. Phase 1 lands the schema + RLS
-- only; no producers/consumers run real workloads yet (Phase 2+).

-- Global kill-switch column on user_profiles. Default on so the rollout
-- is wide-open; users can flip from Settings.
alter table public.user_profiles
  add column if not exists agent_enabled boolean not null default true;

-- 1. Event queue feeding the agent.
create table if not exists public.agent_events (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  batch_id     uuid
);
create index if not exists agent_events_pending_idx
  on public.agent_events (user_id, processed_at)
  where processed_at is null;

-- 2. One row per runner invocation.
create table if not exists public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  trigger       text not null,
  event_ids     bigint[] not null default '{}',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null check (status in ('running','ok','error','budget_exceeded')),
  input_tokens  int,
  output_tokens int,
  error         text
);
create index if not exists agent_runs_user_started_idx
  on public.agent_runs (user_id, started_at desc);

-- 3. Per-user × per-action-type trust policy.
create table if not exists public.user_agent_policy (
  user_id     uuid not null references auth.users(id) on delete cascade,
  action_type text not null,
  mode        text not null check (mode in ('auto','propose','off')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, action_type)
);

-- 4. Things the agent wants to do but is waiting on the user.
create table if not exists public.proposed_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  run_id      uuid references public.agent_runs(id),
  action_type text not null,
  payload     jsonb not null,
  preview     jsonb not null,
  status      text not null check (status in ('pending','approved','dismissed','expired','executed','failed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  executed_at timestamptz,
  expires_at  timestamptz,
  context_ref jsonb
);
create index if not exists proposed_actions_user_status_idx
  on public.proposed_actions (user_id, status, created_at desc);

-- 5. Activity log: every executed action (auto or approved), with Undo.
create table if not exists public.agent_actions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  run_id        uuid references public.agent_runs(id),
  proposal_id   uuid references public.proposed_actions(id),
  action_type   text not null,
  payload       jsonb not null,
  executed_at   timestamptz not null default now(),
  reversible    boolean not null default false,
  reverse_token jsonb,
  reversed_at   timestamptz
);
create index if not exists agent_actions_user_exec_idx
  on public.agent_actions (user_id, executed_at desc);
create unique index if not exists agent_actions_idem
  on public.agent_actions (user_id, action_type, (payload->>'idem_key'))
  where payload->>'idem_key' is not null;

-- 6. Daily token budget per user.
create table if not exists public.user_agent_budget (
  user_id       uuid not null references auth.users(id) on delete cascade,
  day           date not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  primary key (user_id, day)
);

-- 7. App presence — drives the `user.idle` signal.
create table if not exists public.user_presence (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  last_active_at   timestamptz,
  last_app_open_at timestamptz,
  push_token       text,
  updated_at       timestamptz not null default now()
);

-- RLS: writes are service-role-only EXCEPT for user_agent_policy and
-- user_presence (users manage these directly from the Settings UI). All
-- other tables grant authenticated users select-only access to their
-- own rows; service role bypasses RLS for the runner / cron paths.

alter table public.agent_events       enable row level security;
alter table public.agent_runs         enable row level security;
alter table public.user_agent_policy  enable row level security;
alter table public.proposed_actions   enable row level security;
alter table public.agent_actions      enable row level security;
alter table public.user_agent_budget  enable row level security;
alter table public.user_presence      enable row level security;

create policy "owner-select-agent-events" on public.agent_events
  for select to authenticated
  using (auth.uid() = user_id);
create policy "owner-select-agent-runs" on public.agent_runs
  for select to authenticated
  using (auth.uid() = user_id);
create policy "owner-rw-user-agent-policy" on public.user_agent_policy
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner-select-proposed-actions" on public.proposed_actions
  for select to authenticated
  using (auth.uid() = user_id);
create policy "owner-update-proposed-actions" on public.proposed_actions
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner-select-agent-actions" on public.agent_actions
  for select to authenticated
  using (auth.uid() = user_id);
create policy "owner-select-user-agent-budget" on public.user_agent_budget
  for select to authenticated
  using (auth.uid() = user_id);
create policy "owner-rw-user-presence" on public.user_presence
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Observability views (security_invoker so they inherit caller RLS).
create or replace view public.v_agent_recent_runs
  with (security_invoker = on)
  as
  select id, user_id, trigger, status, started_at, finished_at,
         input_tokens, output_tokens, error
  from public.agent_runs
  order by started_at desc
  limit 100;

create or replace view public.v_agent_pending_proposals_age
  with (security_invoker = on)
  as
  select user_id,
         min(created_at) as oldest_pending_at,
         count(*)         as pending_count
  from public.proposed_actions
  where status = 'pending'
  group by user_id;
