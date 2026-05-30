-- Add a compact per-turn trace to agent_runs for observability.
--
-- The runner previously persisted only token counts + status, so a run that
-- took no action was a black box. `trace` stores, per Claude turn, the
-- stop_reason, the assistant's text, and which tools it called — enough to
-- diagnose WHY a run did (or didn't) act without storing the full transcript.

alter table public.agent_runs
  add column if not exists trace jsonb;
