-- Ordering guard for the RevenueCat webhook.
--
-- RevenueCat retries and can deliver events out of order. Without a record of
-- the last applied event's timestamp, a re-delivered older EXPIRATION arriving
-- after a newer RENEWAL would overwrite an active paying user down to 'free'
-- (last-write-wins). The webhook now compares the incoming event_timestamp_ms
-- against this column and skips stale events.
--
-- Nullable + no backfill: existing rows get NULL, which the guard treats as
-- "nothing stored yet" (apply), preserving current behaviour until the next
-- event stamps a value.

alter table public.user_entitlements
  add column if not exists last_event_at timestamptz;
