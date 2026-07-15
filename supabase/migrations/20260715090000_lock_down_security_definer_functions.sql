-- Supabase-advisoren (2026-07-15) viste at disse SECURITY DEFINER-funktioner
-- kunne kaldes af anon/authenticated via /rest/v1/rpc/. De er alle rene
-- server-funktioner (edge functions kalder dem med service_role): flere tager
-- p_user_id som parameter og stoler på det, og purge_tenant_data sletter en
-- hel tenants data. Postgres granter EXECUTE til PUBLIC som default ved
-- CREATE FUNCTION - derfor lukkes de eksplicit her.
--
-- persist_oauth_token er bevidst IKKE med: klienten kalder den via RPC, den
-- validerer auth.uid() internt og har allerede revoke-from-public + grant til
-- authenticated (20260612120000).

do $$
declare
  fn text;
  fns text[] := array[
    'public.agent_budget_increment(uuid, date, integer, integer)',
    'public.agent_claim_events(uuid, integer)',
    'public.agent_revert_action(uuid, uuid)',
    'public.check_and_incr_chat_quota(uuid, integer)',
    'public.check_and_incr_claude_usage(uuid, integer, integer)',
    'public.check_rate_limit(uuid, text, integer, integer)',
    'public.handle_new_user()',
    'public.purge_old_icloud_proxy_calls()',
    'public.purge_tenant_data(text, text)',
    'public.record_ai_usage(uuid, text, text, integer, integer)',
    'public.record_claude_tokens(uuid, integer, integer)',
    'public.release_mail_watcher_lock(uuid)',
    'public.try_mail_watcher_lock(uuid)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- handle_new_user er auth.users-triggeren; triggere kører som funktions-ejer,
-- saa revoke paavirker ikke signup-flowet.
