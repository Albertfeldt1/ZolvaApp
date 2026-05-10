# Audit: Siri voice → calendar event creation

**Auditor:** Claude Opus 4.7 (general-purpose subagent)
**Date:** 2026-05-09
**Time spent:** ~75 min

## Summary

The voice-path is wired end-to-end and the test suite exercises the
happy/permission/oauth-invalid/empty branches well. Calendar selection
does NOT depend on `user_oauth_tokens` row order — it reads the user's
explicit `user_profiles.work/personal_calendar_*` labels — so the
"primary ordering" bug from memory does not apply here. The biggest
real risks are: a 6-second iOS timeout that is shorter than a worst-case
Haiku + provider write, with NO server-side idempotency, which can
produce duplicate or "ghost" events on retry; an OAuth refresh-retry
that uses a stale refresh-token variable and will mis-classify a
concurrent rotation as `oauth_invalid`; and missing schema validation +
NaN-date handling on the Claude tool_use input which can either crash
the handler (uncaught `RangeError`) or write a malformed event. JWT
verification is signature-correct but does not pin algorithm, issuer,
or audience. The Danish AppShortcut phrases are plausible but the
shortcut is generalised ("AskZolva") not calendar-specific, which
mismatches the audit brief's claim and means there is no calendar-only
trigger phrase.

## Findings

### F1 — 6 s client timeout + zero server-side idempotency creates ghost / duplicate events [HIGH]

**Where:** `ios/Zolva/IntentActionClient.swift:46`
**Repro:** User says "Spørg Zolva" → "sæt et møde i morgen kl. 17 i arbejdskalender". Haiku takes 3.5 s, `refreshAccessToken` 1.0 s, Google POST 2.0 s → 6.5 s total. iOS throws `IntentActionError.recoverable("network: ...")` at the 6 s mark, but the server keeps running and Google `events.insert` succeeds at 6.5 s. User hears "Forbindelse fejlede. Prøv igen." and may say the phrase again → second event created with a fresh UID.
**Behavior observed:** `req.timeoutInterval = 6` (line 46). `URLSession` cancels the request and propagates an error to `AskZolvaIntent`'s catch-all (`AskZolvaIntent.swift:59`) which returns the generic "Forbindelse fejlede" snippet. The server has no idempotency key — `widget-action/index.ts` does not accept or generate any client-supplied request ID, and `provider-write.ts` calls Google `POST /events` and Microsoft `POST /events` directly without an idempotency header. iCloud uses a fresh `crypto.randomUUID` per call (`icloud-write.ts:74`), so a retry creates a brand-new VEVENT URL. No row in any table records "I've already started a write for this prompt".
**Behavior expected:** Either (a) the client waits long enough that the server's success can be returned (Siri's typical AppIntent budget is closer to 10 s, hard cap ~30 s), or (b) the server treats a client-supplied dedupe key as idempotent so a retry is a no-op when the original write already landed, or (c) the response is fire-and-forget with confirmation pushed via another channel.
**Suggested direction:** Decide whether the user-visible UX is "wait ≤10 s then either confirm or abandon" and either lengthen the client timeout closer to Siri's actual budget or add a client-generated request ID that the server records before the provider write so retries dedupe.

### F2 — 401-retry reuses stale refresh-token variable instead of re-reading from DB [HIGH]

