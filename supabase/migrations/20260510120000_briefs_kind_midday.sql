-- Add 'midday' to briefs.kind CHECK constraint.
--
-- daily-brief/index.ts and src/lib/hooks.ts both wire the 'midday-brief'
-- work-pref through to kind='midday' on insert, but the original briefs
-- migration restricted kind to ('morning','evening'). Any user who turned
-- on Middagsoverblik silently failed at insert with SQLSTATE 23514;
-- daily-brief/index.ts:226-233 only special-cases 23505, so the outcome
-- was 'insert-failed' with no surfaced signal. See audit
-- docs/audits/findings/daily-brief-generation.md F1.

alter table public.briefs drop constraint briefs_kind_check;
alter table public.briefs add constraint briefs_kind_check
  check (kind in ('morning','midday','evening'));
