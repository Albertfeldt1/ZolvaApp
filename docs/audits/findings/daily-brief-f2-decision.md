# Daily Brief F2 — decision: deferred

## Decision

Daily Brief F2 fix attempted on 2026-05-10, deferred. Worktree
branch `worktree-fix-daily-brief-icloud-gate` reverted to no net
change against main.

## Reasoning

Initial scope was to extend the iCloud-only "no brief" gate
server-side and to all three brief kinds (morning, midday,
evening). Pre-flight verification showed
`supabase/functions/_shared/calendar.ts:60-87` reads iCloud
successfully via `fetchIcloudEvents` when `userHasIcloudCreds ===
true`, suggesting Option A's framing ("iCloud users blocked
because brief generator can't read iCloud") was obsolete.
Inverted scope to "remove the gate."

Manual trace of the brief's mail section then surfaced a
separate, larger bug in the brief mail pipeline — see
`brief-mail-pipeline.md`. The morning gate currently masks that
bug for iCloud-only users by not running briefs for them.
Removing the gate would expose iCloud-only users to a pipeline
that's already broken for Gmail/Outlook users — shipping the
fix would lock in the bigger bug. Extending the gate ("Option A")
would be "correct by accident": the original justification is
invalid, but the gate happens to protect one user class from a
different broken thing.

## Resolution

Both paths reject. F2 fix deferred until the mail-pipeline
product decision is made. After that, F2 becomes either trivial
(gate disappears alongside the broken section) or unnecessary
(provider-aware mail source obviates the gate entirely).

## Status

Production behavior unchanged from pre-fix state. Morning gate
intact. Midday/evening prefs continue rendering without an
iCloud-only gate (the audit's narrower bug — knowingly deferred,
not fixed).