**Where:** `supabase/functions/widget-action/provider-write.ts:55`
**Repro:** Microsoft user. `poll-mail` cron is mid-rotation (refresh tokens rotate on every Microsoft refresh per the comment in `_shared/oauth.ts:8-13`). Voice path: `loadRefreshToken` reads RT₁ (line 34). First `refreshAccessToken` (line 39) calls Microsoft, gets AT₁ + RT₂, persists RT₂ → success. Microsoft Graph `POST /events` returns 401 (e.g. clock skew, transient). 401-retry (line 55) calls `refreshAccessToken(..., refreshToken)` again — but `refreshToken` is still RT₁, which Microsoft just invalidated by issuing RT₂. Microsoft returns `invalid_grant`. `RefreshRejectedError` is thrown, caught at line 59, response is `oauth_invalid`. User sees "Forbind Outlook igen" even though they are perfectly logged in.
**Behavior observed:** Lines 53-61 reuse the captured `refreshToken` local. `loadRefreshToken` is not re-called between the first refresh (which may have rotated and persisted RT₂) and the retry refresh. Same hazard exists if a concurrent edge-fn (poll-mail, daily-brief, refresh-provider-token) rotates in between; that's the exact race `_shared/oauth.ts:8-13` warns about.
**Behavior expected:** On a 401, the retry should re-load the refresh token from `user_oauth_tokens` to pick up any rotation that happened during or before the first call.
**Suggested direction:** Re-read `loadRefreshToken` inside the 401-retry branch (or factor a single "ensure fresh access token" helper that always reads the DB).

### F3 — No schema validation on Haiku tool_use input; bad ISO crashes the handler [HIGH]

**Where:** `supabase/functions/widget-action/index.ts:185-186` (consuming) and `supabase/functions/widget-action/claude.ts:115-118` (no validation)
**Repro:** Haiku returns `{type:'tool_use', name:'create_calendar_event', input:{title:'møde', start:'tomorrow at 5pm', calendar_label:null, prompt_language:'da'}}` (note: `start` is not a valid ISO string — Haiku occasionally produces natural-language passthroughs). `claude.ts:116` spreads `toolUse.input` into `extraction` without validating. `index.ts:186` runs `new Date(eventExtraction.start).getTime()` → `NaN`, then `new Date(NaN + 3600000).toISOString()` → throws `RangeError: Invalid time value`. The throw is uncaught inside `workerHandler`, the function returns 500 with no body, iOS surfaces "Forbindelse fejlede".
**Behavior observed:** No `Number.isNaN(...getTime())` check on `eventExtraction.start`. The reminder branch at line 131 *does* check `dueAt`. The event branch does not. Beyond the crash: empty/whitespace `title`, hallucinated extra fields, or `start` in the past are all silently accepted. Note `claude.ts:116-118` also assumes `toolUse.input` already conforms to `Omit<ClaudeExtractionEvent,'kind'>` — a type assertion only, no runtime check.
**Behavior expected:** Malformed Claude output should produce the `unparseable` response (`responses.ts:33`), not a 500.
**Suggested direction:** Validate `toolUse.input` shape (title non-empty, start parses to a finite Date, calendar_label in the allowed enum, prompt_language in the allowed enum) before constructing the discriminated union, and treat any miss as `unparseable()`.

### F4 — JWT verification does not pin algorithm, issuer, or audience [MEDIUM]

**Where:** `supabase/functions/widget-action/jwt.ts:20,30`
**Repro:** A token signed with a key fetched via `kid` from the JWKS but whose `iss`/`aud` claims are anything (or absent) is accepted as long as `exp` is future. The JWKS only serves ES256 keys today, so practical signature forgery is bounded — but the function never explicitly asserts `alg === 'ES256'`, never asserts `iss === 'https://auth.zolva.io/auth/v1'`, never asserts `aud === 'authenticated'` (the Supabase default). If Supabase ever issues asymmetric tokens with different audiences (e.g. `service_role`), they would also pass.
**Behavior observed:** `jwtVerify(token, jwks)` is called with no options object. jose's defaults verify the signature against a JWK matched on `kid`+`use`+`kty`, and verify `exp` (no clock tolerance) and `nbf`. It does NOT verify `iss`, `aud`, or restrict `alg`. Comment at `CONTEXT.md` ("we re-verify in the function") implies stricter checks than what's actually wired.
**Behavior expected:** Defense-in-depth: pin algorithm to `ES256`, issuer to the Supabase auth host, audience to `authenticated`. Other edge functions in repo (`icloud-creds-link`, `icloud-creds-revoke`) have the same gap, so the check is tracked here as a feature finding for the voice path.
**Suggested direction:** Pass `{ algorithms: ['ES256'], issuer: 'https://auth.zolva.io/auth/v1', audience: 'authenticated' }` to `jwtVerify`.

