# Audit finding: Brief mail section uses wrong data source, mislabels user actions as unread mail

**Severity:** HIGH
**Auditor:** Claude (Opus 4.7) — terminal session 2026-05-10,
  surfaced while attempting Daily Brief F2 fix in worktree
  `worktree-fix-daily-brief-icloud-gate`.

## Where

- `supabase/functions/daily-brief/index.ts:267-272` — the query
  that pulls the brief's mail input.
- `supabase/functions/daily-brief/compose.ts:62-64` — the
  `Ulæste mails:` ("Unread mails:") label applied to those rows
  in the Claude composer prompt.
- `src/screens/InboxDetailScreen.tsx:89` — `recordMailEvent({
  eventType: 'replied' })` writer (after sending a reply).
- `src/screens/InboxDetailScreen.tsx:111` — `recordMailEvent({
  eventType: 'dismissed' })` writer (after archiving).
- `src/lib/types.ts:274-279` — `MailEventType` union: `'read' |
  'deferred' | 'dismissed' | 'drafted_reply' | 'replied'`. Of
  the five values, only `'replied'` and `'dismissed'` have
  writers in the codebase. `'read'`, `'deferred'`, and
  `'drafted_reply'` are dead.

## Behavior observed

The brief composer prompt at `compose.ts:62-64` labels rows from
`mail_events` as **"Ulæste mails:"** (unread mail). The query at
`index.ts:267-272` has no time filter, no provider filter, and
takes the top 3 by `occurred_at` desc.

The actual contents of `mail_events` are records of user
actions: replies the user sent and mails the user archived. No
code path writes incoming mail to `mail_events` for any provider.
`poll-mail` (Gmail/Outlook server cron) does **not** write to
`mail_events`, despite the audit pre-flight's earlier assumption
otherwise. iCloud has no server-side mail poll at all.

Net effect: the mail section of every brief, for every user, is
either empty (`(ingen ulæste)` when the user has never replied
or archived) or a mislabeled snapshot of stale user actions.

## Behavior expected

`Ulæste mails` in the brief prompt should correspond to actual
unread incoming mail at the time the brief generates.

## Repro / scenarios

1. **iCloud-only user, never opened the in-app inbox.** Query
   returns `[]`. Composer renders `Ulæste mails: (ingen ulæste)`.
   Brief silently omits the mail line. Section is absent.
2. **Any user who archived 3 mails weeks ago and has done nothing
   since.** Query returns those 3 archive events forever
   (no time bound). Composer labels them as unread mail. Brief
   tells the user about mail they already archived, repeated
   across morning + midday + evening + every subsequent day until
   the user touches the inbox again.
3. **Any user with a `'replied'` event in the top 3.** Brief
   surfaces mail framed as unread incoming, but the row records
   a reply the user *sent*. Net effect: brief tells the user
   about mail "from themselves to <recipient>" framed as unread.

## Suggested direction

Product decision required. Possible shapes — do NOT pick from
this list, this is the human's call:

- Fresh provider-side unread fetch in the brief generator
  (server-side iCloud mail reader required for parity).
- Restrict the brief mail section to flagged / starred mail
  (per-provider semantics differ).
- Remove the mail section from the brief entirely; let calendar
  + facts + weather carry it.
- Filter `mail_events` rows by event type to something
  meaningful — but currently no code writes the type values that
  would make this useful, so this option requires writing new
  client (or server) code to populate `'read'` / `'deferred'`
  events first.

## Adjacent observations

- The `MailEventType` union at `src/lib/types.ts:274-279` has
  three values (`'read'`, `'deferred'`, `'drafted_reply'`) with
  zero writers anywhere in the codebase. Either the table was
  designed for a richer event log that never got built, or these
  are dead types. A reader of the type signature would assume
  more is happening than is.
- The composer's `Ulæste mails:` label is hardcoded Danish in
  `compose.ts:62-64`. Re-labeling alone does NOT fix the bug
  (the data is still wrong), but if the human chooses a stopgap
  while the larger decision is made, the label should change to
  match whatever the data actually represents (e.g. "Seneste
  mail-handlinger:" / "Recent mail actions:").
- Daily Brief audit F2 is blocked behind this decision — see
  `daily-brief-f2-decision.md`.
