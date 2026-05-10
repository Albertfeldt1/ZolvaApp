# Audit: iCloud integration — Mail (IMAP proxy) + Calendar (CalDAV device-direct)

**Auditor:** Claude (Opus 4.7, 1M context) — session in worktree `icloud-audit`
**Date:** 2026-05-09
**Time spent:** ~75 min

## Summary

The end-to-end happy path holds: setup screen runs IMAP `validate` and
CalDAV `probeCredential` in parallel, persists creds to Keychain
(local), upserts an encrypted CalDAV blob server-side via
`icloud-creds-link`, and writes an HMAC-of-(email:password) binding
row via the `validate` op of `imap-proxy`. Mail reads/writes go
through `imap-proxy` with creds in body each call (server holds only
the HMAC binding). Calendar reads/writes go device-direct from
Keychain. Disconnect from Settings cleans Keychain, server
encrypted_blob, server binding, discovery cache, inbox SWR cache, and
voice-routing labels — all four cleanup steps fire in order.

Risk concentrates in **three places**:

1. **Stale-credential silence on the calendar path.** When the user's
   app-specific password rotates externally, `listEvents` keeps
   returning `{ ok: true, data: [] }` for up to ~24 h because every
   cached calendar's per-calendar 401 is swallowed by the worker
   loop. The credential is never flipped to `invalid`, no banner
   surfaces, and the calendar tab simply looks empty.
2. **Spec/code drift on the credential model.** The brief assumes a
   `valid / pending / expired / disconnected` four-state machine.
   The codebase is a three-state Keychain machine
   (`absent / valid / invalid`) plus a Settings-row UI label that
   maps to four words. There is **no** `pending` state, no server-side
   credential state column, and `imap-proxy` never moves any state on
   IMAP auth failure — the binding row stays untouched and only the
   client transitions to `invalid` on the 422 response.
3. **Global pepper, no per-user salt.** `hashCredential` is
   `HMAC-SHA256(BINDING_HASH_PEPPER, "email:password")` — `userId`
   is not part of the HMAC input, so two users with identical Apple
   ID + identical app-specific password would produce the same
   `credential_hash`. In practice Apple-generated ASPs are unique
   per app, but the brief explicitly asked.

Secondary risks: the shared 60-call/hour bucket for `list-inbox` +
`count` is consumed at 2 calls per inbox open (each open calls
`getInboxCounts` AND `listInbox`), so a pull-to-refresh-happy user
can lock themselves out at ~30 open-equivalents/hr; the rate-limit
window on `icloud-creds-link` is 1/5 min and a transient failure
between `validate` (server hash upserted) and `icloud-creds-link`
(server encrypted_blob upserted) can leave the binding hash and
encrypted_blob temporarily out of sync — fine for inbox, but the
voice path reads encrypted_blob and would be stale for up to 5 min;
re-link awareness depends on the user opening Inbox or Calendar (no
push, no proactive reconcile).

## Findings

### F1 — Stale CalDAV credential produces silent empty calendar for up to 24 h [HIGH]

**Where:** `src/lib/icloud-calendar.ts:223-256` (the `worker()` loop
in `listEvents`) combined with the cache TTLs at
`src/lib/icloud-calendar.ts:19-20`
(`PRINCIPAL_TTL_MS = 30 d`, `CALENDAR_LIST_TTL_MS = 24 h`).

**Repro:** User connects iCloud, calendar tab loads once. User
rotates their app-specific password on Apple's side without going
through Zolva's Setup screen. Within 24 h, user opens calendar tab.

**Behavior observed:** `listEvents` finds the discovery cache fresh
(< 30 d) and the calendar list fresh (< 24 h), so it skips the two
auth-checking PROPFIND paths. It runs the per-calendar `REPORT`
fan-out at lines 224-249. Every `reportEvents` returns
`{ ok: false, error: 'auth-failed' }` from
`caldavFetch`'s `if (res.status === 401 || res.status === 403)`.
The worker loop at 230-237 swallows each per-calendar error
(`continue`) on the documented assumption that "a single calendar
refusing the REPORT does not mean the credential rotated." With
**all** calendars 401-ing, `results` ends empty and line 256
returns `{ ok: true, data: [] }`. `markInvalid` is never called, no
banner triggers, and the calendar tab renders blank.

