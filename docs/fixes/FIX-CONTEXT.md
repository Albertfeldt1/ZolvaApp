# Zolva fix — shared context packet

Paste this verbatim at the top of every fix terminal, then append
the specific fix prompt (`fix-01-...md` etc.) below it.

## What Zolva is

Danish-language personal-assistant app. Daily morning briefs over
the user's mail + calendar, an AI chat that can read/write across
providers (Gmail, Outlook, iCloud Mail, Google Calendar, Outlook
Calendar, iCloud CalDAV, Drive, OneDrive), opt-in long-term memory
(facts/notes/reminders), and an iOS home-screen widget. Stone is
the mascot.

## Stack

- **Client**: Expo (React Native), TypeScript, Reanimated,
  expo-router-free (manual screen routing in `App.tsx`).
- **Backend**: Supabase (Postgres + RLS, Auth with asymmetric ES256
  JWT, Edge Functions on Deno, Realtime).
- **AI**: Claude API. Default model is Opus 4.7. Chat round 0 runs
  server-side via the `chat-run` edge fn; tool turns finish on the
  client.
- **Auth providers**: Apple Sign-In, Google OAuth (via Supabase
  broker), Microsoft OAuth (via Supabase broker), iCloud
  (app-specific password stored encrypted in Supabase).

## Conventions you must respect

- **Memory tables** (`facts`, `mail_events`, `chat_messages`,
  `daily_briefs`, `reminders`, etc.) have **no migrations in repo**
  — schema is dashboard-managed. The `briefs` migration is a known
  exception. Use `src/lib/profile-store.ts` and the edge functions
  as the schema source of truth.
- **`facts.status`** is `'pending' | 'confirmed' | 'rejected'` —
  NOT `'accepted'`.
- **Edge fns that hit user data** must be deployed with
  `--no-verify-jwt` (we re-verify in the function) because
  Supabase's ES256 JWT trips the gateway's default verifier.
  Specifically: `chat-run`, `refresh-provider-token`,
  `widget-action`, `imap-proxy`, `icloud-creds-link`. Do NOT add
  `--no-verify-jwt` to cron-secret-authed fns
  (`daily-brief`, `fact-decay-warning`, `poll-mail`).
- **Provider tokens** live in `user_oauth_tokens` and are minted
  via the Supabase OAuth broker. Never hardcode.
- **Unified IDs** (across chat tools):
  - `google:<calendarId>::<eventId>` for Google calendar events.
    Legacy `google:<eventId>` falls back to `primary`.
  - `microsoft:<id>` for Outlook events.
  - `icloud:<uid>` for iCloud events / mail.
- **OAuth toggle ≠ OAuth start**: integration toggles only fire
  `runOAuth` when the identity isn't linked. The correct
  precondition is `cachedSession.user.identities`, not in-memory
  token caches. Never call `unlinkIdentity` inside a refresh
  path — it revokes ALL refresh tokens for the user.
- **OTA channel `production` ships from `main`**. Builds and
  updates require merging to `main` first.
- **Solo project, no formal PR review.** Make surgical changes.

## Branching — read this twice

Before any other work, confirm the repo's default branch is set
correctly:

    git remote show origin | grep "HEAD branch"

Must report `HEAD branch: main`. If it reports anything else
(especially `feature/notifications`), STOP and tell the human. They
need to run `git remote set-head origin main` in the primary repo.
Do not work around this by manually checking out main inside the
worktree — fresh worktrees will keep defaulting to the wrong base
until the remote is repointed.

Recent audit work hit a recurring issue: worktrees were branched
from `origin/feature/notifications`, which is **behind `main`** and
missing significant features (`chat-run`, `daily-brief`,
`fact-decay-warning`, iCloud edge fns, etc.).

**Before doing anything, verify:**

```bash
git status
git rev-parse --abbrev-ref HEAD
git log --oneline -1
git fetch origin
git log --oneline origin/main -1
```

You must be on `main` or a fresh branch off `origin/main`. If
you're on `feature/notifications` or any branch that doesn't
contain the code paths the fix prompt references, STOP and tell the
human. Do NOT silently `git reset --hard` to a different base — the
human needs to know the worktree config is wrong so they can fix it
permanently.

