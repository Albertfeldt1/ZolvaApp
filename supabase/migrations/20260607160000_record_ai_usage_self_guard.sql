-- Security hardening: add the self-only guard to record_ai_usage.
--
-- record_ai_usage is SECURITY DEFINER and granted to `authenticated`, but
-- (unlike its siblings check_and_incr_claude_usage / record_claude_tokens /
-- check_and_incr_chat_quota) it had no auth.uid() check. An authenticated user
-- could call it with another user's id and write rows attributed to them,
-- polluting that user's usage telemetry. Service role (null auth.uid()) still
-- bypasses, so the agent/cron paths are unaffected.

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
  -- Self-only when called with a user JWT; service role (null uid) bypasses.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'user_id mismatch';
  end if;
  if p_user_id is null or p_surface is null or p_model is null then
    return;
  end if;
  insert into public.ai_usage_events(user_id, surface, model, input_tokens, output_tokens)
  values (p_user_id, p_surface, p_model, greatest(0, coalesce(p_input_tokens, 0)), greatest(0, coalesce(p_output_tokens, 0)));
end;
$$;

revoke all on function public.record_ai_usage(uuid, text, text, int, int) from public;
grant execute on function public.record_ai_usage(uuid, text, text, int, int) to authenticated, service_role;
