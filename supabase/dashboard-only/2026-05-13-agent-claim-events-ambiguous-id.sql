-- 2026-05-13 — Fix ambiguous "id" reference in agent_claim_events.
--
-- The RETURNS TABLE(id bigint, ...) declares OUT params that shadow the
-- final-SELECT column refs against the `claimed` CTE. Postgres throws
-- 42702 every invocation, so the agent has never processed events in
-- prod. Qualifying the column refs (claimed.id, claimed.kind, ...)
-- resolves the ambiguity.

create or replace function public.agent_claim_events(p_user_id uuid, p_limit integer)
 returns table(id bigint, kind text, payload jsonb)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_batch uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  return query
  with claimed as (
    update public.agent_events e
    set batch_id = v_batch
    where e.id in (
      select e2.id
      from public.agent_events e2
      where e2.user_id = p_user_id
        and e2.processed_at is null
        and e2.batch_id is null
      order by e2.id
      limit p_limit
      for update skip locked
    )
    returning e.id, e.kind, e.payload
  )
  select claimed.id, claimed.kind, claimed.payload from claimed;
end;
$function$;
