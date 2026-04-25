-- supabase/migrations/20260425110000_icloud_proxy_index_fix.sql
--
-- Fix: rate-limit query in the imap-proxy edge function filters on
-- (user_id, op, called_at), but the original index on icloud_proxy_calls
-- only covered (user_id, called_at), forcing a heap fetch + filter on op.
--
-- Volumes are tiny right now (table is empty / single-digit rows during
-- development), so this is a precaution before any production traffic
-- arrives. Replace with the correct composite index.

DROP INDEX IF EXISTS icloud_proxy_calls_user_called;

CREATE INDEX icloud_proxy_calls_user_op_called
  ON icloud_proxy_calls (user_id, op, called_at DESC);
