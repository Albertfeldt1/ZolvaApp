# Audit: Google OAuth + `refresh-provider-token`

**Auditor:** Claude (Opus 4.7) — session in `.claude/worktrees/google-auth`
**Date:** 2026-05-10
**Time spent:** ~70 minutes

## Summary

The server-side refresh path is in good shape: the edge function is the
auth boundary as designed, JWT verification fails closed (no
200-with-no-token paths), refresh-token rotation is persisted for the
provider that actually rotates (Microsoft), and `doRefresh` correctly
refuses to fall through to `runOAuth` so a refresh failure cannot
silently call `unlinkIdentity`.

Two findings concentrate the real risk:

1. **`calendar.freebusy` scope is declared but uncalled** — must be
   removed before Google verification resubmission. (HIGH for the
   verification milestone; otherwise LOW.)
2. **Settings toggle precondition desyncs from server state** — when a
   transient `silentRefresh` failure leaves `googleAccessToken` null
   on a still-linked identity, tapping the Gmail/Calendar/Drive toggle
   re-enters `runOAuth`, which calls `unlinkIdentity` and revokes
   **every** refresh token for the user (including Microsoft).

A third concern around concurrent refresh races (cron + client) is
real but bounded; flagged MEDIUM.

## Findings

### F1 — `calendar.freebusy` scope declared but never called [HIGH]

**Where:** `src/lib/auth.ts:65` (declaration); `src/lib/google-calendar.ts:3` (stale doc comment)
**Repro:** `rg -n "freebusy"` across the repo returns only the scope
declaration in `GOOGLE_SCOPES` and a comment in `google-calendar.ts`.
No client function, edge function, or chat tool reads
`/freeBusy.query` or any other `calendar.freebusy`-gated endpoint.
**Behavior observed:** The scope is requested at consent time but
covers no callable code path. The Google verification reviewer cannot
demonstrate it from the demo flow because nothing exercises it.
**Behavior expected:** Either a code path that uses
`https://www.googleapis.com/auth/calendar.freebusy` (e.g.
`POST /calendar/v3/freeBusy`) exists, or the scope is removed from
`GOOGLE_SCOPES`.
**Suggested direction:** Drop the scope from `auth.ts:65` and update the
comment at `google-calendar.ts:3` to match. Re-run `runOAuth` to confirm
the consent screen no longer lists it before resubmitting verification.

### F2 — Settings toggle re-enters `runOAuth` on cache desync, revoking ALL refresh tokens [HIGH]

**Where:**
- Precondition check: `src/screens/SettingsScreen.tsx:1604-1610` and the underlying status compute at `src/lib/hooks.ts:2762-2772`
- `unlinkIdentity` call: `src/lib/auth.ts:351`
- Documented "all refresh tokens get revoked" comment: `src/lib/auth.ts:649`

**Repro:**
1. User has Google linked (`auth.identities` contains google) and a
   row in `user_oauth_tokens`.
2. Cold start runs `trySilentRefreshAndBroadcast` (`auth.ts:612`); a
   transient 5xx from `refresh-provider-token` returns null and
   `cachedGoogleToken` stays null.
3. `useAuth().googleAccessToken === null`, so `useConnections` in
   `hooks.ts:2762-2772` reports `gmail`/`google-calendar`/
   `google-drive` as `disconnected`.
4. User taps the Gmail toggle to enable. `handleToggleIntegration`
   sees `parentTokenPresent === false` (line 1607), enters the
   `!parentTokenPresent` branch, and calls `connect('gmail')` →
   `signInWithGoogle()` → `runOAuth('google', GOOGLE_SCOPES)`.
5. Inside `runOAuth`, `linkedIdentity` is truthy (the identity is
   still linked), so `auth.ts:351` calls
   `supabase.auth.unlinkIdentity(linkedIdentity)`.
6. Per the comment at `auth.ts:649`, unlinkIdentity revokes **every**
   refresh token for the user — including Microsoft and any other
   provider.

**Behavior observed:** The toggle's "is this provider connected?"
question is answered against the in-memory access-token cache, which
goes null on any single transient refresh failure. The user only
intended to flip a per-integration switch; instead they wipe their
Microsoft grant and have to re-auth that provider too.

**Behavior expected:** The toggle should only fire `runOAuth` when
the identity is actually unlinked / no `user_oauth_tokens` row
exists. A null access-token cache on a still-linked identity should
trigger a refresh attempt or a re-auth banner, not the unlink-then-
link reconnect dance.

**Suggested direction:** Gate `runOAuth` from this entry point on
`cachedSession.user.identities.find(i => i.provider === 'google')`
being absent (i.e., truly unlinked) rather than on
`googleAccessToken` being null. If the identity is linked but the
cache is empty, route to `startRefresh` and surface the existing
re-auth banner on failure instead of silently entering a destructive
reconnect.

