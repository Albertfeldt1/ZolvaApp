# Notifications — Server Push for New Emails (Sub-project 3)

**Date:** 2026-04-20
**Status:** Partial — client-side shipped this session; backend wiring deferred (see Gaps).
**Scope:** Sub-project 3 of the notifications roadmap. Subsumes what was previously labeled "server push for new emails."

## Roadmap context

Sub-project 1 (local scheduled) and 2 (in-app feed) shipped. This sub-project introduces remote push for new emails: when a user receives mail in Gmail or Outlook, they get an Expo push notification that taps through to the Inbox. It also introduces the first backend-side code in the project (Supabase migrations + Edge Functions).

## Goals

A user can:

- Toggle "Nye mails" in Settings; enabling registers the device for Expo push and persists the token server-side.
- Receive a push notification when a new email arrives, even while the app is backgrounded or closed.
- Tap the push to land on the Inbox tab.
- See the new-mail entry in the in-app notification center.

Non-goals:

- Smart filtering of which emails are worth notifying (ship on every new arrival for v1).
- Per-account granularity (one toggle for all connected inboxes).
- iOS app-icon badge management tied to unread count.

## What ships this session

Client-side and backend scaffolds only.

- **Client push token registration:** `src/lib/push.ts` fetches an Expo push token via `expo-notifications` and upserts it into a Supabase `push_tokens` table. Runs when the user enables "Nye mails" in Settings.
- **Toggle:** `notification-settings.ts` gains a `newMail: boolean` field; Settings screen exposes it.
- **Payload + feed wiring:** `NotificationPayload` gains a `newMail` variant with `provider`, `messageId`, and optional `threadId`. Tap routes to Inbox. Feed shows an `Mail` icon row.
- **Supabase migration:** `supabase/migrations/20260420000000_notifications.sql` creates `push_tokens` and `mail_watchers` with RLS.
- **Edge function scaffold:** `supabase/functions/poll-mail/index.ts` is a working Deno template that reads watcher rows, calls Gmail/Graph, and dispatches Expo pushes. The access-token lookup is stubbed — see Gaps below.

## Gaps (explicit deferrals)

1. **Provider refresh tokens not captured server-side.** The current OAuth flow (`src/lib/auth.ts:209-228`) reads `provider_token` (access token) from `exchangeCodeForSession` and stores it in AsyncStorage. `provider_refresh_token` — which Supabase returns for Google OAuth when `access_type=offline&prompt=consent` — is not captured. Without a refresh token, the backend cannot mint fresh access tokens to call Gmail/Graph after the initial token expires (Google: 1h, Microsoft: typically 1h).

   **What needs doing:** extend auth.ts to read `provider_refresh_token` from the exchange response and upsert it into a new `user_oauth_tokens` table (user_id, provider, refresh_token, encrypted). The Edge Function then reads from that table.

2. **pg_cron schedule.** The Edge Function is not scheduled. Needs a dashboard step:

   ```sql
   select cron.schedule(
     'poll-mail-every-2min',
     '*/2 * * * *',
     $$select net.http_post(
       url := 'https://<project>.functions.supabase.co/poll-mail',
       headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
     )$$
   );
   ```

3. **Mail-watcher bootstrap.** A row in `mail_watchers` needs to exist for each user+provider pair the first time the user connects. Easy follow-up: when `signInWithGoogle`/`signInWithMicrosoft` succeeds, insert a watcher row via Supabase client. Not done this session.

4. **Manual end-to-end test.** Not possible until (1), (2), and (3) are done.

## Architecture

### Client side

```
SettingsScreen "Nye mails" toggle
         │
         ▼
 setNotificationSetting('newMail', true)
         │
         ├── ensurePermission() (reuses sub-project 1)
         └── registerPushToken()
                │
                ├── Notifications.getExpoPushTokenAsync({projectId})
                └── supabase.from('push_tokens').upsert({user_id, token, platform})
```

Disabling the toggle calls `unregisterPushToken()` which deletes the row.

### Server side (target architecture, scaffolded)

```
pg_cron (every 2 min)
         │
         ▼
  poll-mail Edge Function
         │
         ├── select * from mail_watchers where enabled
         │        join user_oauth_tokens
         ├── for each: refresh access token, call history.list / delta
         ├── for each new message: insert into mail_pushes
         │        (dedupe), then POST to exp.host/--/api/v2/push/send
         └── update mail_watchers.last_history_id / last_delta_link
```

