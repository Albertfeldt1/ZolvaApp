-- Advisory lock helpers for poll-mail edge function.
-- Overlapping cron invocations call try_mail_watcher_lock first; the loser
-- skips the watcher so we never double-process.

create or replace function public.try_mail_watcher_lock(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_try_advisory_lock(hashtext(p_user_id::text));
$$;

create or replace function public.release_mail_watcher_lock(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_advisory_unlock(hashtext(p_user_id::text));
$$;

revoke all on function public.try_mail_watcher_lock(uuid) from public;
revoke all on function public.release_mail_watcher_lock(uuid) from public;
grant execute on function public.try_mail_watcher_lock(uuid) to service_role;
grant execute on function public.release_mail_watcher_lock(uuid) to service_role;