### F3 — Rotated refresh token is silently dropped if `persistRefreshToken` upsert fails [MEDIUM]

**Where:** `supabase/functions/_shared/oauth.ts:138-156`

**Repro:** Microsoft refresh returns a rotated `refresh_token`. The
upsert at `oauth.ts:183-191` fails (transient PG error, `pgbouncer`
restart, RLS regression, anything that returns a non-null `error`).
`ctx.persist` flips to `'failed'` and is logged, but the function
proceeds to `ctx.outcome = 'success'` (line 155) and returns the
fresh access token at line 156. The next refresh ~1 hour later
loads the stale (now-invalidated) refresh_token from
`user_oauth_tokens`, Microsoft returns `invalid_grant`, the user
sees `refresh-rejected` and is forced to fully re-auth.

**Behavior observed:** A successful access-token mint with a failed
DB persist still returns 200 to the client. The lost-rotation event
is observable in logs only via `[oauth-refresh] persist:'failed'`,
not as a return-code signal to the caller.

**Behavior expected:** When Microsoft has rotated the refresh_token
and we cannot persist it, the function should fail loudly — return
500 (or a dedicated 503-style code) so the client doesn't hand out
an access token whose successor refresh-token is already lost.
Better: persist before returning success.

**Suggested direction:** Change `oauth.ts:144-152` so that a failed
persist for a rotated token throws a typed error after logging,
which `refresh-provider-token/index.ts:138-146` can map to a 500.
Google rotation is rare-to-never under our scope set, so this is
mostly a Microsoft-path mitigation, but it costs nothing on Google.

### F4 — No cross-process refresh lock; cron + client can race on Microsoft rotation [MEDIUM]

**Where:**
- Client dedup: `src/lib/auth.ts:568-678` (`googleRefreshInflight` /
  `microsoftRefreshInflight`, `startRefresh`, `tryWithRefresh`)
- Server callers of `refreshAccessToken` outside the per-user edge
  fn: `supabase/functions/poll-mail/index.ts`,
  `supabase/functions/widget-action/provider-write.ts`,
  `supabase/functions/onboarding-backfill-start/index.ts`

**Repro:**
1. The `poll-mail` cron tick runs for user U on a 15-minute schedule
   and hits `refreshAccessToken` to mint a fresh Microsoft token.
2. At the same moment, U opens the app foreground and `tryWithRefresh`
   on a Graph 401 invokes `refresh-provider-token` for `microsoft`.
3. Both reads see the same `refresh_token`. Both POST to Microsoft's
   token endpoint. Microsoft v2 rotates, returning two distinct
   replacement refresh tokens — RT_a and RT_b.
4. Whichever upsert lands last in `user_oauth_tokens` overwrites the
   other. The rotated token whose write lost the race is held only
   in the in-flight HTTP response and is not persisted anywhere.

**Behavior observed:** Client has process-local dedup (the inflight
promises) but there is no per-user lock spanning client ↔ cron ↔
widget-action. Microsoft's grace period for the previous refresh
token usually masks this, but the masked race means a future refresh
that happens to use the losing rotated token will fail with
`invalid_grant`.

**Behavior expected:** Concurrent refresh attempts for the same
(user, provider) either share one mint (advisory lock / SELECT FOR
UPDATE on `user_oauth_tokens`) or accept that we will sometimes
dual-rotate and persist both atomically.

**Suggested direction:** Wrap the load → mint → persist sequence in
`oauth.ts:103-173` with a per-(user, provider) Postgres advisory
lock taken with `pg_try_advisory_xact_lock(hashtext(...))`. If the
lock is held, re-read `user_oauth_tokens` and return whatever the
holder just persisted. Google's no-rotate-by-default behavior means
this is mostly a Microsoft mitigation; Google traffic stays cheap.

### F5 — `getUser()` fetch in edge function has no timeout [LOW]

**Where:** `supabase/functions/refresh-provider-token/index.ts:101`

**Repro:** The Supabase Auth `/auth/v1/user` endpoint hangs (rare,
but real during incidents). Deno's default `fetch` has no timeout,
so the edge function blocks waiting for the auth check, the
function eventually exceeds its execution wall (60s on Edge), the
client sees a generic invocation error from `supabase.functions.
invoke`, and `silentRefresh` returns null.

**Behavior observed:** A slow auth check turns into a hung edge
function rather than a clean fast 401/503 the client can
distinguish from "refresh rejected".

**Behavior expected:** A bounded timeout on the auth probe, after
which the function returns 503 (so the client retries on the next
trigger rather than proactively clearing the cached token).

