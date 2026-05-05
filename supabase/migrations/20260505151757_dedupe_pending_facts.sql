-- One-shot cleanup: collapse duplicate pending facts.
--
-- Before today's fix, findDuplicateFact() in src/lib/profile-store.ts only
-- matched status='confirmed' or 'rejected (within TTL)'. Pending duplicates
-- could pile up when multiple extractor triggers (chat_turn / mail_decision /
-- mail_reply) ran within the debounce window for the same normalized text.
-- Result: the "Hvad jeg har bemærket" review queue showed the same fact
-- multiple times.
--
-- Going forward, both findDuplicateFact() and the onboarding-backfill
-- pre-check block pending duplicates. This migration removes the rows that
-- accumulated before that fix landed.
--
-- Strategy: keep the oldest pending row per (user_id, normalized_text);
-- delete the rest. Confirmed and rejected rows are not touched.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, normalized_text
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM facts
   WHERE status = 'pending'
)
DELETE FROM facts
 USING ranked
 WHERE facts.id = ranked.id
   AND ranked.rn > 1;
