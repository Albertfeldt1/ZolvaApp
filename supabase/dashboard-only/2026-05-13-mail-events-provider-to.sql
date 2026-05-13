-- 2026-05-13 — Add provider_to to mail_events for recipient-allowlist matching.
--
-- mail_events lives in dashboard-only schema (no repo migration; see memory
-- project_memory_schema_dashboard_only.md). Paste this whole file into the
-- Supabase Dashboard SQL editor and run, OR apply via the Supabase MCP
-- execute_sql tool.

alter table public.mail_events
  add column if not exists provider_to text;

-- Index for the allowlist hot path: hasRecipientHistory(user_id, addr, 60d).
create index if not exists mail_events_user_to_occurred_idx
  on public.mail_events (user_id, provider_to, occurred_at desc)
  where provider_to is not null;