**Suggested direction:** Wrap the `authClient.auth.getUser()` call
in an `AbortController` with a ~5s deadline. Distinguish `401
unauthorized` (truly bad token) from `503 auth-check-timeout` in
`emitEdgeLog`'s outcome field for log filtering.

### F6 — Edge function persists `updated_at` but no `expires_at` for the new access token [NIT]

**Where:** `supabase/functions/_shared/oauth.ts:177-196` and the
schema-only fields it touches.

**Repro:** `persistRefreshToken` upserts only `user_id, provider,
refresh_token, updated_at`. We never store the access-token expiry.
Today this is fine because the access token is never persisted —
it is returned to the caller and the caller manages it. But it
makes log-based debugging harder: `tokenAgeS` measures how long ago
the row was *updated*, not how recent the live access token is, so
a successful client-side cache hit has no observable record.

**Behavior observed:** `[oauth-refresh] tokenAgeS` reflects refresh-
token row age, not access-token freshness.

**Behavior expected:** Either rename the log field to
`refreshTokenAgeS` to avoid the implication that it is the access
token, or add a parallel `last_access_mint_at` column.

**Suggested direction:** Cheapest fix is the rename. Adding a
column is fine but requires a dashboard migration (memory:
"Memory tables are dashboard-only").

## Adjacent findings (out of scope, noted but not investigated)

- `src/lib/auth.ts:299-298` — `AppState` listener calls
  `supabase.auth.startAutoRefresh()` / `stopAutoRefresh()` on every
  state change without dedup. Probably benign because the Supabase
  client is itself idempotent here, but worth a glance during a
  next-pass auth audit.
- `src/lib/auth.ts:824-834` — `revokeGoogleToken` POSTs the access
  token to `oauth2.googleapis.com/revoke` but ignores both response
  status and JSON body. Per Google docs, `400` is returned for
  already-revoked tokens; we count silent success in either case.
  Acceptable but unobservable.
- `src/screens/SettingsScreen.tsx:1486-1488` — `handleConnect`
  surfaces a `Kunne ikke forbinde` alert on every error including
  user-cancel paths that don't go through `result.cancelled`. Not
  in scope here.
- `microsoftRefreshInflight` and `googleRefreshInflight` (auth.ts:
  568-569) live as module-globals with no cleanup if the user
  signs out mid-flight. Probably fine; flagging only because it's
  the only piece of refresh state that survives `performSignOut`.

## Open questions

- Does Google ever return a rotated `refresh_token` under our
  scope set in practice? Per Google docs the answer is "no for
  installed/native apps unless re-consent occurs." If confirmed
  out-of-band, F3 collapses to a Microsoft-only concern and the
  severity stays MEDIUM.
- F4 assumes the cron's `refreshAccessToken` for Microsoft can
  rotate in parallel with a foreground client. I did not trace
  `poll-mail/index.ts` end-to-end — only confirmed it imports
  `refreshAccessToken`. If `poll-mail` has its own per-user lock,
  the race is narrower.
- The `single_identity_not_deletable` recovery path
  (`auth.ts:362-365`) signs the user fully out of Zolva when their
  only identity is Google. This is correct for the OAuth dance
  but is not surfaced to the user — they will simply find
  themselves at the login screen mid-toggle. Worth a UX-lens
  pass; not a function-lens finding.

## Verification done

- Read end-to-end:
  - `supabase/functions/refresh-provider-token/index.ts` (154 lines)
  - `supabase/functions/_shared/oauth.ts` (278 lines)
  - `src/lib/auth.ts` (993 lines)
  - `src/screens/SettingsScreen.tsx:1356-1650` (Google-toggle window)
  - `src/lib/hooks.ts:2735-2837` (`useConnections`)
- Grepped:
  - `freebusy` / `free_busy` / `freeBusy` / `FreeBusy` across the
    whole repo — only declaration + comment, no callers.
  - `unlinkIdentity` — three sites, all in `auth.ts`; only
    `runOAuth` actually calls it.
  - `tryWithRefresh` callers — confirmed all client-side provider
    clients (`gmail.ts`, `google-calendar.ts`, `microsoft-graph.ts`,
    `onedrive.ts`, `calendar-providers.ts`, `google-drive.ts`)
    funnel through `startRefresh` → `silentRefresh` → edge fn.
  - `refreshAccessToken` server-side — confirmed `poll-mail`,
    `widget-action/provider-write`, `onboarding-backfill-start`,
    and `_shared/calendar.ts` all share the rotation-aware path.
  - `targets/widget/*` — no direct `refresh-provider-token` or
    `refresh_token` references; widget AppIntent does not race
    the client refresh path.
- Did not run typecheck (audit-only, no edits made).
