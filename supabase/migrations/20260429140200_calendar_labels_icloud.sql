-- supabase/migrations/20260429140200_calendar_labels_icloud.sql
--
-- Allow 'icloud' as a calendar-label provider on user_profiles.
--
-- For iCloud, work_calendar_id / personal_calendar_id stores the full
-- CalDAV calendar URL (e.g. https://p123-caldav.icloud.com/12345/calendars/work/).
-- The voice path PUTs against that URL directly. The user's principal +
-- calendar-home URLs live in user_icloud_calendar_creds.encrypted_blob,
-- written by icloud-creds-link during iCloud connect.
--
-- This migration drops + recreates the existing CHECK constraints rather
-- than ALTERing them in place, because Postgres has no `ALTER CONSTRAINT
-- CHECK` syntax.

ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_work_calendar_provider_check,
  DROP CONSTRAINT IF EXISTS user_profiles_personal_calendar_provider_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_work_calendar_provider_check
    CHECK (work_calendar_provider IN ('google', 'microsoft', 'icloud')),
  ADD CONSTRAINT user_profiles_personal_calendar_provider_check
    CHECK (personal_calendar_provider IN ('google', 'microsoft', 'icloud'));

COMMENT ON COLUMN public.user_profiles.work_calendar_id IS
  'For google/microsoft, the provider calendar id. For icloud, the full CalDAV calendar URL the voice path PUTs against.';
COMMENT ON COLUMN public.user_profiles.personal_calendar_id IS
  'For google/microsoft, the provider calendar id. For icloud, the full CalDAV calendar URL the voice path PUTs against.';
