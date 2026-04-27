-- Action-y facts (commitments, "remember Oscar has to ...") need to decay so
-- they don't haunt the morning brief forever. Relations/roles/preferences/
-- projects stay permanent (NULL).
--
--   - expires_at NULL  → permanent (current behavior, all existing rows)
--   - expires_at SET   → row stops appearing in briefs once now() > expires_at
--
-- decay_warning_sent_at lets the daily cron push exactly one heads-up
-- notification per fact in the 24h window before expiry.

ALTER TABLE public.facts
  ADD COLUMN IF NOT EXISTS expires_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decay_warning_sent_at TIMESTAMPTZ;

-- Partial index — most rows will have expires_at IS NULL, so we only index
-- the decay-eligible subset. Covers both the brief filter (expires_at > now)
-- and the cron lookup (expires_at BETWEEN now and now+24h).
CREATE INDEX IF NOT EXISTS facts_expires_at_idx
  ON public.facts (user_id, expires_at)
  WHERE expires_at IS NOT NULL;
