# Security hardening — owner action guide

Written 2026-06-07 after a full external-attack-surface audit. Part 1 lists what I
already fixed in code (for your reference). Part 2 is the step-by-step list of
things **only you can do** (Supabase dashboard, Google Cloud Console, local
machine) — ordered by priority.

Project ref: `sjkhfkatmeqtsrysixop`.

---

## Part 1 — Already fixed in code (shipped this pass)

| Fix | Where | Status |
|-----|-------|--------|
| Reject unknown `model` + clamp `max_tokens` (≤8192) on the chat proxies | `_shared/model-guard.ts` → `claude-proxy`, `chat-run` | deployed |
| `record_ai_usage` self-only guard (`auth.uid()=p_user_id`) | migration `…160000` | applied |
| Block the client from reading stored `refresh_token` (column-level SELECT) | migration `…161000` on `user_oauth_tokens` | applied — **verify on device, see 2.4** |

---

## Part 2 — Your action items

### 2.1 🔴 P0 — Verify RLS on the dashboard-only tables (do this first)

`facts`, `mail_events`, `chat_messages` (and a few others) were created directly
in the dashboard, so there's **no migration in the repo** and I could not confirm
their Row Level Security from code. The mobile client talks to Postgres with the
**public** anon key, so RLS is the *only* thing stopping user A from reading user
B's mail/memory. If RLS is off or mis-scoped on these, it's a critical cross-user
data leak.

**Step 1 — run this in the Supabase SQL editor** (Dashboard → SQL Editor):

```sql
-- Which public tables have RLS enabled?
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

**Step 2 — any row with `rls_enabled = false` is a problem.** Pay special
attention to: `facts`, `mail_events`, `chat_messages`, `notes`, `reminders`,
`messages`, `push_subscriptions`, `user_settings`, `profiles`, `rate_limits`.

**Step 3 — list the policies** so you can confirm they're owner-scoped:

```sql
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd;
```

For each sensitive table you want to see, for **every** command (SELECT / INSERT /
UPDATE / DELETE), a policy whose `qual`/`with_check` is `(auth.uid() = user_id)`
(or the equivalent owner column).

**Step 4 — fix any table missing RLS.** Template (confirm the owner column is
really `user_id` first — check the table's columns):

```sql
alter table public.<table> enable row level security;
create policy "<table>_owner_all" on public.<table>
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

> If a table genuinely has no per-user owner column (e.g. a global lookup table),
> RLS-enabled with **no** policy = nobody can read it via the anon key, which is
> the safe default. Only the service role (edge functions) will reach it.

---

### 2.2 🟠 P1 — Confirm the old service-role key is dead

There's a legacy HS256 `service_role` JWT (valid until 2036) in your local
`supabase/schedule-poll-mail.sql` (not in git, but on disk). The project migrated
to `sb_secret_…` / ES256 keys. If the **legacy JWT secret was never rotated**,
that old token is still a full-database skeleton key (bypasses all RLS).

**Test whether it still works** — paste the old `eyJ…` token in both spots:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://sjkhfkatmeqtsrysixop.supabase.co/rest/v1/user_oauth_tokens?select=user_id&limit=1" \
  -H "apikey: <OLD_HS256_SERVICE_ROLE_JWT>" \
  -H "Authorization: Bearer <OLD_HS256_SERVICE_ROLE_JWT>"
```

- `401` → the key is already dead. Nothing to do. ✅
- `200` → the key is **LIVE**. Rotate it: Dashboard → Project Settings → API →
  (legacy) JWT secret → roll it. Then confirm all edge functions use the
  `sb_secret_…` key (they do, per the codebase) and redeploy if needed.

---

### 2.3 🟠 P1 — Lock down the Google / Firebase API keys

Two Google API keys are intentionally public (shipped in the app / served by the
Drive picker). Public is fine **only if they're restricted**. In
[Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials):

**a) Firebase Android key** (`AIzaSyBeTotvivoHuSFG6Km8d7U4kcKwkKAQoB0`, in
`google-services.json`):
- Application restrictions → **Android apps** → add package `com.zolva.app` + its
  SHA-1 signing cert.
- API restrictions → **Restrict key** → only the APIs you use (Firebase Cloud
  Messaging, etc.).

**b) Drive Picker key** (`GOOGLE_PICKER_API_KEY`, served by the `drive-picker`
function to any caller):
- Application restrictions → **HTTP referrers** → add
  `https://sjkhfkatmeqtsrysixop.supabase.co/*` (and your `auth.zolva.io` domain if
  the picker is served from there).