### F5 — Voice payload accepts arbitrary timezone with no allowlist [MEDIUM]

**Where:** `supabase/functions/widget-action/index.ts:96`
**Repro:** A caller (or a malformed iOS install with corrupted `TimeZone.current.identifier`) sends `timezone: "Europe/Atlantis"`. `format.ts:33` calls `new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Atlantis', ... })` which throws `RangeError: Invalid time zone specified`. The throw lands inside `workerHandler` after the provider write has already succeeded — Google has the event but the user gets a 500. iCloud writes use the same timezone string only indirectly (the VEVENT is built in UTC), but Google's `start.timeZone` accepts the raw string and would create a `Europe/Atlantis`-tagged event that iOS Calendar app can't render correctly.
**Behavior observed:** No allowlist on `body.timezone`; falls back to `'UTC'` only when missing, not when invalid.
**Behavior expected:** Reject or coerce unknown IANA zones before writing.
**Suggested direction:** Validate `timezone` against `Intl.supportedValuesOf('timeZone')` (or a try/catch around a probe `Intl.DateTimeFormat`) once at the top of the handler.

### F6 — AppShortcut phrases are not calendar-specific; audit claim doesn't match shipped surface [MEDIUM]

**Where:** `ios/Zolva/AskZolvaShortcuts.swift:14-19`
**Repro:** User says "Tilføj til min Zolva-kalender" (the phrase the audit brief claims). Siri does not match — the shipped phrases are `"Spørg \(.applicationName)"`, `"Bed \(.applicationName)"`, `"Sig til \(.applicationName)"`, `"Ask \(.applicationName)"`. None contain "kalender" or "tilføj". The intent is generalized — Siri prompts "Hvad vil du bede Zolva om?" and the user dictates free text. Calendar vs reminder is decided server-side by Haiku.
**Behavior observed:** Generalized 2-turn flow rather than a calendar-only single-shot. The four Danish phrases parse fine grammatically (Spørg/Bed/Sig til + app name) so there's no Danish-grammar bug to flag — but the feature surface is broader than "Siri → calendar" and the brief misnames it. Consequence: there is no faster "say it once" calendar path; every voice action costs one extra Siri prompt round-trip, which adds 1–2 s to the user's wall-clock latency budget — directly compounding F1.
**Behavior expected:** Either (a) the brief should describe the actual generalized intent, or (b) calendar-specific single-shot phrases need a custom AppEntity (out of scope per the inline comment at line 6-10).
**Suggested direction:** Acknowledge in the brief / docs that the shortcut is "AskZolva" not "AddToCalendar"; if a calendar-only shortcut is desired, plan an AppEntity-based single-shot phrase and budget for the metadata-processor restrictions documented in the comment.

### F7 — Server creates events with empty title without rejecting [LOW]

**Where:** `supabase/functions/widget-action/index.ts:194` (passes `title` straight through)
**Repro:** User says "møde". Haiku returns `title: ''` (or one whitespace char). No check; Google receives `summary: ''` and creates a "(No title)" event. Dialog reads "Tilføjet: '', i morgen kl. sytten i din arbejdskalender."
**Behavior observed:** No `title.trim()` non-empty guard; `claude.ts:116` trusts the model.
**Behavior expected:** Empty title should fall through to `unparseable()` or to a default like "Begivenhed".
**Suggested direction:** Trim and length-check `eventExtraction.title` before the write; on empty, return `unparseable()`.

### F8 — `start` in the past silently accepted [LOW]

