-- Fix: client-side Google token persistence broke on 2026-06-07.
--
-- 20260607161000_oauth_token_column_lockdown.sql revoked table-wide SELECT on
-- user_oauth_tokens from `authenticated` and re-granted SELECT on the
-- non-secret columns only. Its comment assumed "upserts (INSERT/UPDATE) do not
-- require SELECT" -- but the client persists via INSERT ... ON CONFLICT DO
-- UPDATE (supabase-js .upsert), and Postgres requires TABLE-level SELECT for
-- ON CONFLICT. Column-level grants don't satisfy it, so every client upsert has
-- failed with 42501 since the lockdown (swallowed: logged only in __DEV__).
-- Net effect: no Google refresh_token persisted -> silent-refresh has nothing
-- to mint -> the connection drifts to "stale"/UDLØBET. (Microsoft is unaffected
-- because it persists server-side via the PKCE edge function / service_role.)
--
-- Fix without undoing the lockdown: a SECURITY DEFINER RPC that runs as owner
-- (full table privileges, so ON CONFLICT works) and derives the user from
-- auth.uid() (a caller can only write its OWN row -- stronger than the old
-- client-passed user_id). refresh_token stays unreadable by `authenticated`.

create or replace function public.persist_oauth_token(
  p_provider text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'persist_oauth_token: not authenticated';
  end if;
  if p_provider not in ('google', 'microsoft') then
    raise exception 'persist_oauth_token: invalid provider %', p_provider;
  end if;
  if p_refresh_token is null or length(p_refresh_token) = 0 then
    raise exception 'persist_oauth_token: empty refresh token';
  end if;

  insert into public.user_oauth_tokens (user_id, provider, refresh_token, updated_at)
  values (v_uid, p_provider, p_refresh_token, now())
  on conflict (user_id, provider)
  do update set refresh_token = excluded.refresh_token,
                updated_at    = excluded.updated_at;
end;
$$;

-- Only signed-in users may call it; never anon/public.
revoke all on function public.persist_oauth_token(text, text) from public;
revoke all on function public.persist_oauth_token(text, text) from anon;
grant execute on function public.persist_oauth_token(text, text) to authenticated;
