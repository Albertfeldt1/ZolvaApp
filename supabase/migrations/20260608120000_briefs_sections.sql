-- Structured daily-brief sections.
--
-- The brief moves from a single free-form `body` (prose paragraphs) to a
-- structured layout: calendar / mails / followups / focus / weather, each a
-- list of short strings. `body` stays populated as a flattened fallback for
-- clients that predate the structured-UI OTA, so this column is additive and
-- nullable - old briefs simply have sections = NULL and render via `body`.
alter table public.briefs
  add column if not exists sections jsonb;
