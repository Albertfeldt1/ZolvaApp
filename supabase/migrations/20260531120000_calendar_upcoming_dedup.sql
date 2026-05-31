-- One un-acted calendar.upcoming event per (user, event_id, day). The reflect
-- sweep INSERTs ON CONFLICT DO NOTHING; this index makes the insert idempotent
-- across overlapping sweeps so an event is processed at most once per day.
create unique index if not exists agent_events_calendar_upcoming_dedup
  on public.agent_events (user_id, (payload->>'event_id'), (payload->>'day'))
  where kind = 'calendar.upcoming';
