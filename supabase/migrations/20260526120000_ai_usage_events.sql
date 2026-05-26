-- Per-call AI usage events for surface attribution (which feature burned tokens).
-- record_claude_tokens() already aggregates per-user totals for rate limiting;
-- this table answers "where did the $ go" by tagging each Claude call with
-- the calling surface (e.g. 'daily-brief', 'chat-run', 'agent-tick').

create table if not exists public.ai_usage_events (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  surface       text not null,
  model         text not null,
  input_tokens  int  not null default 0,
  output_tokens int  not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists ai_usage_events_time_surface_idx
  on public.ai_usage_events (created_at desc, surface);

create index if not exists ai_usage_events_user_time_idx
  on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_usage_events enable row level security;

-- Append-only from edge functions (service role). Users may read only their own.
create policy "ai_usage_events_owner_select"
  on public.ai_usage_events for select
  using (auth.uid() = user_id);

-- Inserts happen exclusively via record_ai_usage RPC.
create or replace function public.record_ai_usage(
  p_user_id uuid,
  p_surface text,
  p_model text,
  p_input_tokens int,
  p_output_tokens int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_surface is null or p_model is null then
    return;
  end if;
  insert into public.ai_usage_events(user_id, surface, model, input_tokens, output_tokens)
  values (p_user_id, p_surface, p_model, greatest(0, coalesce(p_input_tokens, 0)), greatest(0, coalesce(p_output_tokens, 0)));
end;
$$;

revoke all on function public.record_ai_usage(uuid, text, text, int, int) from public;
grant execute on function public.record_ai_usage(uuid, text, text, int, int) to authenticated, service_role;

-- Convenience view for "spend by surface, last N days".
create or replace view public.v_ai_usage_by_surface as
select
  date_trunc('day', created_at)::date as day,
  surface,
  model,
  count(*) as calls,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens
from public.ai_usage_events
group by 1, 2, 3
order by 1 desc, 5 desc;
