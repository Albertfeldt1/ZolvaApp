# Audit: Daily brief generation

**Auditor:** Claude (Opus 4.7, 1M context) — session in worktree `daily-brief-audit`
**Date:** 2026-05-10
**Time spent:** ~75 min

## Summary

The daily-brief pipeline reaches end-to-end in the happy path: cron fires
every 15 min, the function matches the user's pref window in their local
TZ, assembles facts + mail_events + weather + multi-provider calendar
(via `Promise.allSettled` so individual provider failures degrade
gracefully), composes via Claude Haiku 4.5, inserts a row, sends a push,
and the client's notification handler routes a tap (cold-start or live)
through `requestBriefOpen` → `fetchBriefById` → `BriefModal` correctly.

Risk concentrates in **two places**: (1) the iCloud-only "no brief"
constraint is enforced ONLY in the Settings UI and ONLY for
`morning-brief` — server has no gate, and `midday-brief` /
`evening-brief` rows escape the gate entirely; (2) the `briefs.kind`
CHECK constraint in repo migration (`'morning'`, `'evening'`) does not
include `'midday'`, so any user who turns on `midday-brief` will
silently fail at insert with SQLSTATE 23514, hitting `'insert-failed'`
with no diagnostic. Secondary issues: pre-check vs. unique-index
disagree on UTC-vs-Copenhagen day boundary (constraint backstops it),
spring-DST creates a one-time missed brief, and lowering the brief time
mid-window can drop today's brief silently.

## Findings

### F1 — `briefs.kind` CHECK constraint blocks `midday` insert silently [HIGH]

**Where:** `supabase/migrations/20260421000000_briefs.sql:8` vs
`supabase/functions/daily-brief/index.ts:108-111` and
`src/lib/hooks.ts:2885-2890`.

**Repro:** User opens Settings → "Sådan arbejder jeg" → sets
`Middagsoverblik` to `12.00`. At 12:00 local, cron fires
`daily-brief`, generates kind `'midday'`, attempts INSERT into
`briefs`. The migration's `check (kind in ('morning','evening'))`
rejects with SQLSTATE 23514 (check_violation). The handler at
`index.ts:226-233` only special-cases `23505` → 'race-loss'; everything
else returns `'insert-failed'`. No push is sent, the user never sees
their midday brief, and there is no surfaced error in-app.

**Behavior observed:** Midday brief silently never lands. The
user's only signal is the absence of a notification.

**Behavior expected:** Either the constraint should include `'midday'`
(so the inserts succeed), or the function should refuse `midday-brief`
prefs upstream so the user is told the feature is off, or `midday-brief`
should not be exposed as a row option in the work-preferences UI.

**Suggested direction:** Verify whether production schema's CHECK has
been widened to include `'midday'` (CONTEXT.md notes most schema is
dashboard-managed; this table is one of the few WITH a migration, so
divergence is plausible). If not, add a migration to relax the CHECK.
Confirmation requires `\d+ public.briefs` against the prod DB.

---

### F2 — iCloud-only "no brief" rule enforced only in UI, only for morning [HIGH]

**Where:** `src/screens/SettingsScreen.tsx:1402-1403` and
`SettingsScreen.tsx:1725` vs the absence of any gate in
`supabase/functions/daily-brief/index.ts`.

