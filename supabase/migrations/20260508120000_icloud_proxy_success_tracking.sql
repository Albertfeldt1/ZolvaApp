-- Track per-call success/failure on icloud_proxy_calls so we can compute
-- iCloud (Apple mail) success rate without diving into edge function logs.
--
-- Until now the row was a pure rate-limit / audit stub: (user_id, op,
-- called_at). The imap-proxy edge function inserts it BEFORE the IMAP/SMTP
-- op runs, so historical rows are pre-outcome and `success` is left NULL.
-- After this migration ships and the function is updated, every new row is
-- still inserted up front (NULL outcome) and then patched to true/false +
-- error_code as the request finishes.

-- 1. Outcome columns. Nullable on purpose: the row is inserted before we
--    know the outcome, and pre-existing rows have no outcome.
ALTER TABLE public.icloud_proxy_calls
  ADD COLUMN IF NOT EXISTS success    boolean,
  ADD COLUMN IF NOT EXISTS error_code text;

-- 2. Widen the op CHECK to include count / send-mail / append-draft. The
--    earlier op_widen migration missed these three, so today the rate-limit
--    insert silently 400s for them and they're absent from the audit log
--    entirely. Fixing it here so success tracking actually captures sends
--    and appends.
ALTER TABLE public.icloud_proxy_calls
  DROP CONSTRAINT IF EXISTS icloud_proxy_calls_op_check;

ALTER TABLE public.icloud_proxy_calls
  ADD CONSTRAINT icloud_proxy_calls_op_check
  CHECK (op IN (
    'validate',
    'list-inbox',
    'get-body',
    'count',
    'clear-binding',
    'send-mail',
    'append-draft'
  ));

-- 3. Partial index for fast "what failed recently" lookups.
CREATE INDEX IF NOT EXISTS icloud_proxy_calls_failures
  ON public.icloud_proxy_calls (called_at DESC)
  WHERE success = false;

-- 4. Rolled-up success-rate view. One row per op with windowed totals and
--    success percentages. Uses now() so it always reflects "right now"
--    without needing a refresh job.
CREATE OR REPLACE VIEW public.v_icloud_proxy_success_rate AS
SELECT
  op,
  COUNT(*) FILTER (WHERE called_at > now() - interval '1 hour') AS calls_1h,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE called_at > now() - interval '1 hour' AND success)
    / NULLIF(COUNT(*) FILTER (WHERE called_at > now() - interval '1 hour' AND success IS NOT NULL), 0),
    1
  ) AS pct_1h,
  COUNT(*) FILTER (WHERE called_at > now() - interval '24 hours') AS calls_24h,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE called_at > now() - interval '24 hours' AND success)
    / NULLIF(COUNT(*) FILTER (WHERE called_at > now() - interval '24 hours' AND success IS NOT NULL), 0),
    1
  ) AS pct_24h,
  COUNT(*) FILTER (WHERE called_at > now() - interval '7 days') AS calls_7d,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE called_at > now() - interval '7 days' AND success)
    / NULLIF(COUNT(*) FILTER (WHERE called_at > now() - interval '7 days' AND success IS NOT NULL), 0),
    1
  ) AS pct_7d
FROM public.icloud_proxy_calls
GROUP BY op
ORDER BY op;

-- 5. Recent error breakdown view. Useful for "what's actually failing".
CREATE OR REPLACE VIEW public.v_icloud_proxy_recent_errors AS
SELECT
  op,
  error_code,
  COUNT(*) AS n,
  MAX(called_at) AS last_seen
FROM public.icloud_proxy_calls
WHERE success = false
  AND called_at > now() - interval '24 hours'
GROUP BY op, error_code
ORDER BY n DESC, last_seen DESC;

-- The base table has RLS enabled with no policies, so views inherit the
-- service-role-only access pattern. No grant changes needed.
