-- Server-side mirror of the client `memory-enabled` privacy toggle.
--
-- Why: `getPrivacyFlag('memory-enabled')` lives in client AsyncStorage.
-- Cron-driven edge functions (daily-brief, fact-decay-warning) run with
-- the service role and can't read AsyncStorage, so a user who toggles
-- memory off keeps getting briefs that quote their facts and mail
-- subjects — directly contradicting the contract documented at
-- src/lib/profile.ts:2-3 ("When off, no preamble is built, no extractor
-- fires, no chat sync, no mail events recorded").
--
-- Default true: ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT true backfills
-- every existing row to true on apply, preserving current behavior for
-- users who haven't toggled the flag.
--
-- RLS: existing user_profiles policy (20260421200000_user_profiles.sql)
-- grants owner-scoped all-access to the row, which already covers this
-- column. No policy changes.

alter table public.user_profiles
  add column if not exists memory_enabled boolean not null default true;
