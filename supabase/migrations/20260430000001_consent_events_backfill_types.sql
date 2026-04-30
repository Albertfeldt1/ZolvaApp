-- Extend consent_events.event_type to accept the four new event types written
-- by the onboarding-backfill edge functions. Per
-- docs/superpowers/specs/2026-04-29-onboarding-backfill-design.md (Telemetry),
-- the simpler observability path is one table for both admin-consent and
-- backfill telemetry rather than introducing a parallel backfill_events table.
--
-- Without this migration the worker's logBackfillEvent() insert fails with
-- consent_events_event_type_check (23514). Caught in code review of
-- 20260430000000_backfill_jobs.sql before any worker code shipped.

alter table public.consent_events
  drop constraint if exists consent_events_event_type_check;

alter table public.consent_events
  add constraint consent_events_event_type_check
  check (event_type in (
    'user_blocked',
    'admin_link_generated',
    'admin_callback_received',
    'admin_consent_granted',
    'admin_consent_failed',
    'state_invalid',
    'tenant_lookup',
    'tenant_lookup_failed',
    'backfill_started',
    'backfill_completed',
    'backfill_failed',
    'backfill_cancelled'
  ));
