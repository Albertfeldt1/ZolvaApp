-- supabase/migrations/20260503153704_user_calendar_preferences.sql
--
-- Per-calendar include/exclude preferences for the daily-brief aggregator.
--
-- Default behavior when no row exists for a (user_id, provider, calendar_id)
-- triple = INCLUDE. Rows are only written when the user explicitly toggles a
-- calendar OFF in the Settings picker. This keeps the table small (most
-- users won't write any rows) and avoids needing to backfill existing users.
--
-- Provider-native hide signals are honored by the aggregator at read time,
-- on top of these preferences:
--   - Google: skip calendars where calendarList.selected === false
--   - Microsoft: skip calendars where /me/calendars[].isHidden === true
-- Those skips happen even when no preferences row exists — they are the
-- "smart default" before the user opens the picker.
--
-- iCloud is intentionally excluded from the CHECK constraint in v1.
-- Server-side iCloud CalDAV read does not exist yet (see daily-brief
-- _shared/calendar.ts and the followup tracked in project memory). When
-- that lands, ALTER the CHECK to add 'icloud' the same way
-- 20260429140200_calendar_labels_icloud.sql did for the labels table.

CREATE TABLE IF NOT EXISTS public.user_calendar_preferences (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  calendar_id  text NOT NULL,
  included     boolean NOT NULL DEFAULT true,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, calendar_id),
  -- v1: google + microsoft only. iCloud will be added by a follow-up
  -- migration that drops + re-adds this constraint with 'icloud'
  -- included. Pattern: see calendar_labels_icloud migration.
  CONSTRAINT user_calendar_preferences_provider_check
    CHECK (provider IN ('google', 'microsoft'))
);

ALTER TABLE public.user_calendar_preferences ENABLE ROW LEVEL SECURITY;

-- Owner-only access. Mirrors the work_preferences policy
-- (20260421100000_work_preferences.sql) — users see and modify only their
-- own rows; service-role bypasses RLS for the daily-brief edge function.
CREATE POLICY "user_calendar_preferences owner access"
  ON public.user_calendar_preferences
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- updated_at trigger so the picker UI can show "last changed" if we ever
-- need to debug a stale preference. Pattern matches
-- set_user_icloud_calendar_creds_updated_at.
CREATE OR REPLACE FUNCTION public.set_user_calendar_preferences_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_user_calendar_preferences_updated_at
  BEFORE UPDATE ON public.user_calendar_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_calendar_preferences_updated_at();

COMMENT ON TABLE public.user_calendar_preferences IS
  'Per-calendar include/exclude preferences for the daily-brief aggregator. Absent row = include. iCloud excluded from CHECK in v1; add when server-side iCloud CalDAV read lands.';
