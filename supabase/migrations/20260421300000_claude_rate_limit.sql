-- Per-user rate limiting for Claude API calls.
--
-- Every Claude request goes through the claude-proxy edge function, which
-- calls check_and_incr_claude_usage() before forwarding to Anthropic. The
-- function atomically upserts minute and day buckets, returns whether the
-- caller is under the limit, and if not, how long until the next retry.
--
-- Anti-abuse: the single shared ANTHROPIC_API_KEY is protected from runaway
-- individual users (hot loops, leaked session tokens) so no one can drain
-- the whole org's Anthropic quota.

create table if not exists claude_usage_buckets (
  user_id uuid not null,
  kind text not null check (kind in ('minute', 'day')),
  bucket_start timestamptz not null,
  requests int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, bucket_start)
);

-- Supports the nightly cleanup (optional, cron-driven) — not load-bearing for
-- the hot path, which hits the primary key.
create index if not exists claude_usage_buckets_bucket_start_idx
  on claude_usage_buckets (bucket_start);

alter table claude_usage_buckets enable row level security;
-- No policies: the table is only touched by SECURITY DEFINER functions below.

-- Atomically increment the minute + day buckets for a user and return whether
-- they are still under the provided limits. Called on every Claude request.
--
-- Design note: we increment FIRST, then check. This avoids a race between
-- SELECT and INSERT under bursty load — two concurrent requests can't both
-- see "59" and both succeed. The worst case is a one-request overshoot per
-- bucket when traffic pushes through the boundary, which is fine.
create or replace function check_and_incr_claude_usage(
  p_user_id uuid,
  p_rpm_limit int,
  p_daily_limit int
) returns table (allowed boolean, retry_after int, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_minute_start timestamptz := date_trunc('minute', v_now);
  v_day_start timestamptz := date_trunc('day', v_now);
  v_minute_count int;
  v_day_count int;
begin
  -- Only allow calling on behalf of self. Service role has null auth.uid()
  -- so background jobs (cron, admin tooling) bypass this check.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'user_id mismatch';
  end if;

  insert into claude_usage_buckets (user_id, kind, bucket_start, requests)
  values (p_user_id, 'minute', v_minute_start, 1)
  on conflict (user_id, kind, bucket_start)
  do update set requests = claude_usage_buckets.requests + 1, updated_at = v_now
  returning requests into v_minute_count;

  insert into claude_usage_buckets (user_id, kind, bucket_start, requests)
  values (p_user_id, 'day', v_day_start, 1)
  on conflict (user_id, kind, bucket_start)
  do update set requests = claude_usage_buckets.requests + 1, updated_at = v_now
  returning requests into v_day_count;

  if v_minute_count > p_rpm_limit then
    return query select
      false,
      greatest(1, 60 - extract(second from v_now)::int)::int,
      'rpm'::text;
    return;
  end if;

  if v_day_count > p_daily_limit then
    return query select
      false,
      greatest(60, extract(epoch from (v_day_start + interval '1 day' - v_now))::int)::int,
      'daily'::text;
    return;
  end if;

  return query select true, 0, 'ok'::text;
end;
$$;

grant execute on function check_and_incr_claude_usage(uuid, int, int) to authenticated;

-- Fire-and-forget from the proxy after Anthropic responds. Used only for
-- observability right now — token counts aren't enforced as a limit.
create or replace function record_claude_tokens(
  p_user_id uuid,
  p_input_tokens int,
  p_output_tokens int
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_minute_start timestamptz := date_trunc('minute', v_now);
  v_day_start timestamptz := date_trunc('day', v_now);
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'user_id mismatch';
  end if;

  update claude_usage_buckets
  set
    input_tokens = input_tokens + greatest(0, p_input_tokens),
    output_tokens = output_tokens + greatest(0, p_output_tokens),
    updated_at = v_now
  where user_id = p_user_id
    and (
      (kind = 'minute' and bucket_start = v_minute_start)
      or (kind = 'day' and bucket_start = v_day_start)
    );
end;
$$;

grant execute on function record_claude_tokens(uuid, int, int) to authenticated;