**Behavior expected:** Either (a) detect "all calendars 401" as the
credential-rotation signal (e.g., flip to `invalid` if every
`reportEvents` returned `auth-failed`), or (b) periodically re-run
`listCalendarsAt` so the auth-checking path catches the rotation
sooner than `CALENDAR_LIST_TTL_MS`.

**Suggested direction:** Track per-fan-out `auth-failed` count; if
it equals `cals.length` and `cals.length > 0`, treat as
`auth-failed` at the listEvents level and call `markInvalid`.

---

### F2 — `imap-proxy` does not change any state on IMAP auth failure [MEDIUM]

**Where:** `supabase/functions/imap-proxy/index.ts:439-514`
(`mapImapError`); compare with `supabase/migrations/20260425100000_icloud_proxy.sql:15-20`
(`icloud_credential_bindings` has no `state` column).

**Repro:** User's password rotates externally. Client calls
`list-inbox` with the still-stored old creds. Server's `hashCredential`
matches the bound hash, so the binding check passes
(`index.ts:629-635`). `imapflow.connect()` then fails with
`AUTHENTICATIONFAILED` from Apple. `mapImapError` returns
`err('auth-failed', 422)` and the call ends. The
`icloud_credential_bindings` row is unchanged.

**Behavior observed:** Server returns 422; the binding row stays in
place and the only persisted state change happens on the **client**
when `markInvalid` fires inside `src/lib/icloud-mail.ts:345-347`
(and the equivalents in `getMessageBody`, `getInboxCounts`,
`icloudSendMail`, `icloudAppendDraft`). Reasoning is fine — the
binding hash is just a credential-stuffing guard, not a state
machine. But the audit brief assumed an `expired` state on the
server side, which simply doesn't exist; this is worth recording
because future code (notifications, voice path, server-driven
re-link prompts) may incorrectly assume the server tracks
expiry.

**Behavior expected:** The brief asked whether the binding moves
to `expired` or whether the function "leaves state as `valid`,
causing the client to retry forever." Neither is what happens —
state stays put, and the client correctly transitions to
`invalid` so subsequent calls short-circuit to `credential-rejected`
without retrying.

**Suggested direction:** Document in the migration header that
`icloud_credential_bindings` is **not** a credential state machine —
just a stuffing guard. If a server-side notion of "expired" is
needed (e.g., to drive a push), it would be a separate column and
needs to be set explicitly; today nothing flips it.

---

### F3 — Pepper is global, not per-user-salted [MEDIUM]

**Where:** `supabase/functions/imap-proxy/index.ts:541-554`
(`hashCredential`).

**Repro:** Two distinct user accounts on the same Apple ID with the
same app-specific password (theoretical — Apple generates a new ASP
per app, and the user enters the email per setup). Both bindings
end up with the same `credential_hash`. Service-role queries can
group rows by `credential_hash` to identify cred-sharing.

**Behavior observed:** `hashCredential` does
`HMAC-SHA256(pepper, "email:password")`. `userId` is not part of
the HMAC input. The binding row keys on `user_id` so storage is
per-user, but the **hash value** is not.

**Behavior expected:** The brief asked if the hashing scheme has a
per-user salt that "isn't a global hash that lets the server
silently identify duplicate credentials." Today it is global. The
practical risk is near-zero (Apple-generated ASPs are app-specific
and unique), but the property the brief asked for is not held.

**Suggested direction:** Mix `userId` into the HMAC input
(`HMAC(pepper, userId + ":" + email + ":" + password)`). Note: this
invalidates every existing binding row, which means the next
`list-inbox` for every connected iCloud user would 422 once and
require a re-`validate`. Coordinate with a deploy-time
`DELETE FROM icloud_credential_bindings;` (or just the cron sweep
slowed to 0 days for one cycle) so users hit the re-link banner
on first call rather than a confusing 422.

---

### F4 — Re-link awareness depends on the user opening Inbox or Calendar [MEDIUM]

**Where:**
- Detection only happens when an `imap-proxy` op or a CalDAV op
  returns `auth-failed`:
  - `src/lib/icloud-mail.ts:345-347, 384-386, 416-418, 473-475, 512-514`
  - `src/lib/icloud-calendar.ts:121, 194, 203, 945, 964, 979`
- Banner surfaces on `loadCredential` returning `invalid`:
  - `src/screens/InboxScreen.tsx:107-122, 212-222`

