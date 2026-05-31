-- supabase/migrations/20260531150000_facts_follow_up.sql
--
-- Memory follow-ups: a fact can carry a future moment to resurface for action
-- (follow_up_at), set client-side by the chat extractor from the date it already
-- extracts. followed_up_at is stamped once the agent-memory-followups sweep has
-- acted, so each fact fires exactly once. Mirrors 20260427100000_facts_expires_at.

ALTER TABLE public.facts
  ADD COLUMN IF NOT EXISTS follow_up_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followed_up_at TIMESTAMPTZ;

-- Partial index: the sweep selects confirmed facts whose follow_up_at has passed
-- and that have not yet been acted on. Only follow-up-bearing rows are indexed.
CREATE INDEX IF NOT EXISTS facts_follow_up_due_idx
  ON public.facts (user_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL AND followed_up_at IS NULL;