If you've seen the wrong-base issue across multiple worktrees, the
root cause is `origin/HEAD` pointing at the wrong branch (not the
worktree itself being broken). Tell the human to run
`git remote set-head origin main` in the primary repo, not just to
recreate the worktree.

## Where things live

- `src/screens/` — top-level screens (Today, Inbox, Chat, Calendar,
  Memory, Settings).
- `src/components/` — cross-screen UI primitives.
- `src/lib/hooks.ts` — **5200+ line monolith** containing most React
  hooks, the chat orchestrator (`useChat`), inbox/calendar/observation
  hooks, the chat system prompt builder, the chat tool registry, and
  a lot of non-hook utilities. Be specific with line numbers; grep
  by function name.
- `src/lib/chat-tools.ts` — server-call layer for chat tools.
- `src/lib/google-calendar.ts`, `microsoft-graph.ts`,
  `icloud-calendar.ts`, `gmail.ts`, `icloud-mail.ts` — provider
  clients.
- `src/lib/auth.ts` — Supabase auth + OAuth orchestration, identity
  linking, token broker calls.
- `src/lib/profile-store.ts` — facts/notes/reminders read/write +
  schema reference.
- `src/lib/notifications.ts` — Expo push registration, notification
  feed, cold-start notification recovery.
- `supabase/functions/<name>/index.ts` — edge functions.
  `_shared/` holds cross-fn helpers.
- `migrations/` — schema migrations (sparse — most schema is
  dashboard-managed).
- `targets/widget/` — iOS home-screen widget (Swift).
- `plugins/voice-intents/` — Siri AppShortcuts (Swift).

## Build / verify commands

- `npx tsc --noEmit` — typecheck. **There is a pre-existing error
  at roughly `src/lib/hooks.ts:4807`** (`Type 'string' is not
  assignable to type 'TurnResult'`). Ignore it. Any *additional*
  error you introduce IS your concern.
- No unit-test runner is wired up. Don't add one.
- `npx expo start` to run dev (requires a dev build, NOT Expo Go,
  for OAuth/Apple Sign-In flows).
- Edge fn deploy: `supabase functions deploy <name>` — add
  `--no-verify-jwt` for the user-auth fns listed above.
- Supabase project ref: `sjkhfkatmeqtsrysixop` (production).

## Fix anti-goals — read these twice

- **Fix only what the prompt asks for.** No scope creep. If you
  spot adjacent issues, write them up at the end of your output
  but do not touch them.
- **No refactoring.** Even if a function is 400 lines, leave it.
  Surgical change only.
- **No new tests.** No test framework exists; introducing one is a
  separate decision.
- **No dependency upgrades.**
- **No UI/UX polish** unless the prompt explicitly asks for it.
- **Do not run destructive commands.** No `git checkout HEAD --`,
  no `rm`, no `supabase db reset`, no `eas update`, no
  `eas build`, no `git push --force`.
- **Do not deploy.** The human ships. Even if a fix obviously
  needs a redeploy, just say so in your output.
- **Do not apply DB migrations yourself.** Write the migration
  file if needed, then stop. Human applies it via Supabase
  dashboard or CLI.

## When to stop and ask

Each fix prompt lists specific stop conditions ("if the audit is
stale, stop", "if both paths look high-risk, stop"). Honor them.
Additionally, stop and ask if:

- The code you find doesn't match what the prompt assumes (audit
  may be stale or you may be on the wrong branch).
- The fix would touch more than ~3 files.
- The fix would change a public function's signature.
- You're uncertain whether your change is correct under
  concurrency, cold start, or auth failure.

A clean "I stopped because X" is more useful than a shipped fix
that introduces a worse bug. Solo project means there's no second
reviewer — your stop conditions ARE the review.

## Output format

End every session with:

1. **What changed** — files + line ranges, one sentence each.
2. **Manual trace** — walk through the failure scenario from the
   prompt. Be specific about what the user sees at each step.
3. **What I did NOT change** — adjacent issues you noticed but
   didn't fix.
4. **Followups for the human** — deploys, migrations to apply,
   GCP console edits, anything outside this terminal's reach.
5. **Confidence** — high / medium / low, and why.
