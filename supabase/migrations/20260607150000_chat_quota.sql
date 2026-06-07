-- Per-user weekly chat message cap for tier gating (free/lite). Pro is
-- unlimited and never calls this. Reuses claude_usage_buckets with a new
-- 'chat_week' kind so we get the same atomic upsert + PK hot path for free.
--
-- This counts USER MESSAGES (one increment per chat-run round-0), not Claude
-- API calls — a single message can fan out into many claude-proxy tool rounds,
-- which must NOT each consume quota.

alter table claude_usage_buckets
  drop constraint if exists claude_usage_buckets_kind_check;
alter table claude_usage_buckets
  add constraint claude_usage_buckets_kind_check
  check (kind in ('minute', 'day', 'chat_week'));

-- Atomically increment the user's current-week bucket and return whether they
-- are still under p_limit. Week starts Monday 00:00 UTC (date_trunc 'week').
create or replace function check_and_incr_chat_quota(
  p_user_id uuid,
  p_limit int
) returns table (allowed boolean, used int, limit_count int, resets_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_week_start timestamptz := date_trunc('week', v_now);
  v_count int;
begin
  -- Self-only when called with a user JWT; service role (null uid) bypasses.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'user_id mismatch';
  end if;

  insert into claude_usage_buckets (user_id, kind, bucket_start, requests)
  values (p_user_id, 'chat_week', v_week_start, 1)
  on conflict (user_id, kind, bucket_start)
  do update set requests = claude_usage_buckets.requests + 1, updated_at = v_now
  returning requests into v_count;

  return query select
    (v_count <= p_limit),
    v_count,
    p_limit,
    (v_week_start + interval '7 days');
end;
$$;

grant execute on function check_and_incr_chat_quota(uuid, int) to authenticated;
