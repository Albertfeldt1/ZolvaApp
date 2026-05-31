-- One fact.due event per (user, fact, day) so a re-run within the day can't
-- double-emit. Mirrors agent_events_calendar_upcoming_dedup.
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_fact_due_dedup
  ON public.agent_events (user_id, (payload->>'fact_id'), (payload->>'day'))
  WHERE kind = 'fact.due';
