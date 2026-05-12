-- supabase/migrations/20260512180000_agent_phase2.sql
--
-- Phase 2 (mail triage) additions to the autonomous-agent foundations:
--   1. agent_revert_action RPC — atomic undo guard so two taps can't
--      double-revert the same row.
--   2. v_users_with_pending_agent_events view — drives the cron-driven
--      agent-tick batch; filters out users who have flipped agent_enabled
--      off so we never spin a Claude turn for an opted-out user. This
--      addresses Phase 1 carry-over #1.
--
-- Phase 2 does NOT add any new tables: agent_actions / agent_runs /
-- agent_events from migration 20260511180000 are the only writes.

-- Atomic undo: claim the row by stamping reversed_at and return whether
-- this caller was the one to claim it. Returns one row with claimed=true
-- when the update succeeds. Returns ZERO ROWS (not claimed=false) when
-- the action is already reversed, non-reversible, or owned by another user.
-- Callers must check `(data ?? [])[0]?.claimed`, not `row.claimed === false`.
create or replace function public.agent_revert_action(
  p_action_id uuid,
  p_user_id   uuid
) returns table (claimed boolean, action_type text, reverse_token jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.agent_actions a
     set reversed_at = now()
   where a.id = p_action_id
     and a.user_id = p_user_id
     and a.reversible = true
     and a.reversed_at is null
  returning true, a.action_type, a.reverse_token;
end;
$$;

revoke all on function public.agent_revert_action(uuid, uuid) from public;
grant execute on function public.agent_revert_action(uuid, uuid) to service_role;

-- Eligible-users view: any user with at least one unprocessed event AND
-- agent_enabled = true. security_invoker so callers see only their own
-- row when reading via RLS; service-role bypasses RLS as before.
create or replace view public.v_users_with_pending_agent_events
  with (security_invoker = on)
  as
  select distinct e.user_id
  from public.agent_events e
  join public.user_profiles p on p.user_id = e.user_id
  where e.processed_at is null
    and p.agent_enabled = true;
