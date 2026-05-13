-- 2026-05-13 — Widen observations.action_kind to include 'mailDraft'.
--
-- Background: the client emits Observation rows with action.kind='mailDraft'
-- (src/lib/hooks.ts:470, src/lib/types.ts:24) but the original migration
-- (supabase/migrations/20260425000000_observations.sql:13) only allowed
-- ('openMail','prompt','chat'). Any mailDraft observation hit the CHECK
-- and surfaced as: 'observations_action_kind_check' violation.
--
-- mail_events lives in dashboard-only schema (no repo migration); observations
-- has a repo migration but the constraint widening is applied here for
-- reproducibility. Paste this whole file into the Supabase Dashboard SQL
-- editor, OR apply via the Supabase MCP execute_sql tool.

alter table public.observations
  drop constraint if exists observations_action_kind_check;

alter table public.observations
  add constraint observations_action_kind_check
  check (action_kind in ('openMail','prompt','chat','mailDraft'));
