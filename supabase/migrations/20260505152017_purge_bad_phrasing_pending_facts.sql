-- One-shot cleanup: delete pending facts whose text uses the old
-- third-person phrasing or the redundant "huske…" prefix.
--
-- Context: until today, the extractor prompt didn't forbid 3rd-person
-- references ("brugeren"/"brugerens"/"brugere") or fact text starting with
-- "huske"/"husk"/"skal jeg huske"/"påmind". The UI wraps fact text in
-- "Skal jeg huske at …?", so a fact starting with "huske" produced
-- "Skal jeg huske at huske brugeren på at X?". The prompt is now fixed; this
-- migration removes the rows that already accumulated with the old wording so
-- they don't keep showing up in the review queue. If any were genuine
-- commitments, they will re-extract from chat or mail with correct phrasing.
--
-- Conservative patterns:
--   - "brugeren" / "brugerens" / "brugere" as standalone words — these are
--     the noun forms of "bruger". We deliberately skip the bare stem
--     "bruger" because it is also the verb form of "bruge" ("du bruger X"),
--     which is fine and doesn't indicate a 3rd-person slip.
--   - text that starts with "skal jeg huske" / "huske" / "husk" / "påmind"
--     (after optional leading whitespace) — these are the patterns the UI
--     wrapper duplicates.
DELETE FROM facts
 WHERE status = 'pending'
   AND (
     text ~* '\m(brugeren|brugerens|brugere)\M'
     OR text ~* '^\s*(skal jeg huske\M|huske?\M|påmind)'
   );
