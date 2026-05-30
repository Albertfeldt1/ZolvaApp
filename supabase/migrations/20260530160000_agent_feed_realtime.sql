-- supabase/migrations/20260530160000_agent_feed_realtime.sql
--
-- Make the agent "Today" feed actually live.
--
-- The client subscribes to postgres_changes on these three tables
-- (useProposedActions / useAgentActions / useTrustOffers), but they were never
-- added to the supabase_realtime publication. With the publication empty, no
-- change events ever reached the client: the feed only populated from the
-- initial mount fetch, so "Spring over" (dismiss -> status='dismissed') and
-- "Fortryd" (undo -> reversed_at) wrote to the DB but the card never updated,
-- making both buttons look dead.
--
-- REPLICA IDENTITY FULL is required because RLS is enabled on all three tables
-- (auth.uid() = user_id). Realtime evaluates that policy against the OLD row on
-- UPDATE/DELETE; under the default replica identity the old tuple carries only
-- the primary key, so user_id is NULL there and the owner's own UPDATE events
-- get filtered out before delivery. FULL puts user_id in the old image so the
-- policy passes.

alter table public.proposed_actions replica identity full;
alter table public.agent_actions    replica identity full;
alter table public.trust_offers     replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proposed_actions'
  ) then
    alter publication supabase_realtime add table public.proposed_actions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_actions'
  ) then
    alter publication supabase_realtime add table public.agent_actions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trust_offers'
  ) then
    alter publication supabase_realtime add table public.trust_offers;
  end if;
end $$;