**Repro:**
1. iCloud-only user (Apple Sign-In + iCloud creds, no Google /
   Microsoft) — `briefVariant === 'icloud-only'` correctly disables
   the `morning-brief` row (replaced with the "Kræver Gmail eller
   Outlook for nu" stub).
2. Same user opens the same Settings sheet, sets `Middagsoverblik`
   `12.00` and/or `Aftenoverblik` `18.00` — both rows render the
   normal `WorkPreferenceRow` because the variant check at line 1725
   gates ONLY `r.id === 'morning-brief'`. The pref persists.
3. At the configured time, `daily-brief` finds the pref via
   `.in('id', ['morning-brief','midday-brief','evening-brief'])`
   (`index.ts:89`), attempts to assemble. iCloud calendar IS pulled
   (`_shared/calendar.ts:74-86` runs the iCloud branch when
   `userHasIcloudCreds === true`). Brief composes from iCloud events +
   any facts/mail_events; push fires.

**Behavior observed:** "Option A" (iCloud-only blocked from briefs)
holds only for one of three brief kinds and only if the gate is
re-evaluated (e.g., a user who connected Google, set briefs, then
disconnected Google retains all three pref rows and gets briefs from
their iCloud calendar).

**Behavior expected:** Per the audit brief, the gate should be on the
user's provider set, server-side, applied to all three brief kinds.

**Suggested direction:** Add a server-side gate at the top of
`generateOneBrief` that loads `user_oauth_tokens.provider in
('google','microsoft')` for the user and short-circuits with a new
status (e.g., `'skipped-icloud-only'`) if absent. The Settings
visual block should mirror that for all three rows.

---

### F3 — Lowering brief time mid-window drops today's brief silently [MEDIUM]

**Where:** `supabase/functions/daily-brief/index.ts:158-168`
(`windowMatches`) plus the absence of a "missed window" backfill.

**Repro:** User has `morning-brief` set to `08.00`. At ~07:42 they
change it to `07.30`.
- 07:30 cron tick fired earlier with the OLD pref value (`08.00`) →
  window `[480, 495)`, `nowTotal=450` → no fire.
- 07:45 cron tick reads the NEW pref value (`07.30`) → window
  `[450, 465)`, `nowTotal=465` → strict `<` fails, no fire.
- 08:00 cron reads `07.30` → still outside window → no fire.
- User receives no morning brief that day. There is no logged signal.

**Behavior observed:** Pref change made shortly after the new pref's
window already passed but before the user's intent registered as a
satisfied window produces zero briefs that day.

**Behavior expected:** Either fire a one-shot brief on pref change
when the new time is "today, in the past, and we haven't briefed
yet today", or surface to the user that the change takes effect from
tomorrow. Current behaviour is invisible.

**Suggested direction:** A debounced client-side trigger on
pref-change (call the authenticated `daily-brief` endpoint with a
"if-no-brief-today" flag), or widen `windowMatches` to also fire
for the first cron tick after a pref's `updated_at` if no brief for
today/kind exists.

---

### F4 — Pre-check uses UTC date; unique index uses Europe/Copenhagen date [MEDIUM]

**Where:** `daily-brief/index.ts:193-201` (UTC pre-check) vs
`migrations/20260509100000_briefs_dedupe_constraint.sql:39-48` (Copenhagen
local-date generated column + unique index).

**Repro:** Mostly theoretical for the realistic Danish-user time
windows (07–09 morning, 17–19 evening), where UTC date == Copenhagen
date in both DST states. The constraint backstops the pre-check via
the `23505 → 'race-loss'` path. The semantic divergence still matters
because:

- The pre-check is the optimisation that avoids the Claude call for
  the second concurrent invocation; if pre-check disagrees with the
  index, BOTH invocations call Claude (5+ s) and only the second
  is rejected at insert. Wasted cost, not a user-visible bug.
- The 2026-05-09 migration's comment notes the Copenhagen hardcoding;
  the cron's `windowMatches` is per-user TZ; a future expansion to
  non-Danish users will amplify the disagreement.

**Behavior observed:** Functional correctness is preserved (the
constraint catches the race), but the comment at `index.ts:227`
("the race [the migration] exists to neutralise") is technically
true while the surrounding code's pre-check operates on a different
day boundary than the constraint.

**Suggested direction:** Either change the pre-check to compute the
same Copenhagen-local date used by the index, or add a code comment
on the pre-check explaining it is intentionally a coarse optimisation
and the constraint is the authoritative dedupe.

---

### F5 — Spring-DST start drops the brief once per year [MEDIUM]

**Where:** `daily-brief/index.ts:139-168` — `localHourMinute` returns
the wall-clock the user sees, but cron ticks are at fixed UTC
intervals.

**Repro:** Last Sunday of March, Europe/Copenhagen jumps `02:00 CET`
→ `03:00 CEST`. A user with `morning-brief` `02.30` (admittedly an
edge case among the offered options for evening at 17/18/19 — but
realistic for `midday-brief 12.30`/`13.00` if Cuba/etc. user, and
universally relevant for `02.30`-style configs added in the future).
The minute marks `02.30` and `02.45` are skipped entirely; the next
matching local minute is `03.30` so a `02.30` pref never matches.
A fall-back DST transition (`03:00 CEST → 02:00 CET`, hour repeats)
is correctly handled because the pre-check + UTC index reject the
second insert.

**Behavior observed:** One-day silent skip per year for affected
prefs. Today's offered options (`07.00`/`08.00`/`09.00` morning,
`11.30`/`12.00`/`12.30`/`13.00` midday, `17.00`/`18.00`/`19.00`
evening) all sidestep the affected hour, so this is latent risk
rather than active bug.

