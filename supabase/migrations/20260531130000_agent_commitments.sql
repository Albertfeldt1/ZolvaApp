-- agent_commitments: durable "open loops" the agent tracks per user.
create table if not exists public.agent_commitments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  direction       text not null check (direction in ('you_owe','owed_to_you')),
  counterparty    text not null default '',
  summary         text not null,
  due_at          timestamptz,
  due_inferred    boolean not null default false,
  thread_id       text not null,
  provider        text not null check (provider in ('google','microsoft')),
  source_excerpt  text not null default '',
  last_message_at timestamptz,
  status          text not null default 'open'
                    check (status in ('open','nudged','resolved','dismissed','expired')),
  created_at      timestamptz not null default now(),
  nudged_at       timestamptz,
  resolved_at     timestamptz,
  unique (user_id, thread_id, direction)
);

create index if not exists agent_commitments_due_idx
  on public.agent_commitments (user_id, status, due_at);

alter table public.agent_commitments enable row level security;

-- Owner can read their own commitments (in-app list, Slice 3). Writes are
-- service-role only (the edge fn), matching the other agent_* tables.
create policy "owner-select-agent-commitments" on public.agent_commitments
  for select to authenticated
  using (auth.uid() = user_id);

-- Per-user extraction watermark: extraction only re-runs when this is stale.
alter table public.user_profiles
  add column if not exists commitments_scanned_at timestamptz;