**Where:** `supabase/functions/widget-action/index.ts:185`
**Repro:** "sæt et møde i går kl. 17". Haiku resolves to a yesterday-ISO. Server creates the event in the past (Google/MS/iCloud all accept past times). User hears the success dialog with `naturalTime` (which can render `den 8. maj kl. sytten` correctly even for past dates because the >7-day fallback path activates on `dayDelta < 0`? actually `format.ts:53` only triggers the relative branch for `0 ≤ dayDelta ≤ 7`, so negative deltas fall to `absoluteSpelled`). User got a past event with the same wording style; not obvious it's in the past.
**Behavior observed:** No "is the start in the past" check.
**Behavior expected:** A clear "kunne ikke sætte møde i fortiden" or auto-shift to next valid slot.
**Suggested direction:** If `start < now - tolerance`, return `unparseable()` with a more specific dialog string.

### F9 — Microsoft permission_denied path leaks calendar GUID when name lookup fails [LOW]

**Where:** `supabase/functions/widget-action/provider-write.ts:158`, `responses.ts:60`
**Repro:** Microsoft returns 403 on `POST /events`. `lookupMicrosoftCalendarName` runs but also 403s (or the access token expired between lookups). The catch falls back to `args.calendarId`, which is the raw Graph GUID like `AAMkAGI2...`. `permissionDenied` then returns dialog "Du har ikke skriverettigheder til AAMkAGI2..." which Siri tries to read aloud.
**Behavior observed:** Lookup falls back to the GUID; the Danish dialog reads the GUID character-by-character.
**Behavior expected:** A friendly fallback ("din arbejdskalender") rather than the raw GUID.
**Suggested direction:** If the lookup fails, use a generic Danish/English label rather than the calendar id.

### F10 — `extractAction` accepts unparsed `tool_use.input` when fields are present-but-wrong-type [LOW]

**Where:** `supabase/functions/widget-action/claude.ts:115-121`
**Repro:** Haiku returns `{name:'create_calendar_event', input:{title:42, start:'2026-05-10T17:00:00+02:00', calendar_label:'shared', prompt_language:'da'}}`. The spread at line 116 produces `extraction.title = 42` (a number). `index.ts:194` sends `summary: 42` to Google. Google may accept (it stringifies) or reject. Either way, downstream code in `index.ts` treats `eventExtraction.title` as a string when interpolating into the dialog, producing `"Tilføjet: '42'"`.
**Behavior observed:** TypeScript only protects at compile time; the runtime trust boundary is the model output. There is no `typeof === 'string'` check.
**Behavior expected:** Type-validate every field in the `tool_use.input` before consuming.
**Suggested direction:** Same as F3 — a single zod-shaped runtime validator on the tool_use input.

### F11 — `widget-action` deploy flag is undocumented in repo (only inferred via JWKS verification path) [NIT]

**Where:** `supabase/functions/widget-action/index.ts:1-2` (only mentions logging retention)
**Repro:** Onboarding engineer running `supabase functions deploy widget-action` without `--no-verify-jwt` will see all voice calls 401 at the gateway because the project uses ES256 keys. Other edge fns in repo carry an explicit comment ("Deploy with --no-verify-jwt"), e.g. `icloud-creds-link/index.ts:7`. `widget-action/index.ts` does not.
**Behavior observed:** Missing comment; missing entry in `supabase/README.md`.
**Behavior expected:** Same deploy-comment convention as siblings.
**Suggested direction:** Add the standard deploy comment near the top of `widget-action/index.ts`.

## Adjacent findings (out of scope, noted but not investigated)

- `_shared/oauth.ts` does not enforce a max in-flight refresh per user/provider — concurrent edge fns rotating Microsoft tokens within the same second can stomp each other (mitigated by the upsert on user_id+provider but not by serialization).
- `icloud-creds-link/index.ts`, `icloud-creds-revoke/index.ts` share the same JWT-verification gap (no algorithm/iss/aud pinning) noted in F4.
- `format.ts:53` uses `dayDelta >= 0 && dayDelta <= 7` so negative deltas (events in the past) fall to `absoluteSpelled` — that's a UX mis-render coupled to F8 above.
- The success dialog includes a single-quoted title that is never escaped: `dialog = ``Tilføjet: '${eventExtraction.title}', ...```. A Haiku-emitted title containing `'` doesn't break anything but reads awkwardly to Siri.
- `IntentActionClient.swift:60` treats every non-200 (other than 401) as `IntentActionError.recoverable` — the user always sees "Forbindelse fejlede. Prøv igen." without distinguishing 5xx from 4xx body-validation errors.

