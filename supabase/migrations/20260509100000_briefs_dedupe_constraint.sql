-- Race-safe dedupe for daily-brief generation.
--
-- The daily-brief edge function checks for an existing brief, then composes
-- via Claude (5+ seconds), then INSERTs. Two concurrent invocations both
-- saw "no brief yet", both spent the Claude call, both inserted - we
-- observed this in production on 2026-05-09 (two morning briefs 5s apart
-- for the same user). The fix is a unique index so the second INSERT
-- fails with 23505 and the function bails before sending a duplicate push.
--
-- Date is computed in Europe/Copenhagen (Zolva's user base is Danish; per-
-- user timezone-aware indexing would require a non-immutable expression
-- which Postgres doesn't allow in indexes - acceptable trade-off for now,
-- a Copenhagen user crossing into a different timezone for a day is
-- vanishingly rare and would just produce the existing duplicate behaviour
-- for that one day).

-- 1. Clean up existing duplicates. Keep the earliest brief per
--    (user_id, kind, local_date); the second brief was almost certainly
--    a race victim with content nobody acted on yet.
DELETE FROM public.briefs b
USING (
  SELECT
    user_id,
    kind,
    (generated_at AT TIME ZONE 'Europe/Copenhagen')::date AS local_date,
    MIN(generated_at) AS earliest
  FROM public.briefs
  GROUP BY user_id, kind, (generated_at AT TIME ZONE 'Europe/Copenhagen')::date
  HAVING COUNT(*) > 1
) dups
WHERE b.user_id = dups.user_id
  AND b.kind = dups.kind
  AND (b.generated_at AT TIME ZONE 'Europe/Copenhagen')::date = dups.local_date
  AND b.generated_at <> dups.earliest;

-- 2. Generated column for the local-date dedupe key. STORED so Postgres
--    can index it directly; Europe/Copenhagen is a fixed IANA id so the
--    expression is immutable.
ALTER TABLE public.briefs
  ADD COLUMN IF NOT EXISTS brief_local_date date GENERATED ALWAYS AS (
    (generated_at AT TIME ZONE 'Europe/Copenhagen')::date
  ) STORED;

-- 3. The dedupe constraint. Second insert per (user, kind, day) hits
--    23505 unique_violation; the edge function maps that to 'already-
--    briefed' and bails without pushing.
CREATE UNIQUE INDEX IF NOT EXISTS briefs_user_kind_local_date_unique
  ON public.briefs (user_id, kind, brief_local_date);
