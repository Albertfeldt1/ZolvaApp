# Zolva audit — shared context packet

Paste this verbatim at the top of every audit terminal, then append the
filled-in per-feature brief from `TEMPLATE.md`.

## What Zolva is

Danish-language personal-assistant app. Daily morning briefs over the
user's mail + calendar, an AI chat that can read/write across providers
(Gmail, Outlook, iCloud Mail, Google Calendar, Outlook Calendar, iCloud
CalDAV, Drive, OneDrive), opt-in long-term memory (facts/notes/
reminders), and an iOS home-screen widget. Stone is the mascot.

## Stack

- **Client**: Expo (React Native), TypeScript, Reanimated, expo-router-
  free (manual screen routing in `App.tsx`).
- **Backend**: Supabase (Postgres + RLS, Auth with asymmetric ES256
  JWT, Edge Functions on Deno, Realtime).
- **AI**: Claude API. Default model is Opus 4.7. The chat round 0 runs
  server-side via the `chat-run` edge fn; tool turns finish on the
  client.
- **Auth providers**: Apple Sign-In, Google OAuth (via Supabase
  broker), Microsoft OAuth (via Supabase broker), iCloud (app-specific
  password stored encrypted in Supabase).

## Conventions you must respect

- **Memory tables** (`facts`, `mail_events`, `chat_messages`,
  `daily_briefs`, `reminders`, etc.) have **no migrations in repo** —
  schema is dashboard-managed. Use `src/lib/profile-store.ts` and the
  edge functions as the schema source of truth.
- **`facts.status`** is `'pending' | 'confirmed' | 'rejected'` — NOT
  `'accepted'`. Confirming sets `confirmed_at`; rejecting sets
  `rejected_at` + `rejection_ttl` (14 days).
- **Edge fns that hit user data** must be deployed with
  `--no-verify-jwt` (we re-verify in the function) because Supabase's
  ES256 JWT trips the gateway's default verifier.
- **Provider tokens** live in `user_oauth_tokens` and are minted via
  the Supabase OAuth broker. They are NOT in `.env`. Never hardcode.
- **Unified IDs** (used across chat tools):
  - `google:<calendarId>::<eventId>` for Google calendar events.
    Legacy `google:<eventId>` falls back to `primary`.
  - `microsoft:<id>` for Outlook events.
  - `icloud:<uid>` for iCloud events / mail.
- **OAuth toggle ≠ OAuth start**: integration toggles only fire
  `runOAuth` when no provider token is present. Never call
  `unlinkIdentity` inside a refresh path — it revokes ALL refresh
  tokens for the user.
- **OTA channel `production` ships from `main`**. Builds (`eas build`)
  and updates (`eas update`) require the work to be merged to `main`
  first.
- **Solo project, no formal PR review.** Findings should be specific
  enough that a single engineer can act on them without a meeting.

## Where things live

- `src/screens/` — top-level screens (Today, Inbox, Chat, Calendar,
  Memory, Settings, Onboarding\*).
- `src/components/` — cross-screen UI primitives.
- `src/lib/hooks.ts` — **5200+ line monolith** containing most React
  hooks, the chat orchestrator (`useChat`), inbox/calendar/observation
  hooks, the chat system prompt builder (`buildChatSystemPrompt`), the
  chat tool registry (`CHAT_TOOLS`), and a lot of non-hook utilities.
  Be specific with line numbers — grepping by function name is
  reliable.
- `src/lib/chat-tools.ts` — server-call layer for chat tools (calendar
  + mail + drive write/read across providers).
- `src/lib/google-calendar.ts`, `microsoft-graph.ts`,
  `icloud-calendar.ts`, `gmail.ts`, `icloud-mail.ts` — provider clients.
- `src/lib/auth.ts` — Supabase auth + OAuth orchestration, identity
  linking, token broker calls.
- `src/lib/profile-store.ts` — facts/notes/reminders read/write +
  schema reference.
- `src/lib/notifications.ts` — Expo push registration, notification
  feed, cold-start notification recovery.
- `supabase/functions/<name>/index.ts` — edge functions. `_shared/`
  holds cross-fn helpers (calendar, icloud, oauth, backfill).

## Build / verify commands

- `npx tsc --noEmit` — typecheck. **Note:** there is a pre-existing
  error at roughly `src/lib/hooks.ts:4807` (`Type 'string' is not
  assignable to type 'TurnResult'`) that is unrelated to recent work
  and unrelated to your audit. Ignore it. Any *additional* error you
  introduce or discover IS your concern.
- No unit-test runner is wired up. Don't add one.
- `npx expo start` to run dev (requires a dev build, NOT Expo Go, for
  OAuth/Apple Sign-In flows).
- Edge fn deploy: `supabase functions deploy <name>` — add
  `--no-verify-jwt` for user-auth fns.
- Supabase project ref: `sjkhfkatmeqtsrysixop` (production).

## Audit anti-goals — read these twice

- **Flag findings; do not fix.** No edits to source unless explicitly
  asked. The output of an audit is a finding, not a PR.
- **No refactoring.** Even if a function is 400 lines, leave it.
- **No new tests.** No test framework exists; introducing one is a
  separate decision.
- **No dependency upgrades.**
- **No UI/UX polish recommendations** unless the lens is explicitly
  UX. Default lens is *function* — does the feature do what it claims
  to do, correctly, under realistic conditions?
- **Do not touch unrelated code.** If you find an issue outside your
  feature's scope, note it under "Adjacent findings" but do not
  follow it.
- **Do not run destructive commands.** No `git checkout HEAD --`, no
  `rm`, no `supabase db reset`, no `eas update`.

## What "function audit" means here

For each feature, answer these in order:

1. **Does it actually do what it claims?** Trace one realistic user
   path end-to-end. Flag every step where the code can silently fail,
   return wrong data, or hallucinate success.
2. **What happens at boundaries?** Cold start, backgrounded app,
   network drop, expired token, empty input, multiple users on the
   same device, demo mode.
3. **Are tool/provider responses interpreted correctly?** E.g.,
   does an empty list mean "no data" or "auth failed"? Does the code
   distinguish?
4. **Are unified IDs consistent across read/write paths?**
5. **Is state persisted where the user expects it to be?** A "done"
   action that resets on relaunch is a bug regardless of how nice the
   animation is.
6. **Are there race conditions on dependent state?** Especially
   around the chat (round 0 vs round 1 vs finalize), token refresh,
   and onboarding persistence.

## Output format

Use the template in `TEMPLATE.md`. Findings must be:

- Severity-tagged: `BLOCKER` / `HIGH` / `MEDIUM` / `LOW` / `NIT`.
- Anchored to `path/to/file.ts:LINE` (line numbers required for
  HIGH/BLOCKER).
- Reproducible: one-line repro or trace describing the input that
  triggers the failure.
- Specific: "the model can hallucinate X" is not a finding;
  "`buildChatSystemPrompt` lacks rule Y so model produces Z under
  input W" is.

Time-box: 60–90 minutes per feature. If you can't finish, leave
"Open questions" populated and stop — the audit is more useful with a
known cutoff than with rushed coverage.
