-- supabase/migrations/20260531140000_agent_commitments_realtime.sql
--
-- Make the in-app "Open loops" list (useOpenCommitments) actually live.
--
-- The client subscribes to postgres_changes on agent_commitments, but the table
-- was never added to the supabase_realtime publication. With it absent, no
-- change events reach the client: the list only populates from the initial
-- mount fetch, so a loop the agent-commitments sweep resolves/expires server-side
-- (Slice 3 reconcile) stays on screen until the view re-mounts.
--
-- REPLICA IDENTITY FULL is required because RLS is enabled on the table
-- (auth.uid() = user_id). Realtime evaluates that policy against the OLD row on
-- UPDATE/DELETE; under the default replica identity the old tuple carries only
-- the primary key, so user_id is NULL there and the owner's own UPDATE events
-- (status open -> resolved) get filtered out before delivery. FULL puts user_id
-- in the old image so the policy passes. Mirrors 20260530160000_agent_feed_realtime.

alter table public.agent_commitments replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_commitments'
  ) then
    alter publication supabase_realtime add table public.agent_commitments;
  end if;
end $$;
