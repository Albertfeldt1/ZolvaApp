-- Security hardening: stop the authenticated client from reading the stored
-- provider refresh_token.
--
-- The RLS owner-SELECT policy on user_oauth_tokens lets a user's JWT read its
-- own row INCLUDING refresh_token (a long-lived, high-value credential). The
-- client never needs the token value — it only (a) counts row presence
-- (select user_id filtered by user_id+provider) and (b) upserts the token
-- (INSERT/UPDATE, which do not require SELECT). Provider token refresh happens
-- server-side via service_role (which bypasses these grants). So we revoke
-- table-wide SELECT from `authenticated` and grant SELECT only on the
-- non-secret columns. Under a stolen JWT the attacker then gets only a
-- short-lived session, not a durable refresh token.
--
-- RLS still applies on top of these column grants (privileges AND RLS are
-- both enforced). service_role is unaffected.
--
-- Rollback (if provider connect/reconnect breaks on a device):
--   grant select on public.user_oauth_tokens to authenticated;

revoke select on public.user_oauth_tokens from authenticated;
grant select (user_id, provider, created_at, updated_at)
  on public.user_oauth_tokens to authenticated;