- API restrictions → only the **Google Picker API**.

If either currently shows "no restrictions," anyone can spend your Google quota.

---

### 2.4 🟠 P1 — Verify the OAuth-token lockdown on a device (migration already applied)

I applied migration `…161000` which stops the client from reading the stored
`refresh_token`. Code review says this is safe (the app only counts row presence
and writes the token, never reads it), but please confirm on a real device:

1. Open the app, go to Settings, **disconnect** then **reconnect** a Microsoft (or
   Google) account.
2. Confirm mail/calendar still loads after reconnect.

If anything breaks (e.g. provider shows "not connected" right after connecting),
**roll back instantly** in the SQL editor:

```sql
grant select on public.user_oauth_tokens to authenticated;
```

…and tell me — we'll switch to a presence-only view instead.

---

### 2.5 🟡 P2 — Move the Android keystore out of the repo

`@albertfeldt1__zolva-app.jks` sits in the repo root. It's gitignored, but one
stray `git add -A` and your app-signing key is public (an attacker could ship a
"legitimate" tampered update). Move it somewhere outside the repo:

```bash
mkdir -p ~/.android/keystores
mv "/Users/albertfeldt/ZolvaApp/@albertfeldt1__zolva-app.jks" ~/.android/keystores/
```

(EAS-managed credentials don't reference this local path; if you have a local
build script that does, update it.)

---

### 2.6 🟡 P2 — Known billing-gate gap: the weekly chat cap is bypassable

The 50/week (free) cap is enforced in `chat-run` (round 0). A *modified* client
could skip `chat-run` and call `claude-proxy` directly, which only has the
abuse limiter (500 requests/day) — so a determined free user could exceed 50/week
(but is now bounded by the model allowlist + the 8192 max-tokens clamp I shipped,
so the cost ceiling is much lower). This is a billing-integrity gap, not a data
leak. Options if you want it fully closed:
- Add a tier-aware daily cap inside `claude-proxy` (generous enough not to affect
  legit tool-continuation rounds), or
- Move the per-user-message count to a place both entry paths share.

Tell me if you want this built — it needs a little care so it doesn't throttle
legitimate tool-heavy turns.

---

### 2.7 🟢 P3 — Lower-priority hardening (optional)

- **Android OAuth deep-link:** the `zolva://` redirect is interceptable by a
  malicious app on Android. PKCE already makes a stolen code unusable, so this is
  low risk. Full fix = switch the Android OAuth redirect to an HTTPS App Link
  (`assetlinks.json`).
- **Dependencies:** `npm audit` shows 0 critical; the one runtime CVE (`ws`,
  moderate) is low-exploitability (Supabase is the only peer). Run `npm audit fix`
  when supabase-js / expo bump `ws` past 8.20.
- **`agent-tick` self-trigger:** an authenticated user can repeatedly POST their
  own `agent-tick` to burn tokens (bounded by the 500k/day agent budget). Add a
  per-user cooldown on the JWT path if abuse appears.
- **`.env.example` cleanup:** stale Stripe vars (replaced by RevenueCat) — remove
  to avoid confusion.

---

## Quick reference — what's solid (no action needed)

Consistent auth on every function (re-validates the JWT itself); IDOR closed
(atomic `UPDATE … WHERE id=? AND user_id=caller`); RevenueCat webhook is
timing-safe + fail-closed + FK-protected; no server secrets in the repo or app
bundle; tokens in Keychain not plaintext; Microsoft OAuth uses PKCE; email
rendered as plain text (no HTML/XSS); Drive-picker WebView host-restricted; no
analytics/PII-exfil SDKs; no SQL injection.