**Behavior expected:** Even an exotic local time should produce one
brief on a DST-start day. Acceptable to keep as known-issue if the
options list is the gate.

**Suggested direction:** Document in the migration / schedule
template that pref times in `02:00–03:00` are unsupported, OR widen
`windowMatches` to fire when the user's wall-clock has skipped past
the configured time without firing.

---

### F6 — Manual user-trigger endpoint can't actually trigger outside cron window [LOW]

**Where:** `daily-brief/index.ts:13-14` comment ("useful for manual
'trigger mine now' tests") vs `index.ts:104-114` which still applies
`windowMatches` for the authenticated path.

**Repro:** Authenticated `POST /daily-brief` at any time outside
the 15-min window for the user's pref produces `processed: 0`. No
brief, no error.

**Behavior observed:** The endpoint comment promises a "trigger mine
now" semantic that the code doesn't deliver — the code is identical
between cron and authenticated paths except for the user filter.

**Behavior expected:** Either the comment should be tightened to
"manual run within window" or the authenticated path should bypass
`windowMatches` (with the existing dedupe to prevent abuse).

**Suggested direction:** Tighten the comment; bypass is a feature
decision.

---

### F7 — `reminders` permanently `[]` in brief inputs despite system prompt expectations [LOW]

**Where:** `daily-brief/index.ts:277-294` — comment acknowledges
"Reminders are still local-only (AsyncStorage on the phone)".

**Repro:** `assembleInputs` always passes `reminders: []`. The
composer system prompt presumably references reminders; Claude
won't produce a "Husk i dag:" line because the input is empty.

**Behavior observed:** This is documented in the file. It mirrors
the audit-brief's caveat ("memory + reminders only" → in practice,
"memory only"). Calling out so future schema-migration work
moves reminders server-side and the input wires up.

**Behavior expected:** Reminder server-side migration is its own
project (per `project_chat_jobs_pass1` memory, server-side
migrations are landing for chat tools first).

**Suggested direction:** Track separately. No action in this audit.

---

### F8 — Old `briefs_user_kind_day_idx` index left in place after dedupe migration [NIT]

**Where:** `migrations/20260421000000_briefs.sql:21-22` vs
`migrations/20260509100000_briefs_dedupe_constraint.sql` (no DROP).

**Repro:** Both unique indexes exist on production after the
2026-05-09 migration. The old one keys on `(generated_at AT TIME
ZONE 'UTC')::date`; the new one on `brief_local_date` (Copenhagen).
For all realistic pref times in Europe/Copenhagen the two agree, so
this is double-dedupe rather than a correctness issue.

**Behavior observed:** Two indexes do the same job; minor write-path
cost.

**Suggested direction:** Add a `DROP INDEX IF EXISTS
briefs_user_kind_day_idx` to the dedupe migration (or a follow-up).

---

## Adjacent findings (out of scope, noted but not investigated)

