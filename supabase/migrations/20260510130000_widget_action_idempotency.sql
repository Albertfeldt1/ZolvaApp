-- supabase/migrations/20260510130000_widget_action_idempotency.sql

-- widget_action_idempotency: dedupe Siri voice calendar invocations.
--
-- The iOS AppShortcut client posts to widget-action with a 6s timeout
-- (constrained by Siri's UI budget). Slow Haiku parse + provider write
-- can exceed that window, the client surfaces a generic failure, and
-- any network-layer retry re-runs the action — creating a duplicate
-- calendar event because the original request actually succeeded
-- server-side. The client now sends a per-invocation UUID; the server
-- short-circuits on second sight and returns the recorded response
-- instead of re-running the side-effecting work.
--
-- Scope: only protects against retries inside one user invocation
-- (network layer, iOS Siri client). User re-utterance generates a new
-- UUID and is correctly treated as a new invocation; that surface
-- needs separate fuzzy-duplicate detection (out of scope here — see
-- audit findings/siri-voice-calendar.md F1).

create table if not exists public.widget_action_idempotency (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

-- Read path filters by `created_at > now() - interval '15 minutes'`
-- (Siri retries don't span hours). Index supports the filter cheaply.
create index if not exists widget_action_idempotency_created_at_idx
  on public.widget_action_idempotency (created_at);

-- Service-role only. The client never reads this table directly.
alter table public.widget_action_idempotency enable row level security;

-- Cleanup: a separate pg_cron sweep deletes rows older than 1 hour.
-- Without it the table grows monotonically. The 15-min read filter
-- means anything older is dead weight.
--
-- See supabase/schedule-widget-action-idempotency-sweep.sql.template
-- for the cron job — apply via SQL editor per the project's pg_cron
-- template convention (templates are NOT auto-applied).
