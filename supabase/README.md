# Supabase — deploy runbook for phase 3 (push mail)

The code in this folder is only active once it's deployed to the Supabase
project. Follow these steps once, in order. All commands run from the repo
root and assume the Supabase CLI is authenticated to the project
(`supabase login` and `supabase link --project-ref <ref>` already done).

## 1. Apply migrations

```
supabase db push
```

Applies:

- `20260420000000_notifications.sql` — `push_tokens`, `mail_watchers`
- `20260420010000_user_oauth_tokens.sql` — `user_oauth_tokens`

## 2. Set function secrets

The `poll-mail` function refreshes OAuth tokens directly against the
provider token endpoints, so it needs the OAuth client credentials that
Supabase already has in the dashboard. Copy them into function env:

```
supabase secrets set \
  GOOGLE_OAUTH_CLIENT_ID=<same as dashboard> \
  GOOGLE_OAUTH_CLIENT_SECRET=<same as dashboard> \
  MICROSOFT_OAUTH_CLIENT_ID=<same as dashboard> \
  MICROSOFT_OAUTH_CLIENT_SECRET=<same as dashboard> \
  MICROSOFT_OAUTH_TENANT=common
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. Deploy the function

```
supabase functions deploy poll-mail
```

The function authenticates via the service role key from the bearer header
the scheduler sends, so leave JWT verification on.

## 4. Schedule the cron

Run this SQL in the dashboard SQL editor (once). It needs the `pg_cron`
and `pg_net` extensions enabled (both available in hosted Supabase —
enable under Database → Extensions if not on).

Replace `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>`. Treat the service role
key as a secret — the pg_cron row is visible to anyone with DB admin.

```sql
select cron.schedule(
  'poll-mail-every-2min',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.functions.supabase.co/poll-mail',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    )
  ) as request_id;
  $$
);
```

To unschedule later:

```sql
select cron.unschedule('poll-mail-every-2min');
```

## 5. First-run verification

After deploy + schedule, sign in to the app (fresh session, so the
refresh-token capture fires), connect Gmail or Outlook, and enable the
"Nye mails" toggle in Settings. Then:

1. Check `user_oauth_tokens` has your row (refresh_token populated).
2. Check `mail_watchers` has a row with `enabled = true`.
3. Check `push_tokens` has your device token.
4. Send yourself an email.
5. Within ~2 minutes, a push notification should arrive. Tapping it
   opens the Inbox tab.
6. Inspect function logs: `supabase functions logs poll-mail --tail`.

## Troubleshooting

- **`no refresh token — complete auth.ts capture first`** — you signed in
  before the refresh-token capture code landed. Sign out and back in.
- **`google refresh failed: 400`** — client_id/secret mismatch with what
  Supabase holds, or the refresh token was revoked. Re-auth to get a new
  one.
- **No push arrives, no function error** — the watcher's `last_history_id`
  is initialized on the first successful run; the first poll records the
  watermark but doesn't push anything older than that. Send a fresh mail
  after the first poll completes.
- **iOS simulator** — Expo push tokens don't work on the iOS simulator.
  Test on a real device.