### New payload type

```ts
type NotificationPayload =
  | { type: 'reminder'; reminderId: string }
  | { type: 'digest'; date: string }
  | { type: 'calendarPreAlert'; eventId: string }
  | { type: 'reminderAdded'; reminderId: string }
  | { type: 'newMail'; provider: 'google' | 'microsoft'; messageId: string; threadId?: string };
```

Tap routing: `newMail` → Inbox tab. We don't open InboxDetailScreen automatically because the push only carries IDs, not a hydrated `InboxMail`.

## Data model

### `push_tokens`

| column | type | notes |
|---|---|---|
| id | uuid primary key default gen_random_uuid() | |
| user_id | uuid references auth.users(id) on delete cascade | |
| token | text not null | Expo push token (`ExponentPushToken[...]`) |
| platform | text | `ios` / `android` / `web` |
| device_id | text | optional — same device re-registers cleanly via unique(user_id, token) |
| created_at | timestamptz default now() | |
| last_seen_at | timestamptz default now() | bumped on re-register |

Unique index on `(user_id, token)`. RLS: user can read/write their own rows.

### `mail_watchers`

| column | type | notes |
|---|---|---|
| user_id | uuid references auth.users(id) on delete cascade | |
| provider | text check (provider in ('google','microsoft')) | |
| enabled | boolean default true | mirrors `newMail` toggle — set server-side from the client |
| last_history_id | text | Gmail `historyId` watermark |
| last_delta_link | text | Graph delta link watermark |
| last_polled_at | timestamptz | |
| created_at | timestamptz default now() | |

Primary key `(user_id, provider)`. RLS: user can read/write their own rows. Edge Function uses service role key to bypass RLS.

## Edge Function behavior (target)

`supabase/functions/poll-mail/index.ts`:

1. Authenticate via bearer service-role key (cron).
2. For each `mail_watchers` row with `enabled = true`:
   a. Fetch refresh token from `user_oauth_tokens` (TODO — stubbed).
   b. Exchange for a fresh access token against Google/Microsoft's token endpoint.
   c. Call:
      - Google: `GET /gmail/v1/users/me/history?startHistoryId=<last>` — extract `messagesAdded`.
      - Microsoft: `GET /me/mailFolders/Inbox/messages/delta?$deltatoken=<last>` — extract new items.
   d. For each new message:
      - Insert into `mail_pushes` for idempotency (future migration — not in scope this session).
      - POST to `https://exp.host/--/api/v2/push/send` with `{to: token, title, body, data: {type:'newMail', provider, messageId, threadId}}` for each of the user's active `push_tokens`.
   e. Update `last_history_id` / `last_delta_link` and `last_polled_at`.
3. Swallow per-user errors; return 200 with per-user status summary.

## Error handling

| Scenario | Behavior |
|---|---|
| No session when user toggles on | Toggle reverts; banner "Log ind først". |
| Permission denied | Same behavior as sub-project 1 — toggle stays off, show settings-deeplink banner. |
| Expo token fetch fails | Toggle stays off; log in `__DEV__`. |
| Supabase upsert fails | Toggle stays off; show "Kunne ikke registrere enheden"; log. |
| Tap on newMail push when Supabase session expired | Still routes to Inbox tab; inbox fetch will re-auth or show empty state. |
| Refresh token missing server-side | Edge Function skips that user with a logged warning. |

## Testing strategy

Manual against a dev build. Can't validate the full loop until gaps (1)-(3) are resolved.

Shippable-this-session checklist:

- Enabling "Nye mails" after granting permission yields a row in `push_tokens` (verify in Supabase dashboard).
- Disabling removes the row.
- Registering on the same device twice upserts; the row count stays at 1.
- Signing out / into a different account registers under the correct `user_id`.
- A manually inserted feed entry with type `newMail` renders the mail icon and routes to Inbox when tapped.

End-to-end (post-gap-resolution):

- Send mail to a connected Gmail; within 2 min, a push arrives on the device.
- Tap the push; app opens Inbox tab.
- Disable the toggle; new mail no longer pushes.

## Open implementation details

- Should mail pushes use a single batched title ("3 nye mails") vs. one per message? v1 ships per-message; batching is a v2 choice.
- iOS app icon badge count — deferred.
- Expo EAS projectId — needs to be set once a proper Expo project is linked. Until then, push token fetch requires `projectId` param. I'll read it from `Constants.expoConfig.extra.eas.projectId` and no-op if absent.
