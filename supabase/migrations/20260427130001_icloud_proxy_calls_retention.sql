-- 60-day retention enforcement for icloud_proxy_calls.
--
-- Without this, the table grows unbounded — the rate-limit code only
-- deletes rows inside its own sliding window, so the actual retention
-- has been "whatever happens to be left," which is a side effect, not a
-- policy. /enterprise commits to "opbevares 60 dage." This migration
-- creates the cleanup function; the daily cron schedule lives in
-- schedule-icloud-proxy-retention.sql.template (kept out of git so the
-- service-role bearer isn't committed).
--
-- Why a function rather than inline DELETE in pg_cron: keeping the
-- predicate in one place lets us tune retention without re-scheduling.

create or replace function public.purge_old_icloud_proxy_calls()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.icloud_proxy_calls
  where called_at < now() - interval '60 days';
$$;

revoke all on function public.purge_old_icloud_proxy_calls() from public;
grant execute on function public.purge_old_icloud_proxy_calls() to service_role;