- `useTodayBrief` (`src/lib/briefs.ts:65-72`) uses UTC-day filtering
  consistent with the edge-fn pre-check; same divergence note as F4
  applies (UTC-day vs Copenhagen-local-date).
- `briefs.body` is `jsonb` in the migration (an array of strings per
  client `rowToBrief`), but the row insert at
  `daily-brief/index.ts:218-223` writes `brief.body` directly without
  normalising — relies on Claude returning the schema. A malformed
  Claude response that parses as JSON but isn't an array would still
  insert and break the client's `rowToBrief.body` (`Array.isArray(r.body)
  ? ... : []` handles it gracefully — empty body shown).
- `weather` fetches Met.no with default Copenhagen lat/lng for ALL
  users including non-Danish ones (`index.ts:38-39`). Per-user
  location is called out as v2.
- The cron schedule template (`schedule-daily-brief.sql.template`)
  is gitignored from auto-apply per the `pg_cron templates need
  manual apply` memory — couldn't verify from repo whether
  `cron.job` actually has the `daily-brief-15min` row registered in
  production.
- `dispatchedNotificationIds` in `src/lib/notifications.ts:105` is
  module-level; an Expo dev/OTA reload during a session will reset
  it. Not user-visible in production builds.

## Open questions

- **Critical**: Has the prod `briefs.kind` CHECK been widened to
  include `'midday'`? Cannot verify from repo. (F1)
- Is `cron.job` actually populated with `daily-brief-15min` in
  production? Template file requires manual application.
- Is the `Europe/Copenhagen` hardcoding in the dedupe constraint
  expected to remain even when Zolva expands to non-DK users? (F4
  becomes a real bug then.)
- Does any client surface (e.g., a "your brief was skipped because
  …" toast) exist for the `'skipped-memory-off'` /
  `'empty-skipped'` / `'insert-failed'` outcomes? Did not find one.
  This is also why F1 is silent rather than self-reporting.

## Verification done

- Files read end-to-end:
  - `supabase/functions/daily-brief/index.ts` (385 lines)
  - `supabase/functions/refresh-provider-token/index.ts` (154 lines)
  - `supabase/functions/_shared/calendar.ts` (465 lines)
  - `supabase/functions/daily-brief/weather.ts`
  - `supabase/functions/_shared/icloud-calendar.ts` (relevant 30–90)
  - `src/lib/notifications.ts` (315 lines)
  - `src/lib/briefs.ts` (153 lines)
  - `src/screens/TodayScreen.tsx` (lines 60–260, brief section)
  - `App.tsx` (lines 380–470, 555–595)
  - `migrations/20260421000000_briefs.sql`
  - `migrations/20260509100000_briefs_dedupe_constraint.sql`
  - `schedule-daily-brief.sql.template`

- Code paths traced manually:
  - cron tick → `windowMatches` → `generateOneBrief` →
    `assembleInputs` (Promise.all over facts/mail_events/weather/
    `fetchCalendarForUser`) → Claude compose → INSERT briefs →
    sendPush → UPDATE delivered_at
  - token-revoked branch: `refreshAccessToken` →
    `RefreshRejectedError` → `Promise.allSettled` in
    `fetchCalendarForUser` swallows that branch only
  - all-providers-fail: empty events + empty mail_events + empty
    facts + empty reminders → `nonEmpty=false` → `'empty-skipped'`,
    no brief, no push
  - cold-start tap: `getLastNotificationResponseAsync` →
    `dispatchPayload` (deduped via `dispatchedNotificationIds`) →
    `onTap({type:'brief',briefId})` → `setTab('today')` +
    `requestBriefOpen` → TodayScreen useEffect on
    `briefOpenRequest` → `fetchBriefById` → `setViewingBrief` →
    BriefModal opens

- Commands run: `grep -rn` searches; no typecheck (per CONTEXT.md
  pre-existing error in `hooks.ts:4807` is unrelated; this audit
  introduced no edits).