## Open questions

- Real-world latency distribution of Haiku + Google `events.insert` end-to-end: is the 6 s client timeout actually triggering for live users, or is it only theoretical? Production logs would tell — out of scope for static read.
- Does Siri's AppIntent budget actually clamp at ~10 s as documented, or did Apple loosen this in iOS 17/18? An iOS engineer running the live shortcut with longer-than-6s server delay would settle F1's severity.
- For Microsoft 401-retry (F2) — does Microsoft's old refresh token retain a grace window that empirically saves the retry? Need a one-shot test against a Microsoft-connected account.
- iCloud calendar URL trust: `args.calendarUrl` (= `user_profiles.personal_calendar_id` for an iCloud user) is fully user-controlled at write-time. If a user can be coerced to set `personal_calendar_id` to an arbitrary `https://*.caldav.icloud.com/...` URL via a redirected onboarding flow, the voice path PUTs there. `icloud-creds-link/index.ts:73-82` validates URLs at link time but not the field used here. Did not chase — out of scope for the voice feature alone.

## Verification done

- Read end-to-end:
  - `supabase/functions/widget-action/index.ts`
  - `supabase/functions/widget-action/jwt.ts`
  - `supabase/functions/widget-action/claude.ts`
  - `supabase/functions/widget-action/select-calendar.ts`
  - `supabase/functions/widget-action/provider-write.ts`
  - `supabase/functions/widget-action/icloud-write.ts`
  - `supabase/functions/widget-action/format.ts`
  - `supabase/functions/widget-action/responses.ts`
  - `supabase/functions/widget-action/index.test.ts`
  - `supabase/functions/widget-action/format.test.ts`
  - `supabase/functions/widget-action/select-calendar.test.ts`
  - `supabase/functions/refresh-provider-token/index.ts`
  - `supabase/functions/_shared/oauth.ts`
  - `supabase/functions/_shared/icloud-creds.ts`
  - `supabase/functions/_shared/calendar.ts` (skim — context for refresh + scope comparison)
  - `ios/Zolva/AskZolvaShortcuts.swift`
  - `ios/Zolva/AskZolvaIntent.swift`
  - `ios/Zolva/IntentActionClient.swift`
  - `ios/Zolva/SupabaseAuthClient.swift`
  - `ios/Zolva/SupabaseSession.swift`
  - `ios/Zolva/AskZolvaSnippetView.swift`
- Code paths traced:
  - happy path: AppIntent → SupabaseSession.readAccessToken → IntentActionClient.postOnce → workerHandler → verifyJwt → extractAction → readLabels → selectCalendar → writeEvent (Google branch, refresh+POST) → naturalTime → dialog → response
  - 401 retry: postOnce 401 → SupabaseAuthClient.refresh (race-loss fallback) → second postOnce
  - server 401 retry: provider-write postEvent 401 → second refreshAccessToken (uses captured `refreshToken`!) → second postEvent
  - reminder branch: Haiku returns `create_reminder` → reminders insert
  - iCloud branch: writeIcloud → loadIcloudCreds (RPC decrypt) → CalDAV PUT
  - Microsoft scope chain: client onboarding scopes (`auth.ts:76-85`) vs widget-action refresh scope (`Calendars.ReadWrite`) vs daily-brief scope (`Calendars.Read`) vs refresh-provider-token scope
- Cross-checked test fixtures in `index.test.ts` against handler control flow.
- No commands run beyond `grep`/`ls`/`Read`. No typecheck (per CONTEXT note about pre-existing `hooks.ts:4807` error).