**Repro:** User connects iCloud, doesn't open Inbox or Calendar
again for two weeks, rotates the password externally on day 5.
On day 14 they open Inbox.

**Behavior observed:** Up to day 14, the credential stays `valid`
locally. There is no push, no `AppState=active` reconcile that
proactively pings Apple, no daily-brief gate-driven re-validation
(iCloud users are intentionally blocked from briefs by design,
which removes that side channel). The first probe that triggers
`markInvalid` is the user's day-14 Inbox open; the banner appears
on the **next** Inbox mount or AppState=active flip, since the
useEffect at `InboxScreen.tsx:109-122` only re-reads
`loadCredential` on those triggers — not on a mid-session
`markInvalid` write. Subscribing to `subscribeToIcloudCreds` would
fix this, but the InboxScreen does not.

**Behavior expected:** The brief lists "Push? Foreground reconcile?
Tool-call failure?" — only the third actually fires today, and
even it requires one extra mount/AppState flip before the banner
shows.

**Suggested direction:** Either (a) subscribe to
`subscribeToIcloudCreds` from InboxScreen so `markInvalid` mid-render
flips the banner immediately, or (b) accept the current latency and
document it. Push/server-side detection would require server-side
state (which doesn't exist — see F2) so is a much larger change.

---

### F5 — Inbox-open burns 2 of 60 list-inbox/count rate-limit slots [MEDIUM]

**Where:**
- `supabase/functions/imap-proxy/index.ts:295-296, 57-58`:
  `count` shares the `list-inbox` bucket; combined limit is 60/hr.
- `src/lib/icloud-mail.ts:236-253` (listInbox SWR) +
  `src/lib/icloud-mail.ts:369-390` (getInboxCounts) — they're
  separate calls, both fired per inbox open.

**Repro:** User opens Inbox repeatedly via tab switching, or pulls
to refresh > 30 times in an hour.

**Behavior observed:** Every open consumes 1 list-inbox + 1 count
(both with rate-limited inserts). The shared 60/hr ceiling means
the effective open ceiling is ~30. The client retries gateway
flakes via `GATEWAY_RETRY_BACKOFF_MS = [1500, 4000]` before
returning `gateway-unavailable`; `auth-failed`/`rate-limited` are
not retried. Once the user crosses the ceiling, every iCloud
inbox call returns `rate-limited` for the rest of the rolling
hour.

**Behavior expected:** The brief explicitly asked: "Is there a
chance an honest user (refreshing inbox repeatedly during sync)
gets locked out?" The answer is yes — the SWR cache mitigates the
visible blanking but the 60/hr ceiling is real and visible to a
heavy refresher.

**Suggested direction:** Either (a) raise the shared limit
modestly, (b) split the buckets so `count` (cheap STATUS) gets a
higher ceiling than `list-inbox` (expensive FETCH), or (c) gate
`count` calls behind a stale-window so they don't fire on every
open. Note: the SWR cache already softens the user-visible impact,
so the practical pain is "rate-limited" banners appearing during
heavy use, not blank inboxes.

---

### F6 — `icloud-creds-link` rate-limit can desync server hash from server encrypted_blob [LOW]

**Where:** `src/screens/IcloudSetupScreen.tsx:155-185`
(parallel `validateImap` + `probeCalDav`, then `saveCredential`),
`supabase/functions/icloud-creds-link/index.ts:138-155`
(`RATE_LIMIT_WINDOW_SEC = 5*60`, `RATE_LIMIT_MAX = 1`),
`src/lib/icloud-credentials.ts:217-231`
(`saveCredential` rollback path).

**Repro:** User rotates ASP on Apple, opens Setup, enters new
creds, submits. `validateImap` succeeds (server upserts new binding
hash via `imap-proxy.handleValidate:402-415`). `probeCalDav`
succeeds. `saveCredential` writes Keychain, runs discovery, then
calls `icloud-creds-link` — but a previous link within the past
5 min triggered the audit-log rate limit (e.g., the user had to
re-submit because of a typo). Server returns 429 `rate_limited`.
Client throws `IcloudLinkFailure('rate-limited')`, rolls back
Keychain.

**Behavior observed:** Server state after rollback:
- `icloud_credential_bindings` row → **new** hash (from the
  successful `validate` upsert).
- `user_icloud_calendar_creds.encrypted_blob` → **still the old**
  password (link upsert never ran).
- Local Keychain → wiped.

For the inbox path this is benign — the user has no creds, so they
re-enter once the rate-limit window expires. For the **voice path**
(`widget-action` → `loadIcloudCreds` → CalDAV write with the stored
encrypted_blob), the path uses the OLD password until either
(a) the user successfully re-links (overwriting encrypted_blob), or
(b) the user disconnects (revoking the row).

**Behavior expected:** The two server-side artifacts (binding hash
and encrypted_blob) should track the same generation of credential.

**Suggested direction:** Either (a) move the binding upsert to AFTER
the link succeeds (currently it's done inside the `validate` op,
which is the first thing in the parallel race), or (b) on
`saveCredential` rollback, also call `clearBinding()` to wipe the
just-written hash so the inbox path doesn't trust a half-installed
generation. Note: probe order matters because `validateImap` is what
upserts the hash, so the cleanest fix is option (b).

---

### F7 — `useIcloudConnected` collapses 'invalid' to false, hiding the disconnect-vs-expired distinction [LOW]

**Where:** `src/lib/hooks.ts:598-609`.

**Repro:** Anywhere `useIcloudConnected` is consumed (the comment
mentions `useMailItems` / `useCalendarItems` / `useHasProvider`).

**Behavior observed:** Returns `true` only when
`c.kind === 'valid'`. Both `'absent'` and `'invalid'` return
`false`. Callers can't distinguish "user has not connected"
(`absent`) from "creds were rejected, user can re-enter via the
banner" (`invalid`).

**Behavior expected:** Callers like `useHasProvider` may want to
treat `invalid` as "still configured, just temporarily broken"
rather than "no provider connected" — the latter could
inadvertently route the user back through V2 onboarding.

**Suggested direction:** Add a parallel `useIcloudCredKind()` that
exposes the full three-state. Audit
`useHasProvider` / `useMailItems` to confirm none are silently
treating `invalid` as `absent` in a user-visible way. This is a
clarification, not a known-broken behavior.

---

### F8 — Validate's binding upsert runs even if the subsequent CalDAV probe fails [LOW]

**Where:** `src/screens/IcloudSetupScreen.tsx:156-161` runs
`validateImap` and `probeCalDav` in `Promise.all`. `validateImap`
unconditionally upserts the binding hash via the server's
`handleValidate` path. If `probeCalDav` then fails, the screen
returns early at line 161 — the binding hash on the server has
**already** been moved to the new (still-valid) password, but
local Keychain has not yet been written.

**Repro:** User enters valid Apple ID + ASP. IMAP `validate`
succeeds. CalDAV `probeCredential` fails with `network` (e.g.,
intermittent connectivity to `caldav.icloud.com`). User retries
30 s later, succeeds.

**Behavior observed:** Between attempts, server's
`icloud_credential_bindings` row points to the new hash. Local
Keychain still has the previous credential (or none). Next
`list-inbox` would 422 because the user has no local creds (kind
`absent` short-circuits before reaching the server). On the
successful retry, Keychain is finally written. End-state correct.

**Behavior expected:** Same end state; the transient mismatch is
benign because no client call hits the server before the retry
succeeds.

**Suggested direction:** Worth noting because the order of
side-effects across this two-leg probe + creds-link is fragile;
consider running probes sequentially (probeCalDav first, then
validateImap) so the only server-side write happens when both
client-side checks have passed.

---

## Adjacent findings (out of scope, noted but not investigated)

- **`handleSendMail` does not append to Sent folder** — documented
  limitation at `supabase/functions/imap-proxy/index.ts:1470-1486`.
  Mails are delivered, but Apple Mail's Sent folder is missing the
  copy. Out of audit scope (server send is in scope only as far as
  the credential model).
- **CalDAV principal cache is 30 days** — if Apple ever rotates the
  pXXX-caldav.icloud.com shard for a user, the Zolva client could
  hit a stale principalUrl for up to 30 d before a discovery
  refresh. No evidence Apple does this routinely. Worth a watch.
- **`imap-proxy` rate-limit fail-open** — at
  `supabase/functions/imap-proxy/index.ts:312-315`, a Postgres error
  on the count query returns `allowed: true` so users aren't
  locked out by infrastructure flakes. Documented intentional;
  worth an eyeball if metrics ever show abuse.
- **`probeCalDav` and `validateImap` both hit Apple from the
  device on every Setup submit.** Apple may rate-limit per-account
  if the user retries quickly; not investigated.
- **`icloud-creds-link` allows `*caldav.icloud.com` via `endsWith`** —
  hostname check is `u.hostname.endsWith('caldav.icloud.com')`,
  which matches `pXXX-caldav.icloud.com` (intentional) but also
  matches `notcaldav.icloud.com` (Apple-controlled, low-risk).
  `index.ts:73-82`. Not a finding.

## Open questions

- Does the chat agent's iCloud calendar tool path go through
  `listEvents`, and therefore inherit F1's silent-empty failure
  mode? If so, the chat would respond "you have no events" with
  high confidence, which is worse than empty calendar UI.
- Does the iOS widget v1 read iCloud calendar at all today? If yes,
  same F1 question applies.
- Is there any cron-driven server-side iCloud reconcile that could
  catch F4 silently? I didn't find one in `supabase/functions/`,
  but a Supabase dashboard-only cron could exist.
- The 5-min iat-recency gate on `icloud-creds-link` is satisfied by
  `supabase.auth.refreshSession()` immediately before the call
  (`src/lib/icloud-credentials.ts:128-132`). Does any path call
  `icloud-creds-link` WITHOUT this refresh? If so, that path would
  fail with `reauth-required` for any session refreshed > 5 min
  ago. Quick grep shows only `saveCredential` calls it; verify no
  background re-link path was added later.

## Verification done

**Files read end-to-end:**

- `supabase/functions/icloud-creds-link/index.ts` (188 lines)
- `supabase/functions/icloud-creds-revoke/index.ts` (117 lines)
- `supabase/functions/_shared/icloud-creds.ts` (53 lines)
- `supabase/functions/imap-proxy/index.ts` (1574 lines)
- `src/lib/icloud-credentials.ts` (288 lines)
- `src/lib/icloud-mail.ts` (676 lines)
- `src/screens/IcloudSetupScreen.tsx` (lines 1-220)
- `src/lib/icloud-calendar.ts` (lines 1-400 + targeted reads of
  `listEvents`, `caldavFetch`, `reportEvents`, `createEvent`,
  `updateEvent`, `deleteEvent`)

**Migrations read:**

- `20260425100000_icloud_proxy.sql`
- `20260425110000_icloud_proxy_index_fix.sql`
- `20260427000000_icloud_proxy_op_widen.sql`
- `20260427130001_icloud_proxy_calls_retention.sql`
- `20260429140000_icloud_calendar_creds.sql`
- `20260429140100_icloud_calendar_creds_helpers.sql`
- `20260508120000_icloud_proxy_success_tracking.sql`

**Code paths traced manually:**

- IMAP setup → `validate` → server hash upsert → `list-inbox`
  binding-check → IMAP LOGIN → `auth-failed` → `markInvalid` →
  `credential-rejected` banner.
- Settings disconnect → `clearCredential` (Keychain wipe + revoke
  endpoint + inbox cache wipe + voice-routing label clear) →
  `clearDiscoveryCacheFor` → `clearBinding` → `clearIntegrationFlags`.
- CalDAV `listEvents` cache-hit fan-out under stale credentials
  (the F1 path).
- `saveCredential` rollback path under
  `icloud-creds-link` rate-limit (the F6 path).

**Commands run:**

- `git fetch origin main && git reset --hard origin/main` to align
  the worktree with production state (worktree was branched from
  an older commit that predated iCloud).
- File listings to verify the spec/code naming mismatch
  (`icloud-proxy` in the brief vs `imap-proxy` in the repo).
- Targeted `awk` to enumerate `markInvalid` call sites in
  `icloud-calendar.ts` (8 occurrences, none inside the per-calendar
  worker that is the F1 site).

**Spec/code mismatches noted (not findings, just worth recording):**

- Brief says edge fn name is `icloud-proxy`; actual name is
  `imap-proxy`.
- Brief says `op` constraint allows `validate, list-inbox, get-body,
  count, clear-binding, send-mail, append-draft` per the latest
  migration. Confirmed at
  `20260508120000_icloud_proxy_success_tracking.sql:25-35`.
- Brief uses "four-state credential model" terminology; actual
  client model is three-state with a Settings-row UI label
  collapsing to four words. Server has no credential state column.

**Typecheck not run** — out of audit scope per CONTEXT.md
("Flag findings; do not fix").
