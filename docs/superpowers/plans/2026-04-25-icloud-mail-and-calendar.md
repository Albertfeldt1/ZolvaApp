# iCloud Mail and Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iCloud as a first-class mail and calendar provider. Inbox surfaces iCloud mail merged with any other connected providers; Today surfaces iCloud calendar events. Daily brief stays Google/Microsoft-only for v1.

**Architecture:** Device stores credential in secureStorage. Calendar fetched device-direct from `caldav.icloud.com` over HTTPS. Mail fetched via new Supabase edge function `imap-proxy` running `npm:imapflow` over Deno node-compat — credential transits the proxy per-request, never persisted server-side. Per-user rate limiting + credential-to-user binding mitigate authenticated abuse.

**Tech Stack:** TypeScript / React Native (Expo SDK 54 + new arch), Supabase (Postgres + Edge Functions on Deno), `imapflow@1.3.2` (server-side Deno via `npm:`), `ical.js` (client-side, RN-compatible), `expo-web-browser`, `expo-secure-store`, `lucide-react-native`.

**Spec:** `docs/superpowers/specs/2026-04-25-icloud-mail-and-calendar-design.md`

---

## Phase 0 — Foundation & verification gate

### Task 0.1: TCP smoke-test probe (deploy, verify, decide)

This is a **gating prerequisite**. If the probe fails, the whole `imap-proxy` plan changes (move proxy to Fly.io). Do this before writing anything else.

**Files:**
- Create: `supabase/functions/tcp-probe/index.ts`

- [ ] **Step 1: Write the probe function**

```ts
// supabase/functions/tcp-probe/index.ts
//
// THROWAWAY: smoke-tests outbound TCP+TLS to imap.mail.me.com:993
// from a deployed Supabase edge function. Delete this function once
// the imap-proxy is live. Auto-expires via PROBE_EXPIRY as defence
// in depth in case it gets forgotten.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

// IMPORTANT: recompute at deploy time. monthIndex is 0-based (3 = April).
const PROBE_EXPIRY = Date.UTC(2026, 3, 28); // 2026-04-28 00:00 UTC

serve(async () => {
  if (Date.now() > PROBE_EXPIRY) {
    return new Response('Gone', { status: 410 });
  }
  const t0 = performance.now();
  try {
    const conn = await Deno.connectTls({
      hostname: 'imap.mail.me.com',
      port: 993,
    });
    conn.close();
    return Response.json({
      ok: true,
      handshakeMs: Math.round(performance.now() - t0),
    });
  } catch (caughtErr) {
    return Response.json(
      { ok: false, error: String(caughtErr) },
      { status: 500 },
    );
  }
});
```

- [ ] **Step 2: Deploy with no-jwt verification**

Run:
```bash
supabase functions deploy tcp-probe --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

Expected output: `Deployed Function tcp-probe to project sjkhfkatmeqtsrysixop`.

- [ ] **Step 3: Run the probe 5 times**

Run:
```bash
for i in 1 2 3 4 5; do
  curl -s "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/tcp-probe"
  echo
done
```

Expected: 5 lines of `{"ok":true,"handshakeMs":<50-300>}`. Some variation in `handshakeMs` is normal.

- [ ] **Step 4: Decide**

- **All 5 succeed** → proceed with Task 0.2. Plan continues as written.
- **Any fail with `error` mentioning network/connection refused** → stop the plan. Switch the proxy host to Fly.io (or other Node runtime that allows outbound TCP). Architecture box in spec is unchanged; only the URL the client posts to changes from `${SUPABASE_URL}/functions/v1/imap-proxy` to `${IMAP_PROXY_URL}/`. Re-plan Phase 2 around Fly.io deployment.
- **Mixed results** (some succeed, some timeout) → run 10 more. If failure rate is >20%, treat as "fail" above.

- [ ] **Step 5: Schedule deletion (calendar reminder, not a code task)**

After deciding, the probe function is no longer needed. Add a personal reminder to delete it within 24h:

```bash
supabase functions delete tcp-probe --project-ref sjkhfkatmeqtsrysixop
```

The PROBE_EXPIRY kill-switch backs this up.

- [ ] **Step 6: No commit needed for the throwaway**

The `supabase/functions/tcp-probe/` directory should not be committed — it's deleted within 24h. Don't stage it.

---

### Task 0.2: Type extensions

Pure type additions. No runtime behaviour change.

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add `'icloud'` to `IntegrationKey`**

Edit `src/lib/types.ts` around the `IntegrationKey` definition:

```ts
export type IntegrationKey =
  | 'google-calendar'
  | 'gmail'
  | 'google-drive'
  | 'outlook-calendar'
  | 'outlook-mail'
  | 'icloud';
```

- [ ] **Step 2: Add `'expired'` to `IntegrationStatus`**

```ts
export type IntegrationStatus = 'connected' | 'pending' | 'expired' | 'disconnected';
// 'pending' = transient user-initiated (OAuth in flight) — currently unused, reserved.
// 'expired' = persistent, credential rejected by provider, user must re-enter.
```

- [ ] **Step 3: Add `'icloud'` to `MailProvider`**

```ts
export type MailProvider = 'google' | 'microsoft' | 'icloud';
```

- [ ] **Step 4: Add `'icloud'` to `UpcomingEvent.source`**

In the `UpcomingEvent` type:

```ts
  source: 'google' | 'microsoft' | 'demo' | 'icloud';
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

Expected: no output. If errors appear, they're consumers of the extended types — fix each by adding a default branch or explicit case.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): extend provider/status enums for iCloud"
```

---

## Phase 1 — Database

### Task 1.1: Migration for binding + rate-limit tables + cron sweep

**Files:**
- Create: `supabase/migrations/20260425000000_icloud_proxy.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260425000000_icloud_proxy.sql
--
-- Tables backing the imap-proxy edge function.
--
-- icloud_credential_bindings: user_id → HMAC of (email + ':' + password).
-- Established on the user's first successful list-inbox; verified on every
-- subsequent list-inbox. Stops a JWT from being used to relay arbitrary
-- iCloud credentials through the proxy (credential stuffing).
--
-- icloud_proxy_calls: per-call audit + sliding-window rate limiting.
--
-- Both tables are service-role only (the edge function is the only writer).
-- RLS is enabled with no policies: client cannot read.

CREATE TABLE icloud_credential_bindings (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_hash   text NOT NULL,
  last_validated_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE icloud_proxy_calls (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  op        text NOT NULL CHECK (op IN ('validate', 'list-inbox')),
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX icloud_proxy_calls_user_called
  ON icloud_proxy_calls (user_id, called_at DESC);

ALTER TABLE icloud_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE icloud_proxy_calls         ENABLE ROW LEVEL SECURITY;

-- Daily cleanup. Bindings: 90 days because app-specific passwords don't
-- expire on Apple's side and refresh-on-every-list-inbox keeps active rows
-- alive. Proxy calls: 30 days for abuse investigation.
SELECT cron.schedule(
  'icloud-binding-sweep',
  '0 4 * * *',
  $$
  DELETE FROM icloud_credential_bindings
    WHERE last_validated_at < now() - interval '90 days';
  DELETE FROM icloud_proxy_calls
    WHERE called_at < now() - interval '30 days';
  $$
);
```

- [ ] **Step 2: Apply the migration**

```bash
supabase db push --linked
```

Expected: `Applying migration 20260425000000_icloud_proxy.sql...` and `Finished supabase db push.`

If `pg_cron` extension isn't enabled, the cron line fails. The Daily Brief feature already uses cron (per spec `2026-04-21-daily-brief-design.md`), so the extension should be enabled.

- [ ] **Step 3: Verify tables exist**

Via Supabase MCP or dashboard SQL editor:
```sql
SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name LIKE 'icloud%';
```

Expected: 2 rows.

- [ ] **Step 4: Verify cron job is scheduled**

```sql
SELECT jobname, schedule FROM cron.job WHERE jobname = 'icloud-binding-sweep';
```

Expected: 1 row with `schedule = '0 4 * * *'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260425000000_icloud_proxy.sql
git commit -m "feat(db): icloud_credential_bindings + proxy_calls + cron sweep"
```

---

### Task 1.2: Set BINDING_HASH_PEPPER edge function env var

- [ ] **Step 1: Generate a random 32-byte secret**

```bash
openssl rand -hex 32
```

Copy the 64-hex-char output.

- [ ] **Step 2: Set as Supabase edge function secret**

```bash
supabase secrets set BINDING_HASH_PEPPER=<paste-from-step-1> --project-ref sjkhfkatmeqtsrysixop
```

Expected: `Finished supabase secrets set.`

- [ ] **Step 3: Verify it's set**

```bash
supabase secrets list --project-ref sjkhfkatmeqtsrysixop | grep BINDING_HASH_PEPPER
```

Expected: a line with `BINDING_HASH_PEPPER` (Supabase doesn't show secret values, only that they exist).

- [ ] **Step 4: No commit (secrets aren't in git)**

Document the rotation procedure in the deployment runbook (out of scope for this task — captured as an Implementation Note in the spec).

---

## Phase 2 — `imap-proxy` edge function

### Task 2.1: Edge function scaffold + JWT gate

**Files:**
- Create: `supabase/functions/imap-proxy/index.ts`
- Create: `supabase/functions/imap-proxy/deno.json`

- [ ] **Step 1: Create deno.json with imapflow pin**

```json
{
  "imports": {
    "imapflow": "npm:imapflow@1.3.2"
  }
}
```

- [ ] **Step 2: Write the scaffold (auth gate + request shape parsing)**

```ts
// supabase/functions/imap-proxy/index.ts
//
// Authenticated proxy for iCloud IMAP. Two ops:
//   - validate:   LOGIN + LOGOUT only. No DB writes.
//   - list-inbox: hash-bind check + LOGIN + SELECT INBOX + FETCH + LOGOUT.
//                 First successful call upserts the binding row.
//
// Hardcoded target imap.mail.me.com:993. No host param accepted.
// JWT required for all calls. Per-user rate limits enforced server-side.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const RATE_LIMIT_VALIDATE = 10;     // per hour per user
const RATE_LIMIT_LIST_INBOX = 60;   // per hour per user

type ValidateReq = { op: 'validate'; email: string; password: string };
type ListInboxReq = {
  op: 'list-inbox';
  email: string;
  password: string;
  limit?: number;
};
type Req = ValidateReq | ListInboxReq;

type ErrCode =
  | 'unauthorized'
  | 'auth-failed'
  | 'rate-limited'
  | 'protocol'
  | 'temporarily-unavailable'
  | 'network'
  | 'timeout'
  | 'internal'
  | 'bad-request';

function err(code: ErrCode, status: number): Response {
  return Response.json({ ok: false, error: code }, { status });
}

serve(async (req) => {
  if (req.method !== 'POST') return err('bad-request', 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const pepper = Deno.env.get('BINDING_HASH_PEPPER');
  if (!supabaseUrl || !anonKey || !serviceKey || !pepper) {
    return err('internal', 500);
  }

  // --- JWT gate ---
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return err('unauthorized', 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return err('unauthorized', 401);
  }
  const userId = userData.user.id;

  // --- Body parse ---
  let body: Req;
  try {
    body = (await req.json()) as Req;
  } catch {
    return err('bad-request', 400);
  }
  if (
    !body ||
    (body.op !== 'validate' && body.op !== 'list-inbox') ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string' ||
    body.email.length === 0 ||
    body.password.length === 0
  ) {
    return err('bad-request', 400);
  }

  // (rate limit + per-op handling added in subsequent tasks)
  return Response.json({ ok: false, error: 'internal' }, { status: 501 });
});
```

- [ ] **Step 3: Deploy and verify the auth gate**

```bash
supabase functions deploy imap-proxy --project-ref sjkhfkatmeqtsrysixop
```

Test the gate (no JWT):
```bash
curl -i -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/imap-proxy" \
  -H "Content-Type: application/json" \
  -d '{"op":"validate","email":"x","password":"y"}'
```

Expected: HTTP 401, body `{"ok":false,"error":"unauthorized"}`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/imap-proxy/
git commit -m "feat(imap-proxy): scaffold edge function with JWT gate"
```

---

### Task 2.2: `validate` op (no DB writes)

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts`

- [ ] **Step 1: Add the validate handler + helpers**

Replace the placeholder `return Response.json(...)` at the end of `serve()` with:

```ts
  // --- Rate limit ---
  const rateOk = await checkRateLimit(serviceKey, supabaseUrl, userId, body.op);
  if (!rateOk) return err('rate-limited', 429);

  if (body.op === 'validate') {
    return await handleValidate(body);
  }
  if (body.op === 'list-inbox') {
    return await handleListInbox(body, userId, pepper, supabaseUrl, serviceKey);
  }
  return err('bad-request', 400);
});

async function checkRateLimit(
  serviceKey: string,
  supabaseUrl: string,
  userId: string,
  op: 'validate' | 'list-inbox',
): Promise<boolean> {
  const limit = op === 'validate' ? RATE_LIMIT_VALIDATE : RATE_LIMIT_LIST_INBOX;
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await svc
    .from('icloud_proxy_calls')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', userId)
    .eq('op', op)
    .gte('called_at', since);
  if (error) {
    console.warn('[imap-proxy] rate-limit check failed:', error.message);
    return true; // fail open on infrastructure errors; don't block legit users
  }
  if ((count ?? 0) >= limit) return false;
  // Record this call (fire-and-forget — rate limit window already computed)
  void svc.from('icloud_proxy_calls').insert({ user_id: userId, op });
  return true;
}

async function handleValidate(body: ValidateReq): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();

  let client: ImapFlow | null = null;
  try {
    client = newImapClient(email, password);
    await client.connect();
    await client.logout();
    return Response.json({ ok: true });
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

function newImapClient(email: string, password: string): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,                  // never log credentials
    socketTimeout: COMMAND_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
}

function normalizePassword(input: string): string {
  return input.replace(/[\s-]/g, '');
}

function mapImapError(caughtErr: unknown): Response {
  const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
  // imapflow throws structured errors with serverResponseCode
  const code =
    (caughtErr as { serverResponseCode?: string })?.serverResponseCode ?? '';
  if (
    code === 'AUTHENTICATIONFAILED' ||
    /AUTHENTICATIONFAILED/i.test(msg) ||
    /\bLOGIN failed\b/i.test(msg)
  ) {
    return err('auth-failed', 422);
  }
  if (
    code === 'INUSE' ||
    code === 'UNAVAILABLE' ||
    code === 'ALERT' ||
    /^NO\b/i.test(msg)
  ) {
    return err('temporarily-unavailable', 503);
  }
  if (
    /AbortError|aborted/i.test(msg) ||
    /timeout/i.test(msg)
  ) {
    return err('timeout', 504);
  }
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(msg)
  ) {
    return err('network', 503);
  }
  console.warn('[imap-proxy] unmapped imap error:', msg);
  return err('protocol', 502);
}
```

- [ ] **Step 2: Deploy and test validate**

```bash
supabase functions deploy imap-proxy --project-ref sjkhfkatmeqtsrysixop
```

Get a real Supabase JWT (use the dev Settings screen's "Copy JWT" button — see commit `f90604e`), then:

```bash
JWT="<paste-jwt>"
curl -i -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/imap-proxy" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"op":"validate","email":"feldten@me.com","password":"definitelynotvalid"}'
```

Expected: HTTP 422, body `{"ok":false,"error":"auth-failed"}`.

- [ ] **Step 3: Test with REAL credentials (one-time, manually)**

If you have a real iCloud app-specific password:

```bash
curl -i -X POST "$URL" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"op":"validate","email":"<real>","password":"<real-app-pwd>"}'
```

Expected: HTTP 200, body `{"ok":true}`.

- [ ] **Step 4: Verify rate-limit row was inserted**

```sql
SELECT user_id, op, called_at FROM icloud_proxy_calls ORDER BY called_at DESC LIMIT 5;
```

Expected: rows for the test calls just made.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): validate op with rate limiting + error mapping"
```

---

### Task 2.3: `list-inbox` op with bind-on-first-fetch

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts`

- [ ] **Step 1: Add the list-inbox handler + binding helpers**

Append:

```ts
async function handleListInbox(
  body: ListInboxReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();
  const limit = clampLimit(body.limit);

  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Binding check: if a row exists, hash MUST match. If absent, this is the
  // first call — proceed and create the row on success.
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[imap-proxy] binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (existing && existing.credential_hash !== hash) {
    return err('auth-failed', 422); // same shape as wrong-password; no oracle
  }

  let client: ImapFlow | null = null;
  try {
    client = newImapClient(email, password);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const messages: Array<{
      uid: number;
      from: string;
      subject: string;
      date: string;
      unread: boolean;
      preview: string;
    }> = [];
    try {
      const mbox = client.mailbox;
      if (!mbox || typeof mbox === 'boolean') throw new Error('mailbox not open');
      const total = mbox.exists;
      if (total > 0) {
        const lo = Math.max(1, total - limit + 1);
        const range = `${lo}:${total}`;
        for await (const m of client.fetch(range, {
          uid: true,
          envelope: true,
          flags: true,
          bodyParts: ['1'],
        })) {
          const env = m.envelope;
          if (!env) continue;
          messages.push({
            uid: m.uid,
            from: formatFrom(env.from),
            subject: env.subject ?? '(uden emne)',
            date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
            unread: !(m.flags && m.flags.has('\\Seen')),
            preview: extractPreview(m.bodyParts?.get('1')),
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // Bind on first-success / refresh on subsequent
    const { error: bindWriteErr } = await svc
      .from('icloud_credential_bindings')
      .upsert(
        {
          user_id: userId,
          credential_hash: hash,
          last_validated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (bindWriteErr) {
      console.warn('[imap-proxy] binding write failed:', bindWriteErr.message);
      // don't fail the request — user got their data; binding can repair next call
    }

    return Response.json({ ok: true, messages });
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 12;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

async function hashCredential(pepper: string, email: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${email}:${password}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatFrom(from: Array<{ name?: string; address?: string }> | undefined | null): string {
  if (!from || from.length === 0) return '';
  const f = from[0];
  if (f.name && f.address) return `${f.name} <${f.address}>`;
  return f.address ?? f.name ?? '';
}

function extractPreview(part: Uint8Array | undefined): string {
  if (!part) return '';
  const text = new TextDecoder().decode(part);
  if (text.length === 0) return '';
  const looksHtml = text.slice(0, 100).includes('<');
  const stripped = looksHtml
    ? text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    : text;
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 140);
}
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy imap-proxy --project-ref sjkhfkatmeqtsrysixop
```

- [ ] **Step 3: Test list-inbox with real credentials (manual)**

```bash
curl -i -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/imap-proxy" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"op":"list-inbox","email":"<real>","password":"<real-app-pwd>","limit":5}'
```

Expected: HTTP 200 with up to 5 messages from the real INBOX.

- [ ] **Step 4: Verify binding row was created**

```sql
SELECT user_id, length(credential_hash) AS hash_len, last_validated_at
FROM icloud_credential_bindings WHERE user_id = '<your user_id>';
```

Expected: 1 row, `hash_len = 64` (SHA-256 hex), `last_validated_at` ≈ now.

- [ ] **Step 5: Test binding mismatch (auth-failed semantics)**

Call list-inbox with a DIFFERENT password than the one that created the binding:

```bash
curl -i -X POST "$URL" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"op":"list-inbox","email":"<real>","password":"differentpassword","limit":5}'
```

Expected: HTTP 422, body `{"ok":false,"error":"auth-failed"}`. NOT a real Apple call — the binding mismatch caught it before IMAP.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): list-inbox op with bind-on-first-fetch"
```

---

## Phase 3 — Credential storage interface

### Task 3.1: `icloud-credentials.ts` storage module

**Files:**
- Create: `src/lib/icloud-credentials.ts`

- [ ] **Step 1: Verify the secure-storage module signature**

Read `src/lib/secure-storage.ts` to confirm it exports `getItem`, `setItem`, `deleteItem`. (It does — referenced from auth.ts.)

- [ ] **Step 2: Write the storage module**

```ts
// src/lib/icloud-credentials.ts
//
// Three-state credential storage for iCloud (Apple ID + app-specific password).
// Backed by secureStorage (iOS Keychain / Android Keystore) per-user.
//
// State machine:
//   absent  -> setupScreen captures + saveCredential -> valid
//   valid   -> markInvalid (called on auth-failed mid-session) -> invalid
//   valid   -> clearCredential (user disconnects in Settings) -> absent
//   invalid -> setupScreen re-captures + saveCredential -> valid
//   invalid -> clearCredential (user disconnects) -> absent
//
// Platform behaviour for persistence across app reinstall:
//   - iOS: Keychain may survive uninstall. Existing SECURE_STORE_MIGRATION_FLAG
//     pattern in src/lib/auth.ts wipes orphaned entries on first launch after
//     install. This module relies on that pattern (no separate migration here).
//   - Android: Keystore wiped on uninstall. android.allowBackup=false in the
//     manifest prevents Auto Backup from syncing credentials to Google Drive.

import * as secureStorage from './secure-storage';

export type SyncCursor = { uidValidity: number; lastUid: number };
// v1 ignores SyncCursor — included so the storage shape doesn't have to
// change when/if server-side polling is added later.

export type IcloudCredential = {
  email: string;
  password: string;
  lastSyncCursor: SyncCursor | null;
};

export type IcloudCredentialState =
  | { kind: 'absent' }
  | { kind: 'valid';   credential: IcloudCredential }
  | { kind: 'invalid'; credential: IcloudCredential; reason?: string };

const credKey = (uid: string) => `zolva.${uid}.icloud.credential`;

type StoredShape = {
  email: string;
  password: string;
  lastSyncCursor: SyncCursor | null;
  state: 'valid' | 'invalid';
  invalidReason?: string;
};

export async function loadCredential(userId: string): Promise<IcloudCredentialState> {
  if (!userId) return { kind: 'absent' };
  const raw = await secureStorage.getItem(credKey(userId));
  if (!raw) return { kind: 'absent' };
  let parsed: StoredShape;
  try {
    parsed = JSON.parse(raw) as StoredShape;
  } catch {
    return { kind: 'absent' };
  }
  if (
    typeof parsed.email !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    return { kind: 'absent' };
  }
  const credential: IcloudCredential = {
    email: parsed.email,
    password: parsed.password,
    lastSyncCursor: parsed.lastSyncCursor ?? null,
  };
  if (parsed.state === 'invalid') {
    return { kind: 'invalid', credential, reason: parsed.invalidReason };
  }
  return { kind: 'valid', credential };
}

export async function saveCredential(
  userId: string,
  email: string,
  password: string,
): Promise<void> {
  if (!userId) throw new Error('saveCredential: missing userId');
  const trimmedEmail = email.trim().toLowerCase();
  const cleanPwd = password.replace(/[\s-]/g, '');
  if (!trimmedEmail || !cleanPwd) {
    throw new Error('saveCredential: email and password required');
  }
  const stored: StoredShape = {
    email: trimmedEmail,
    password: cleanPwd,
    lastSyncCursor: null,
    state: 'valid',
  };
  await secureStorage.setItem(credKey(userId), JSON.stringify(stored));
}

export async function markInvalid(userId: string, reason?: string): Promise<void> {
  if (!userId) return;
  const current = await loadCredential(userId);
  if (current.kind === 'absent') return;
  const stored: StoredShape = {
    email: current.credential.email,
    password: current.credential.password,
    lastSyncCursor: current.credential.lastSyncCursor,
    state: 'invalid',
    invalidReason: reason,
  };
  await secureStorage.setItem(credKey(userId), JSON.stringify(stored));
}

export async function clearCredential(userId: string): Promise<void> {
  if (!userId) return;
  await secureStorage.deleteItem(credKey(userId));
}
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/lib/icloud-credentials.ts
git commit -m "feat(icloud): credential storage interface (secureStorage-backed)"
```

---

## Phase 4 — Mail client

### Task 4.1: `icloud-mail.ts` client module

**Files:**
- Create: `src/lib/icloud-mail.ts`

- [ ] **Step 1: Locate the Supabase URL constant**

Read `src/lib/supabase.ts` to find how `SUPABASE_URL` is exposed. Likely `process.env.EXPO_PUBLIC_SUPABASE_URL`.

- [ ] **Step 2: Write the mail client module**

> **Note (2026-04-25, post-implementation):** the original spec landed verbatim (commit `8c2cbbd`) and was then refined across two follow-up commits (`fa6c828`, `5d44120`) based on code review. The version below reflects the as-built code. Three contract decisions worth flagging because they propagate to Phase 5 (calendar) and Phase 7 (hooks):
>
> 1. **Action-oriented error codes.** `'no-credential'` was split into `'not-connected'` (cred is `'absent'` — caller suppresses UI silently) and `'credential-rejected'` (cred is `'invalid'` — caller surfaces the re-entry banner). Hook layer gates on `kind === 'valid'`, so `'not-connected'` is unreachable from the hot path; `'credential-rejected'` fires on stale-state re-fetches after Apple rejects mid-session.
> 2. **`validate` is `IcloudResult<null>` with `data: null`** — drops the `IcloudResult<void>` + `data: undefined as T` coercion that lied to generic-typed callers.
> 3. **200-response payload strips the wire `ok` field.** `IcloudResult.ok` already discriminates; leaking the wire envelope into `data` surfaced confusingly under `JSON.stringify` / `Object.keys`.
> 4. **Client-side timeout** (30s validate, 25s list-inbox) via `AbortController`, mapped to the existing `'timeout'` code.
> 5. **Wire error codes are narrowed** against `KNOWN_WIRE_CODES` so unexpected values fall back to `'protocol'` instead of slipping into the union as runtime liars.
> 6. **`EXPO_PUBLIC_SUPABASE_URL` is asserted at module load**, matching `src/lib/supabase.ts`.

```ts
// src/lib/icloud-mail.ts
//
// Client for the imap-proxy edge function. Calls validate (during setup)
// and listInbox (during inbox fetch). On auth-failed from listInbox, flips
// the stored credential to 'invalid' state.

import { supabase } from './supabase';
import { loadCredential, markInvalid } from './icloud-credentials';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  throw new Error('icloud-mail: missing EXPO_PUBLIC_SUPABASE_URL');
}
const PROXY_URL = `${SUPABASE_URL}/functions/v1/imap-proxy`;

const VALIDATE_TIMEOUT_MS = 30_000;
const LIST_INBOX_TIMEOUT_MS = 25_000;

// Codes the edge function may return on the wire. 'network', 'not-connected'
// and 'credential-rejected' are client-synthesized and must not be accepted
// from the server side.
const KNOWN_WIRE_CODES: ReadonlySet<IcloudErrorCode> = new Set([
  'auth-failed',
  'rate-limited',
  'protocol',
  'temporarily-unavailable',
  'unauthorized',
  'timeout',
]);

export type IcloudMessage = {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  unread: boolean;
  preview: string;
};

// Action-oriented error codes — names describe what the caller should do, not
// the underlying storage state.
export type IcloudErrorCode =
  | 'auth-failed'
  | 'rate-limited'
  | 'protocol'
  | 'temporarily-unavailable'
  | 'network'
  | 'timeout'
  | 'not-connected'        // credential is 'absent' — caller should suppress UI silently
  | 'credential-rejected'  // credential is 'invalid' — caller should surface re-entry banner
  | 'unauthorized';

export type IcloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IcloudErrorCode };

export async function validate(
  email: string,
  password: string,
): Promise<IcloudResult<null>> {
  return await call<null>('validate', { email, password });
}

export async function listInbox(
  userId: string,
  limit = 12,
): Promise<IcloudResult<IcloudMessage[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') {
    return { ok: false, error: 'not-connected' };
  }
  if (cred.kind === 'invalid') {
    return { ok: false, error: 'credential-rejected' };
  }
  const res = await call<{ messages: RawMessage[] }>('list-inbox', {
    email: cred.credential.email,
    password: cred.credential.password,
    limit,
  });
  if (!res.ok) {
    if (res.error === 'auth-failed') {
      await markInvalid(userId, 'imap-rejected');
    }
    return res;
  }
  return {
    ok: true,
    data: res.data.messages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      date: new Date(m.date),
      unread: m.unread,
      preview: m.preview,
    })),
  };
}

type RawMessage = {
  uid: number;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  preview: string;
};

async function call<T>(
  op: 'validate' | 'list-inbox',
  body: Record<string, unknown>,
): Promise<IcloudResult<T>> {
  const session = await supabase.auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'unauthorized' };
  }
  const timeoutMs = op === 'validate' ? VALIDATE_TIMEOUT_MS : LIST_INBOX_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ op, ...body }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'network' };
  }
  clearTimeout(timer);
  if (res.status === 200) {
    if (op === 'validate') return { ok: true, data: null as T };
    const j = (await res.json()) as Record<string, unknown>;
    // Strip the wire envelope's `ok` so it doesn't leak into IcloudResult.data.
    const { ok: _wire, ...payload } = j;
    return { ok: true, data: payload as T };
  }
  let errCode: IcloudErrorCode;
  try {
    const j = (await res.json()) as { error?: string };
    const raw = j.error;
    errCode = typeof raw === 'string' && KNOWN_WIRE_CODES.has(raw as IcloudErrorCode)
      ? (raw as IcloudErrorCode)
      : 'protocol';
  } catch {
    errCode = 'protocol';
  }
  return { ok: false, error: errCode };
}
```

- [ ] **Step 3: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/lib/icloud-mail.ts
git commit -m "feat(icloud): client module for imap-proxy (validate + listInbox)"
```

---

## Phase 5 — Calendar client

### Task 5.1: Add `ical.js` dependency

- [ ] **Step 1: Install ical.js**

```bash
cd /Users/albertfeldt/ZolvaApp && npm install ical.js@1.5.0
```

- [ ] **Step 2: Verify it loads**

Create `/tmp/ical-check.ts`:

```ts
import ICAL from 'ical.js';
const sample = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test
DTSTART:20260501T100000Z
DTEND:20260501T110000Z
SUMMARY:Test event
END:VEVENT
END:VCALENDAR`;
const j = ICAL.parse(sample);
const c = new ICAL.Component(j);
const e = new ICAL.Event(c.getFirstSubcomponent('vevent')!);
console.log('OK:', e.summary);
```

Run: `npx tsx /tmp/ical-check.ts`. Expected: `OK: Test event`. Delete the temp file after.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add ical.js for iCloud CalDAV parsing"
```

---

### Task 5.2: CalDAV discovery + `icloud-calendar.ts` skeleton

**Files:**
- Create: `src/lib/icloud-calendar.ts`

- [ ] **Step 1: Write the discovery + cache logic**

```ts
// src/lib/icloud-calendar.ts
//
// CalDAV client for iCloud. Goes device-direct to caldav.icloud.com over HTTPS.
// Auth is HTTP Basic with email + app-specific password.
//
// Discovery (cached): three round trips to find calendars.
//   1. PROPFIND /.well-known/caldav        → current-user-principal
//   2. PROPFIND <principal>                → calendar-home-set
//   3. PROPFIND <calendar-home> Depth:1    → calendar collections
//
// Split TTL: principal/calendar-home cached 30 days, calendar list cached 24h.

import * as secureStorage from './secure-storage';
import { loadCredential, markInvalid } from './icloud-credentials';

const CALDAV_HOST = 'https://caldav.icloud.com';
const PRINCIPAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CALENDAR_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 5;

export type IcloudCalendarMeta = {
  url: string;
  displayName: string;
  calendarColor?: string;
};

type CalDiscoveryCache = {
  principalUrl: string;
  calendarHomeUrl: string;
  principalDiscoveredAt: number;
  calendars: IcloudCalendarMeta[];
  calendarsListedAt: number;
};

const discoveryCacheKey = (uid: string) =>
  `zolva.${uid}.icloud.caldav.discovery`;

async function loadDiscoveryCache(userId: string): Promise<CalDiscoveryCache | null> {
  const raw = await secureStorage.getItem(discoveryCacheKey(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as CalDiscoveryCache; }
  catch { return null; }
}

async function saveDiscoveryCache(userId: string, cache: CalDiscoveryCache): Promise<void> {
  await secureStorage.setItem(discoveryCacheKey(userId), JSON.stringify(cache));
}

async function clearDiscoveryCache(userId: string): Promise<void> {
  await secureStorage.deleteItem(discoveryCacheKey(userId));
}

export async function clearDiscoveryCacheFor(userId: string): Promise<void> {
  // Public re-export so the Settings disconnect flow can wipe state.
  await clearDiscoveryCache(userId);
}

function basicAuth(email: string, password: string): string {
  return 'Basic ' + btoa(`${email}:${password}`);
}

// Action-oriented error codes — mirror the action codes in icloud-mail.ts so
// hook/banner logic stays uniform across providers. 'not-connected' is a
// defense-in-depth fallback (the hook layer gates on kind === 'valid' before
// calling listEvents); 'credential-rejected' is the hot path after Apple
// rejects mid-session and the next call finds the credential flagged invalid.
export type CalDavErrorCode =
  | 'auth-failed'
  | 'network'
  | 'timeout'
  | 'protocol'
  | 'not-connected'         // credential is 'absent' — caller suppresses UI silently
  | 'credential-rejected';  // credential is 'invalid' — caller surfaces re-entry banner

export type CalDavResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CalDavErrorCode };

export async function probeCredential(
  email: string,
  password: string,
): Promise<CalDavResult<{ principalUrl: string }>> {
  // Lightest-weight CalDAV op for the setup-screen dual-probe.
  return await propfindPrincipal(email, password);
}

export async function listEvents(
  userId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalDavResult<IcloudCalEvent[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };
  const auth = basicAuth(cred.credential.email, cred.credential.password);

  let cache = await loadDiscoveryCache(userId);
  const now = Date.now();
  if (!cache || now - cache.principalDiscoveredAt > PRINCIPAL_TTL_MS) {
    const fresh = await fullDiscover(cred.credential.email, cred.credential.password, userId);
    if (!fresh.ok) {
      if (fresh.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return fresh;
    }
    cache = fresh.data;
  } else if (now - cache.calendarsListedAt > CALENDAR_LIST_TTL_MS) {
    const calsRes = await listCalendarsAt(cache.calendarHomeUrl, auth);
    if (!calsRes.ok) {
      if (calsRes.error === 'auth-failed') await markInvalid(userId, 'caldav-rejected');
      return calsRes;
    }
    cache = { ...cache, calendars: calsRes.data, calendarsListedAt: now };
    await saveDiscoveryCache(userId, cache);
  }

  // (event fetch added in Task 5.3)
  return { ok: true, data: [] };
}

async function fullDiscover(
  email: string,
  password: string,
  userId: string,
): Promise<CalDavResult<CalDiscoveryCache>> {
  const principalRes = await propfindPrincipal(email, password);
  if (!principalRes.ok) return principalRes;
  const principalUrl = principalRes.data.principalUrl;

  const homeRes = await propfindCalendarHome(principalUrl, basicAuth(email, password));
  if (!homeRes.ok) return homeRes;
  const calendarHomeUrl = homeRes.data.calendarHomeUrl;

  const calsRes = await listCalendarsAt(calendarHomeUrl, basicAuth(email, password));
  if (!calsRes.ok) return calsRes;

  const cache: CalDiscoveryCache = {
    principalUrl,
    calendarHomeUrl,
    principalDiscoveredAt: Date.now(),
    calendars: calsRes.data,
    calendarsListedAt: Date.now(),
  };
  await saveDiscoveryCache(userId, cache);
  return { ok: true, data: cache };
}

async function propfindPrincipal(
  email: string,
  password: string,
): Promise<CalDavResult<{ principalUrl: string }>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`;
  const res = await caldavFetch(
    `${CALDAV_HOST}/.well-known/caldav`,
    'PROPFIND',
    basicAuth(email, password),
    { Depth: '0' },
    body,
  );
  if (!res.ok) return res;
  const url = extractFirstHref(res.data, 'current-user-principal');
  if (!url) return { ok: false, error: 'protocol' };
  return { ok: true, data: { principalUrl: absolutize(url) } };
}

async function propfindCalendarHome(
  principalUrl: string,
  auth: string,
): Promise<CalDavResult<{ calendarHomeUrl: string }>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;
  const res = await caldavFetch(principalUrl, 'PROPFIND', auth, { Depth: '0' }, body);
  if (!res.ok) return res;
  const url = extractFirstHref(res.data, 'calendar-home-set');
  if (!url) return { ok: false, error: 'protocol' };
  return { ok: true, data: { calendarHomeUrl: absolutize(url) } };
}

async function listCalendarsAt(
  calendarHomeUrl: string,
  auth: string,
): Promise<CalDavResult<IcloudCalendarMeta[]>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <x:calendar-color/>
  </d:prop>
</d:propfind>`;
  const res = await caldavFetch(calendarHomeUrl, 'PROPFIND', auth, { Depth: '1' }, body);
  if (!res.ok) return res;
  const cals = parseCalendarList(res.data);
  return { ok: true, data: cals };
}

// XML response parsing — minimal, regex-based (DOMParser would need a polyfill in RN).
// If this proves brittle in practice, swap for fast-xml-parser as a follow-up.

function extractFirstHref(xml: string, propLocal: string): string | null {
  const re = new RegExp(
    `<[^>]*${propLocal}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href[^>]*>[\\s\\S]*?<\\/[^>]*${propLocal}[^>]*>`,
    'i',
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseCalendarList(xml: string): IcloudCalendarMeta[] {
  const result: IcloudCalendarMeta[] = [];
  const blocks = xml.split(/<[^>]*:response[^>]*>/i).slice(1);
  for (const blockRaw of blocks) {
    const block = blockRaw.split(/<\/[^>]*:response[^>]*>/i)[0];
    const href = block.match(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/i)?.[1]?.trim();
    if (!href) continue;
    const supports = block.match(
      /<[^>]*supported-calendar-component-set[^>]*>([\s\S]*?)<\/[^>]*supported-calendar-component-set[^>]*>/i,
    )?.[1] ?? '';
    if (!/<[^>]*comp[^>]*name=["']VEVENT["'][^>]*\/?>/.test(supports)) continue;
    const displayName = block.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname[^>]*>/i)?.[1]?.trim() ?? '(uden navn)';
    const calendarColor = block.match(/<[^>]*calendar-color[^>]*>([^<]+)<\/[^>]*calendar-color[^>]*>/i)?.[1]?.trim();
    result.push({
      url: absolutize(href),
      displayName,
      calendarColor,
    });
  }
  return result;
}

function absolutize(maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (maybeRelative.startsWith('/')) return CALDAV_HOST + maybeRelative;
  return `${CALDAV_HOST}/${maybeRelative}`;
}

async function caldavFetch(
  url: string,
  method: string,
  auth: string,
  headers: Record<string, string>,
  body: string,
): Promise<CalDavResult<string>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml; charset=utf-8',
        ...headers,
      },
      body,
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'auth-failed' };
  }
  if (res.status === 207 || res.status === 200) {
    return { ok: true, data: await res.text() };
  }
  if (res.status === 404) {
    return { ok: false, error: 'protocol' };
  }
  return { ok: false, error: 'protocol' };
}

export type IcloudCalEvent = {
  uid: string;
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
  calendarColor?: string;
  calendarName: string;
};
```

- [ ] **Step 2: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/lib/icloud-calendar.ts
git commit -m "feat(icloud): CalDAV discovery + cache (skeleton, no event fetch yet)"
```

---

### Task 5.3: Event fetch with ical.js + VTIMEZONE fallback

**Files:**
- Modify: `src/lib/icloud-calendar.ts`

- [ ] **Step 1: Replace the placeholder in `listEvents` with real fetch + parsing**

Locate the comment `// (event fetch added in Task 5.3)` and the `return { ok: true, data: [] };` line, and replace with:

```ts
  // Fetch events from each calendar in parallel, capped at CONCURRENCY.
  const range = caldavTimeRange(rangeStart, rangeEnd);
  const auth2 = basicAuth(cred.credential.email, cred.credential.password);
  const cals = cache.calendars;

  const results: IcloudCalEvent[] = [];
  let nextIndex = 0;
  let firstFatalError: CalDavErrorCode | null = null;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= cals.length) return;
      const cal = cals[i];
      const r = await reportEvents(cal.url, auth2, range);
      if (!r.ok) {
        if (r.error === 'auth-failed' && firstFatalError == null) firstFatalError = 'auth-failed';
        // Other errors: skip this calendar (best-effort) — partial result preferred.
        continue;
      }
      for (const raw of r.data) {
        const events = parseVcalendarEvents(raw, rangeStart, rangeEnd, cal);
        results.push(...events);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, cals.length) }, () => worker());
  await Promise.all(workers);

  if (firstFatalError === 'auth-failed') {
    await markInvalid(userId, 'caldav-rejected');
    return { ok: false, error: 'auth-failed' };
  }

  return { ok: true, data: results };
}
```

- [ ] **Step 2: Add reportEvents + parseVcalendarEvents + caldavTimeRange + Intl-TZ fallback**

Append to `src/lib/icloud-calendar.ts`:

```ts
import ICAL from 'ical.js';

function caldavTimeRange(start: Date, end: Date): { start: string; end: string } {
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { start: fmt(start), end: fmt(end) };
}

async function reportEvents(
  calendarUrl: string,
  auth: string,
  range: { start: string; end: string },
): Promise<CalDavResult<string[]>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${range.start}" end="${range.end}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const res = await caldavFetch(calendarUrl, 'REPORT', auth, { Depth: '1' }, body);
  if (!res.ok) return res;
  // Each event arrives in a <c:calendar-data> block.
  const blocks: string[] = [];
  for (const m of res.data.matchAll(/<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data[^>]*>/gi)) {
    blocks.push(m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim());
  }
  return { ok: true, data: blocks };
}

function parseVcalendarEvents(
  vcalText: string,
  rangeStart: Date,
  rangeEnd: Date,
  cal: IcloudCalendarMeta,
): IcloudCalEvent[] {
  let jcal: unknown;
  try { jcal = ICAL.parse(vcalText); }
  catch { return []; }
  const vcalendar = new ICAL.Component(jcal as [string, unknown[], unknown[]]);
  registerMissingTimezones(vcalendar);

  const out: IcloudCalEvent[] = [];
  for (const ve of vcalendar.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(ve);
    if (event.isRecurring()) {
      const iter = event.iterator();
      let next: ICAL.Time | null;
      while ((next = iter.next()) && next.toJSDate().getTime() < rangeEnd.getTime()) {
        if (next.toJSDate().getTime() < rangeStart.getTime()) continue;
        const details = event.getOccurrenceDetails(next);
        out.push(toIcloudEvent(details.item, details.startDate.toJSDate(), details.endDate.toJSDate(), cal));
      }
    } else {
      out.push(toIcloudEvent(event, event.startDate.toJSDate(), event.endDate.toJSDate(), cal));
    }
  }
  return out;
}

function toIcloudEvent(
  source: ICAL.Event,
  start: Date,
  end: Date,
  cal: IcloudCalendarMeta,
): IcloudCalEvent {
  return {
    uid: source.uid,
    start,
    end,
    allDay: !!source.startDate?.isDate,
    title: source.summary || '(uden titel)',
    location: source.location || undefined,
    description: source.description || undefined,
    calendarColor: cal.calendarColor,
    calendarName: cal.displayName,
  };
}

// VTIMEZONE fallback — when a VEVENT references TZID without an in-component
// VTIMEZONE block, register an Intl-DateTimeFormat-backed timezone so ical.js
// can resolve UTC offsets correctly. Without this, ical.js falls back to
// floating time → silent wrong-time bug for DST users.

function registerMissingTimezones(vcalendar: ICAL.Component): void {
  const referenced = new Set<string>();
  for (const ve of vcalendar.getAllSubcomponents('vevent')) {
    for (const propName of ['dtstart', 'dtend']) {
      const prop = ve.getFirstProperty(propName);
      const tzid = prop?.getParameter('tzid');
      if (typeof tzid === 'string') referenced.add(tzid);
    }
  }
  for (const tzid of referenced) {
    if (ICAL.TimezoneService.has(tzid)) continue;
    const present = vcalendar.getAllSubcomponents('vtimezone').some(
      (vtz) => vtz.getFirstPropertyValue('tzid') === tzid,
    );
    if (present) continue;
    const fallback = makeIntlTimezone(tzid);
    if (fallback) {
      ICAL.TimezoneService.register(tzid, fallback);
      if (__DEV__) {
        console.warn('[icloud-cal] VTIMEZONE missing for', tzid, '— Intl fallback');
      }
    }
  }
}

function makeIntlTimezone(tzid: string): ICAL.Timezone | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
  } catch {
    return null;
  }
  const probe = new Date();
  const offsetMin = -getIntlOffsetMinutes(tzid, probe);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const vtimezone = `BEGIN:VTIMEZONE
TZID:${tzid}
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:${sign}${hh}${mm}
TZOFFSETTO:${sign}${hh}${mm}
TZNAME:${tzid}
END:STANDARD
END:VTIMEZONE`;
  try {
    const j = ICAL.parse(`BEGIN:VCALENDAR\nVERSION:2.0\n${vtimezone}\nEND:VCALENDAR`);
    const c = new ICAL.Component(j as [string, unknown[], unknown[]]);
    const tz = new ICAL.Timezone(c.getFirstSubcomponent('vtimezone')!);
    return tz;
  } catch {
    return null;
  }
}

function getIntlOffsetMinutes(tzid: string, atDate: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    timeZoneName: 'shortOffset',
  });
  const parts = dtf.formatToParts(atDate);
  const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(tzPart);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}
```

- [ ] **Step 3: TypeScript check + manual smoke**

```bash
npx tsc --noEmit
```

If you have real iCloud credentials, run a one-off check via `npx tsx` to verify CalDAV PROPFIND succeeds. (Same pattern as Task 5.1's smoke test.) Delete the temp file after.

- [ ] **Step 4: Commit**

```bash
git add src/lib/icloud-calendar.ts
git commit -m "feat(icloud): CalDAV event fetch + ical.js parsing + VTIMEZONE fallback"
```

---

## Phase 6 — Setup screen

### Task 6.1: `IcloudSetupScreen` (capture, validate, persist)

**Files:**
- Create: `src/screens/IcloudSetupScreen.tsx`
- Modify: `App.tsx` (or wherever the screen routing lives)

- [ ] **Step 1: Identify existing navigation pattern**

Run: `grep -n "SettingsScreen\|setScreen\|navigate" /Users/albertfeldt/ZolvaApp/App.tsx | head -10`

Note how screens are currently registered (manual screen-state union, React Navigation, etc.). The new `'icloud-setup'` route plugs into the same mechanism.

- [ ] **Step 2: Write the screen**

```tsx
// src/screens/IcloudSetupScreen.tsx
import { useEffect, useState } from 'react';
import {
  AppState,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Eye, EyeOff } from 'lucide-react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { useAuth } from '../lib/auth';
import { saveCredential } from '../lib/icloud-credentials';
import { validate as validateImap } from '../lib/icloud-mail';
import { probeCredential as probeCalDav } from '../lib/icloud-calendar';
import { colors, fonts } from '../theme';

type Props = {
  prefilledEmail?: string;
  onDone: () => void;
  onCancel: () => void;
};

const APPLE_ID_URL = 'https://appleid.apple.com/account/manage';
const APPLE_DOMAINS = ['@me.com', '@icloud.com', '@mac.com'];

type SubmitError =
  | 'auth-failed'
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'protocol';

export function IcloudSetupScreen({ prefilledEmail, onDone, onCancel }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { user } = useAuth();
  const [email, setEmail] = useState(prefilledEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [pwdWarning, setPwdWarning] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [busy, setBusy] = useState(false);

  // Clear errors when app comes back from background — user may have gone
  // to fix something in Apple settings and returned.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setSubmitError(null);
    });
    return () => sub.remove();
  }, []);

  const onEmailBlur = () => {
    if (!email) { setEmailWarning(null); return; }
    const lower = email.trim().toLowerCase();
    const ok = APPLE_DOMAINS.some((d) => lower.endsWith(d));
    setEmailWarning(ok ? null
      : 'iCloud kræver en @me.com, @icloud.com eller @mac.com adresse. Tjek at du har skrevet din iCloud-mail (ikke fx @gmail.com).');
  };

  const onPwdChange = (next: string) => {
    setPassword(next);
    setSubmitError(null);
    if (next.length < 8) { setPwdWarning(null); return; }
    const stripped = next.replace(/[\s-]/g, '');
    const looksRight = /^[a-z]{16}$/.test(stripped);
    setPwdWarning(looksRight ? null
      : 'Det ligner ikke en app-specifik adgangskode (xxxx-xxxx-xxxx-xxxx). Tjek at du har genereret en ny adgangskode på Apples side — din normale Apple-adgangskode virker ikke her.');
  };

  const openAppleId = async () => {
    try {
      await WebBrowser.openBrowserAsync(APPLE_ID_URL);
    } catch {
      void Linking.openURL(APPLE_ID_URL);
    }
  };

  const onSubmit = async () => {
    if (!user?.id) { setSubmitError('auth-failed'); return; }
    setBusy(true);
    setSubmitError(null);
    try {
      const [imapRes, calRes] = await Promise.all([
        validateImap(email, password),
        probeCalDav(email, password),
      ]);
      if (!imapRes.ok) { setSubmitError(mapToSubmitError(imapRes.error)); return; }
      if (!calRes.ok)  { setSubmitError(mapToSubmitError(calRes.error)); return; }
      await saveCredential(user.id, email, password);
      onDone();
    } catch {
      setSubmitError('protocol');
    } finally {
      setBusy(false);
    }
  };

  const submitDisabled = !email || !password || busy;

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>FORBIND ICLOUD</Text>
        <Text style={styles.heroH1}>Forbind iCloud</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.body}>
          Apple kræver en særlig adgangskode (én til hver app), så Zolva kan læse din mail og kalender. Du laver den selv på Apples side — det tager omkring et minut.
        </Text>

        <View style={styles.guide}>
          <Step n="1" title="Åbn Apples side">
            <Pressable style={styles.primaryBtn} onPress={openAppleId} accessibilityRole="button">
              <Text style={styles.primaryBtnText}>Åbn appleid.apple.com</Text>
            </Pressable>
          </Step>
          <Step n="2" title='Tryk på "Sign-In and Security" → "App-Specific Passwords"'>
            {/* TODO Task 10.3: replace placeholder with actual screenshot asset */}
            <View style={styles.screenshotPlaceholder}>
              <Text style={styles.screenshotPlaceholderText}>[Skærmbillede tilføjes]</Text>
            </View>
          </Step>
          <Step n="3" title='Generér en ny adgangskode og navngiv den "Zolva"'>
            <Text style={styles.warn}>Apple viser kun adgangskoden én gang. Kopiér den med det samme.</Text>
          </Step>
          <Step n="4" title="Skift tilbage til Zolva og udfyld nedenfor" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>iCloud-email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={(t) => { setEmail(t); setSubmitError(null); }}
            onBlur={onEmailBlur}
            placeholder="navn@me.com / @icloud.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
          />
          {emailWarning && <Text style={styles.warn}>{emailWarning}</Text>}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>App-specifik adgangskode</Text>
          <View style={styles.pwdRow}>
            <TextInput
              style={[styles.input, styles.pwdInput]}
              value={password}
              onChangeText={onPwdChange}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              secureTextEntry={!showPwd}
            />
            <Pressable
              onPress={() => setShowPwd((v) => !v)}
              style={styles.eyeBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={showPwd ? 'Skjul adgangskode' : 'Vis adgangskode'}
            >
              {showPwd ? <EyeOff size={18} color={colors.fg3} /> : <Eye size={18} color={colors.fg3} />}
            </Pressable>
          </View>
          {pwdWarning && <Text style={styles.warn}>{pwdWarning}</Text>}
        </View>

        {submitError && (
          <Text style={styles.errorBox}>{messageFor(submitError)}</Text>
        )}

        <Pressable
          onPress={onSubmit}
          disabled={submitDisabled}
          style={[styles.submitBtn, submitDisabled && styles.submitBtnDisabled]}
          accessibilityRole="button"
        >
          <Text style={styles.submitBtnText}>
            {busy ? 'Tester forbindelse…' : 'Forbind'}
          </Text>
        </Pressable>

        <Pressable onPress={onCancel} style={styles.cancelBtn} accessibilityRole="button">
          <Text style={styles.cancelBtnText}>Annullér</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Step({ n, title, children }: { n: string; title: string; children?: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepHeadRow}>
        <Text style={styles.stepNum}>{n}</Text>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      {children && <View style={styles.stepBody}>{children}</View>}
    </View>
  );
}

function mapToSubmitError(code: string): SubmitError {
  if (code === 'auth-failed' || code === 'network' || code === 'timeout' || code === 'rate-limited' || code === 'protocol') {
    return code;
  }
  return 'protocol';
}

function messageFor(e: SubmitError): string {
  switch (e) {
    case 'auth-failed':  return 'Forkert email eller adgangskode. Tjek at du har lavet en app-specifik adgangskode (ikke din normale Apple-adgangskode).';
    case 'network':      return 'Ingen forbindelse til Apple. Tjek dit internet og prøv igen.';
    case 'timeout':      return 'Apple svarer ikke. Prøv igen om lidt.';
    case 'rate-limited': return 'For mange forsøg. Prøv igen om en time.';
    case 'protocol':     return 'Noget gik galt på Apples side. Prøv igen om lidt.';
  }
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, backgroundColor: colors.paper },
  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56, paddingBottom: 22, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12, fontFamily: fonts.displayItalic, fontSize: 36,
    lineHeight: 40, letterSpacing: -1.08, color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  guide: { marginTop: 24, gap: 18 },
  step: { gap: 8 },
  stepHeadRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  stepNum: {
    fontFamily: fonts.display, fontSize: 22, color: colors.sageDeep, width: 22,
  },
  stepTitle: {
    flex: 1, fontFamily: fonts.uiSemi, fontSize: 14, lineHeight: 20, color: colors.ink,
  },
  stepBody: { paddingLeft: 34 },
  primaryBtn: {
    backgroundColor: colors.sageDeep,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8,
    alignItems: 'center', alignSelf: 'flex-start',
  },
  primaryBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 14, color: colors.paper,
  },
  screenshotPlaceholder: {
    height: 120, backgroundColor: colors.mist, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  screenshotPlaceholderText: {
    fontFamily: fonts.mono, fontSize: 11, color: colors.fg3,
  },
  field: { marginTop: 24, gap: 6 },
  label: {
    fontFamily: fonts.uiSemi, fontSize: 12, letterSpacing: 0.4,
    textTransform: 'uppercase', color: colors.fg3,
  },
  input: {
    fontFamily: fonts.ui, fontSize: 15, color: colors.ink,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12,
    backgroundColor: colors.paper,
  },
  pwdRow: { position: 'relative' },
  pwdInput: { fontFamily: fonts.mono, paddingRight: 44 },
  eyeBtn: {
    position: 'absolute', right: 8, top: 0, bottom: 0,
    width: 36, alignItems: 'center', justifyContent: 'center',
  },
  warn: {
    marginTop: 4,
    fontFamily: fonts.ui, fontSize: 12, lineHeight: 18, color: colors.warningInk,
  },
  errorBox: {
    marginTop: 16, padding: 12, borderRadius: 8,
    backgroundColor: colors.warningSoft,
    fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.warningInk,
  },
  submitBtn: {
    marginTop: 24, backgroundColor: colors.ink,
    paddingVertical: 14, borderRadius: 8, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: {
    fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper,
  },
  cancelBtn: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: {
    fontFamily: fonts.ui, fontSize: 14, color: colors.fg3,
  },
});
```

- [ ] **Step 3: Wire into navigation**

Add `IcloudSetupScreen` as a sibling route to SettingsScreen. The exact change depends on the project's nav pattern; example for a manual screen-state union in `App.tsx`:

```tsx
import { IcloudSetupScreen } from './src/screens/IcloudSetupScreen';

{screen === 'icloud-setup' && (
  <IcloudSetupScreen
    prefilledEmail={icloudPrefilledEmail}
    onDone={() => setScreen('settings')}
    onCancel={() => setScreen('settings')}
  />
)}
```

- [ ] **Step 4: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/IcloudSetupScreen.tsx App.tsx
git commit -m "feat(icloud): IcloudSetupScreen — capture email + app-specific password"
```

---

## Phase 7 — Hooks integration

### Task 7.1: `useMailItems` iCloud branch

**Files:**
- Modify: `src/lib/hooks.ts` (`useMailItems` function around line 617)

- [ ] **Step 1: Add imports**

Top of `hooks.ts`:

```ts
import { loadCredential } from './icloud-credentials';
import { listInbox as listIcloudMessages } from './icloud-mail';
```

- [ ] **Step 2: Add iCloud connectivity state inside `useMailItems`**

After `useAuth` and the existing state setup:

```ts
  const userId = user?.id ?? '';
  const [icloudConnected, setIcloudConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setIcloudConnected(false); return; }
    void loadCredential(userId).then((c) => {
      if (!cancelled) setIcloudConnected(c.kind === 'valid');
    });
    return () => { cancelled = true; };
  }, [userId]);
```

- [ ] **Step 3: Update the early-return condition**

Find:

```ts
if (!user || (!googleAccessToken && !microsoftAccessToken)) {
```

Replace with:

```ts
if (!user || (!googleAccessToken && !microsoftAccessToken && !icloudConnected)) {
```

- [ ] **Step 4: Add the iCloud fetch task in the parallel branch**

After the existing Microsoft branch in the `tasks.push(...)` section:

```ts
    if (icloudConnected) {
      tasks.push(
        listIcloudMessages(userId, 12).then((r) => {
          if (!r.ok) {
            // markInvalid was already called inside icloud-mail.ts on auth-failed.
            throw new Error(`icloud:${r.error}`);
          }
          return r.data.map((m) => ({
            id: `icloud:${m.uid}`,
            provider: 'icloud' as const,
            from: m.from,
            subject: m.subject,
            receivedAt: m.date,
            isRead: !m.unread,
            preview: m.preview,
          }));
        }),
      );
    }
```

- [ ] **Step 5: Update the dependency array**

```ts
}, [googleAccessToken, microsoftAccessToken, user, icloudConnected, userId]);
```

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```

If `NormalizedMail` doesn't accept `provider: 'icloud'`, find its definition (likely in `hooks.ts` or `types.ts`) and extend the `provider` union to include `'icloud'`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(icloud): wire iCloud mail into useMailItems"
```

---

### Task 7.2: Calendar hook iCloud branch

**Files:**
- Modify: `src/lib/hooks.ts` (the calendar hook — locate via `grep -n "useUpcoming\|useCalendarItems" src/lib/hooks.ts`)

- [ ] **Step 1: Locate the calendar items hook**

Run: `grep -n "googleapis.com/calendar\|listGoogleCalendarEvents\|graph.microsoft.com" /Users/albertfeldt/ZolvaApp/src/lib/hooks.ts | head -10`

Note its exact name and shape. Mirror it for iCloud.

- [ ] **Step 2: Add iCloud branch (same pattern as Task 7.1)**

```ts
import { listEvents as listIcloudEvents } from './icloud-calendar';
import { calendarRange } from './calendar-horizon'; // added in Task 10.1

// Inside the calendar hook, after the Google/Microsoft tasks:
if (icloudConnected) {
  const { start, end } = calendarRange();
  tasks.push(
    listIcloudEvents(userId, start, end).then((r) => {
      if (!r.ok) throw new Error(`icloud:${r.error}`);
      return r.data.map((e): UpcomingEvent => ({
        id: `icloud:${e.uid}`,
        time: formatTimeRange(e.start, e.end, e.allDay), // existing helper from google branch
        meta: e.calendarName,
        title: e.title,
        sub: e.location ?? '',
        tone: 'sage', // or compute from calendarColor — match google branch logic
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        source: 'icloud',
      }));
    }),
  );
}
```

The exact `UpcomingEvent` fields and `formatTimeRange` helper come from the existing Google branch — read it and mirror.

- [ ] **Step 3: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/lib/hooks.ts
git commit -m "feat(icloud): wire iCloud calendar into useUpcoming/useCalendarItems"
```

---

### Task 7.3: `useHasProvider` reflects iCloud

**Files:**
- Modify: `src/lib/hooks.ts` (around line 691)

- [ ] **Step 1: Update useHasProvider**

Replace:

```ts
export function useHasProvider(): boolean {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  if (isDemoUser(user)) return true;
  return !!(googleAccessToken || microsoftAccessToken);
}
```

With:

```ts
export function useHasProvider(): boolean {
  const { googleAccessToken, microsoftAccessToken, user } = useAuth();
  const userId = user?.id ?? '';
  const [icloudConnected, setIcloudConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setIcloudConnected(false); return; }
    void loadCredential(userId).then((c) => {
      if (!cancelled) setIcloudConnected(c.kind === 'valid');
    });
    return () => { cancelled = true; };
  }, [userId]);
  if (isDemoUser(user)) return true;
  return !!(googleAccessToken || microsoftAccessToken || icloudConnected);
}
```

If the iCloud-connected effect appears in 3+ places (here + 7.1 + 7.2), factor into a `useIcloudConnected()` helper exported from `hooks.ts`.

- [ ] **Step 2: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/lib/hooks.ts
git commit -m "feat(icloud): useHasProvider returns true when iCloud credential is valid"
```

---

## Phase 8 — Settings integration

### Task 8.1: New `'icloud'` connection row + STATUS_LABEL update

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Update STATUS_LABEL**

Around `SettingsScreen.tsx:99-103`. Replace with:

```ts
const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected:    'Forbundet',
  pending:      'Venter',
  expired:      'Genindtast adgangskode',
  disconnected: 'Ikke forbundet',
};
```

- [ ] **Step 2: Update the styles map**

Around `SettingsScreen.tsx:304-311`. Add the `'expired'` branch (visually identical to `'pending'` — warning tone is appropriate for both):

```ts
const pillStyle =
  c.status === 'connected' ? styles.statusSage :
  c.status === 'pending'   ? styles.statusWarn :
  c.status === 'expired'   ? styles.statusWarn :
                             styles.statusNeutral;
const textStyle =
  c.status === 'connected' ? styles.statusTextSage :
  c.status === 'pending'   ? styles.statusTextWarn :
  c.status === 'expired'   ? styles.statusTextWarn :
                             styles.statusTextNeutral;
```

- [ ] **Step 3: Add the 'icloud' connection row**

Find where the `connections` array is built. Add at the top:

```ts
const [icloudCredState, setIcloudCredState] = useState<'absent' | 'valid' | 'invalid'>('absent');
const [icloudEmail, setIcloudEmail] = useState<string | null>(null);
const [icloudReloadVersion, setIcloudReloadVersion] = useState(0);

useEffect(() => {
  let cancelled = false;
  if (!userId) return;
  void loadCredential(userId).then((c) => {
    if (cancelled) return;
    setIcloudCredState(c.kind);
    setIcloudEmail(c.kind !== 'absent' ? c.credential.email : null);
  });
  return () => { cancelled = true; };
}, [userId, icloudReloadVersion]);

const icloudConnection: Connection = {
  id: 'icloud',
  title: 'iCloud',
  sub:
    icloudCredState === 'valid'   ? (icloudEmail ?? 'Mail og kalender')
  : icloudCredState === 'invalid' ? 'Adgangskoden er afvist'
                                  : 'Mail og kalender',
  status:
    icloudCredState === 'valid'   ? 'connected'
  : icloudCredState === 'invalid' ? 'expired'
                                  : 'disconnected',
  logo: 'icloud.png', // overridden by tap-renderer; see step 4
};

const connections = [icloudConnection, ...existingConnections];
```

- [ ] **Step 4: Render the iCloud row's logo with the lucide Cloud icon**

Trademark constraint — don't use Apple's iCloud logo. In the row renderer, special-case:

```tsx
import { Cloud } from 'lucide-react-native';

<View style={styles.logoBox}>
  {c.id === 'icloud'
    ? <Cloud size={28} color={colors.ink} strokeWidth={1.5} />
    : <Image source={LOGOS[c.logo]} style={styles.logo} />
  }
</View>
```

- [ ] **Step 5: Refresh on screen focus**

Find how the project re-runs effects when Settings becomes active (likely a `screen` state changing in App.tsx). Bump `icloudReloadVersion` whenever Settings becomes the active screen, so `loadCredential` re-runs after the user returns from setup.

- [ ] **Step 6: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/SettingsScreen.tsx
git commit -m "feat(icloud): Settings — new iCloud row + 'expired' status styling"
```

---

### Task 8.2: Tap dispatch + disconnect flow

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Special-case the tap dispatch**

Around `SettingsScreen.tsx:315-317`. Replace existing logic:

```ts
const onRowPress =
  c.id === 'icloud'
    ? (c.status === 'connected'
        ? () => confirmIcloudDisconnect()
        : () => openIcloudSetup(icloudEmail))
    : (isConnected
        ? () => handleDisconnect(c.id)
        : () => handleConnect(c.id));
```

- [ ] **Step 2: Add `openIcloudSetup` and `confirmIcloudDisconnect`**

```tsx
import { Alert } from 'react-native';
import { clearCredential } from '../lib/icloud-credentials';
import { clearDiscoveryCacheFor } from '../lib/icloud-calendar';

const openIcloudSetup = (prefilled: string | null) => {
  // Replace with whatever navigation primitive the project uses.
  navigateToIcloudSetup(prefilled ?? undefined);
};

const confirmIcloudDisconnect = () => {
  Alert.alert(
    'Frakobl iCloud?',
    'Mails og kalenderbegivenheder fra iCloud forsvinder fra Zolva.',
    [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Frakobl', style: 'destructive',
        onPress: async () => {
          if (!userId) return;
          await clearCredential(userId);
          await clearDiscoveryCacheFor(userId);
          setIcloudCredState('absent');
          setIcloudEmail(null);
          // Server-side binding row gets swept by cron after 90 days; no
          // client-callable disconnect endpoint exists in v1.
        },
      },
    ],
  );
};
```

- [ ] **Step 3: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/SettingsScreen.tsx
git commit -m "feat(icloud): Settings — connect/disconnect flow + clear discovery cache"
```

---

### Task 8.3: Brief row variants

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/components/WorkPreferenceRow.tsx` (if it needs new optional props)

- [ ] **Step 1: Determine connected-providers state**

In SettingsScreen:

```ts
const hasGoogleOrMicrosoft = !!(googleAccessToken || microsoftAccessToken);
const hasIcloud = icloudCredState === 'valid';
const briefVariant: 'normal' | 'icloud-only' =
  !hasGoogleOrMicrosoft && hasIcloud ? 'icloud-only' : 'normal';
```

- [ ] **Step 2: Render the morning-brief row with variant-specific behaviour**

Find where `morning-brief` is rendered. Replace its block:

```tsx
{r.id === 'morning-brief' && briefVariant === 'icloud-only' ? (
  <View style={styles.disabledPrefRow}>
    <View style={{ flex: 1 }}>
      <Text style={styles.prefTitle}>{r.title}</Text>
      <Text style={styles.prefSub}>Kræver Gmail eller Outlook for nu</Text>
    </View>
    <Pressable onPress={() => setBriefSheetOpen(true)} hitSlop={8}>
      <Text style={styles.linkText}>Læs mere</Text>
    </Pressable>
  </View>
) : (
  <WorkPreferenceRow
    pref={r}
    sub={r.id === 'morning-brief' && hasGoogleOrMicrosoft
      ? `Bruger din ${googleAccessToken ? 'Gmail' : 'Outlook'} konto`
      : undefined}
    onChange={async (v) => { /* existing onChange */ }}
  />
)}
```

`WorkPreferenceRow` may need a new optional `sub` prop — extend its props type if so.

- [ ] **Step 3: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/SettingsScreen.tsx src/components/WorkPreferenceRow.tsx
git commit -m "feat(icloud): brief row shows variant copy for icloud-only / mixed users"
```

---

### Task 8.4: "Læs mere" bottom sheet

**Files:**
- Create: `src/components/IcloudBriefSheet.tsx`
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Reference the existing modal pattern**

Read `src/components/ArchiveModal.tsx` to mirror project conventions.

- [ ] **Step 2: Write the sheet**

```tsx
// src/components/IcloudBriefSheet.tsx
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onConnectGmail: () => void;
};

export function IcloudBriefSheet({ visible, onClose, onConnectGmail }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.h1}>Hvorfor kræver morgenbrief Gmail eller Outlook?</Text>
          <Text style={styles.p}>
            Apple tillader ikke den type baggrundsadgang vi har brug for til at sende dig en automatisk morgenbrief. Vi arbejder på en løsning.
          </Text>
          <Text style={styles.p}>
            Indtil da: forbind Gmail eller Outlook for at få morgenbriefen, eller brug Indbakke-skærmen for at se din iCloud-mail.
          </Text>
          <Pressable style={styles.cta} onPress={() => { onClose(); onConnectGmail(); }} accessibilityRole="button">
            <Text style={styles.ctaText}>Forbind Gmail</Text>
          </Pressable>
          <Pressable style={styles.dismiss} onPress={onClose} accessibilityRole="button">
            <Text style={styles.dismissText}>Luk</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.paper,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    maxHeight: '70%',
  },
  body: { padding: 24, gap: 16 },
  h1: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28, color: colors.ink },
  p: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.ink },
  cta: {
    marginTop: 16, backgroundColor: colors.ink,
    paddingVertical: 14, borderRadius: 8, alignItems: 'center',
  },
  ctaText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
  dismiss: { paddingVertical: 12, alignItems: 'center' },
  dismissText: { fontFamily: fonts.ui, fontSize: 14, color: colors.fg3 },
});
```

- [ ] **Step 3: Mount the sheet in SettingsScreen**

```tsx
const [briefSheetOpen, setBriefSheetOpen] = useState(false);

// At the bottom of SettingsScreen JSX:
<IcloudBriefSheet
  visible={briefSheetOpen}
  onClose={() => setBriefSheetOpen(false)}
  onConnectGmail={() => handleConnect('gmail')}
/>
```

- [ ] **Step 4: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/components/IcloudBriefSheet.tsx src/screens/SettingsScreen.tsx
git commit -m "feat(icloud): bottom sheet for 'why does brief need gmail/outlook'"
```

---

## Phase 9 — Error UX surfaces (banners)

### Task 9.1: Inbox screen — expired iCloud banner

**Files:**
- Modify: `src/screens/InboxScreen.tsx`

- [ ] **Step 1: Read current InboxScreen for banner placement**

Run: `sed -n '83,160p' /Users/albertfeldt/ZolvaApp/src/screens/InboxScreen.tsx`

Find the right insertion point — between the hero and the section head, before the list.

- [ ] **Step 2: Add iCloud expired state detection**

At the top of `InboxScreen`:

```ts
import { AppState } from 'react-native';
import { loadCredential } from '../lib/icloud-credentials';

const { user } = useAuth();
const userId = user?.id ?? '';
const [icloudExpired, setIcloudExpired] = useState(false);
const [icloudExpiredEmail, setIcloudExpiredEmail] = useState<string | null>(null);
useEffect(() => {
  let cancelled = false;
  if (!userId) { setIcloudExpired(false); return; }
  const refresh = () => {
    void loadCredential(userId).then((c) => {
      if (cancelled) return;
      setIcloudExpired(c.kind === 'invalid');
      setIcloudExpiredEmail(c.kind === 'invalid' ? c.credential.email : null);
    });
  };
  refresh();
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
  return () => { cancelled = true; sub.remove(); };
}, [userId]);
```

- [ ] **Step 3: Insert the banner**

Between the hero and section head:

```tsx
{icloudExpired && (
  <Pressable
    style={styles.expiredBanner}
    onPress={() => navigateToIcloudSetup(icloudExpiredEmail ?? undefined)}
    accessibilityRole="button"
  >
    <Text style={styles.expiredBannerText}>
      Apple afviste adgangskoden — iCloud-mails vises ikke. Tryk for at genindtaste.
    </Text>
  </Pressable>
)}
```

Add styles:

```ts
expiredBanner: {
  marginHorizontal: 20, marginTop: 12,
  backgroundColor: colors.warningSoft, padding: 12, borderRadius: 8,
},
expiredBannerText: {
  fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.warningInk,
},
```

- [ ] **Step 4: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/InboxScreen.tsx
git commit -m "feat(icloud): InboxScreen — expired credential banner with re-entry CTA"
```

---

### Task 9.2: Today screen — expired iCloud banner

**Files:**
- Modify: `src/screens/TodayScreen.tsx`

- [ ] **Step 1: Mirror Task 9.1 in TodayScreen**

Same pattern. Banner copy adjusted:

```tsx
{icloudExpired && (
  <Pressable style={styles.expiredBanner} onPress={() => navigateToIcloudSetup(icloudExpiredEmail ?? undefined)}>
    <Text style={styles.expiredBannerText}>
      Apple afviste adgangskoden — iCloud-begivenheder vises ikke. Tryk for at genindtaste.
    </Text>
  </Pressable>
)}
```

Place it above the calendar ribbon / events list, below the hero.

- [ ] **Step 2: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/screens/TodayScreen.tsx
git commit -m "feat(icloud): TodayScreen — expired credential banner"
```

---

## Phase 10 — Final verification + assets

### Task 10.1: Extract `CALENDAR_HORIZON_DAYS` shared constant

**Files:**
- Create: `src/lib/calendar-horizon.ts`
- Modify: `src/lib/google-calendar.ts`
- Modify: `src/lib/hooks.ts` (calendar hook — already passes range to `listIcloudEvents` from Task 7.2)

- [ ] **Step 1: Find the existing constant in google-calendar.ts**

Run: `grep -n "DAYS_FORWARD\|TIME_HORIZON\|7.*86400\|days" /Users/albertfeldt/ZolvaApp/src/lib/google-calendar.ts`

Identify the actual range used. Likely 7 days forward.

- [ ] **Step 2: Extract**

```ts
// src/lib/calendar-horizon.ts
//
// Shared time horizon for calendar fetches across providers (Google,
// Microsoft, iCloud). Keeps Today/Upcoming consistent regardless of
// which provider the event came from.

export const CALENDAR_HORIZON_DAYS = 7;

export function calendarRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + CALENDAR_HORIZON_DAYS);
  return { start, end };
}
```

- [ ] **Step 3: Update google-calendar.ts to use the shared constant**

Replace the inline constant with `import { CALENDAR_HORIZON_DAYS, calendarRange } from './calendar-horizon';`. Adjust call sites.

- [ ] **Step 4: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/lib/calendar-horizon.ts src/lib/google-calendar.ts src/lib/hooks.ts
git commit -m "refactor(calendar): extract shared CALENDAR_HORIZON_DAYS constant"
```

---

### Task 10.2: Android backup config

**Files:**
- Modify: `app.json`

- [ ] **Step 1: Check current backup config**

Run: `grep -E "allowBackup|dataExtractionRules|backup" /Users/albertfeldt/ZolvaApp/app.json /Users/albertfeldt/ZolvaApp/android/app/src/main/AndroidManifest.xml 2>/dev/null`

If nothing matches, the default is `true` (Auto Backup enabled — credentials would sync to Google Drive).

- [ ] **Step 2: Disable Auto Backup in app.json**

In `app.json`, under `expo.android`, add:

```json
"android": {
  "allowBackup": false
}
```

- [ ] **Step 3: Re-prebuild if necessary**

If `android/` directory exists from a previous prebuild:

```bash
npx expo prebuild --clean
```

- [ ] **Step 4: Commit**

```bash
git add app.json android/app/src/main/AndroidManifest.xml
git commit -m "chore(android): disable Auto Backup so iCloud creds don't sync to Google Drive"
```

---

### Task 10.3: Apple settings screenshot asset

**Files:**
- Create: `assets/icloud-app-pwd-step.png` (~30KB)
- Modify: `src/screens/IcloudSetupScreen.tsx`

- [ ] **Step 1: Capture the screenshot**

Sign in to https://appleid.apple.com/account/manage. Navigate to Sign-In and Security → App-Specific Passwords. Screenshot just the menu region. ≤30KB PNG, 800-1200px wide, light background.

Save to `assets/icloud-app-pwd-step.png`.

- [ ] **Step 2: Update IcloudSetupScreen step 2**

Replace the placeholder block:

```tsx
<View style={styles.screenshotPlaceholder}>
  <Text style={styles.screenshotPlaceholderText}>[Skærmbillede tilføjes]</Text>
</View>
```

With:

```tsx
<Image
  source={require('../../assets/icloud-app-pwd-step.png')}
  style={styles.screenshot}
  resizeMode="contain"
  accessibilityLabel="Skærmbillede af Apples Sign-In and Security menu, der viser App-Specific Passwords"
/>
```

Add style:

```ts
screenshot: { width: '100%', height: 160, borderRadius: 8 },
```

Remove the now-unused `screenshotPlaceholder` and `screenshotPlaceholderText` styles.

- [ ] **Step 3: Commit**

```bash
git add assets/icloud-app-pwd-step.png src/screens/IcloudSetupScreen.tsx
git commit -m "feat(icloud): replace placeholder with real Apple-ID screenshot"
```

---

### Task 10.4: End-to-end manual smoke

No code changes — manual verification before declaring v1 done.

- [ ] **Step 1: Fresh install on device**

Wipe the app's secure storage (uninstall + reinstall in dev build). Sign in.

- [ ] **Step 2: Connect iCloud from Settings**

- Tap "iCloud" row → setup screen opens.
- Tap "Åbn appleid.apple.com" → in-app browser opens Apple page.
- Generate an app-specific password named "Zolva-test".
- Return to Zolva, paste email + password.
- Confirm: eye toggle reveals/hides password. Wrong-format warning fires for a regular Apple password. Email-domain warning fires for a non-Apple email.
- Tap "Forbind". Spinner shows briefly. Setup screen pops, Settings shows iCloud row as "Forbundet".

- [ ] **Step 3: Inbox**

Navigate to Inbox. Verify iCloud mail appears (or the inbox is genuinely empty if your iCloud Mail is empty). Mix with any other connected providers.

- [ ] **Step 4: Today / Calendar**

Verify iCloud calendar events appear in Today's ribbon and event list.

- [ ] **Step 5: Brief row state (if iCloud-only)**

Disconnect Gmail/Outlook if connected. Settings should show the morning-brief row as disabled with "Læs mere" link. Tap → bottom sheet opens with explanation + "Forbind Gmail" CTA.

- [ ] **Step 6: Expired credential simulation**

In Apple ID settings, revoke the "Zolva-test" app-specific password. Trigger an inbox refresh in Zolva (pull-to-refresh or app foreground). The first list-inbox call returns auth-failed → Inbox shows the "Apple afviste adgangskoden" banner. Tap → setup screen opens with email pre-filled. Generate new password, paste, submit. Banner clears.

- [ ] **Step 7: Disconnect**

Settings → iCloud row → confirm disconnect. Verify:
- Row flips to "Ikke forbundet"
- Inbox no longer shows iCloud messages
- Today no longer shows iCloud events

- [ ] **Step 8: Delete the test app-specific password from Apple ID**

Cleanup — don't leave "Zolva-test" lying around in Apple ID.

- [ ] **Step 9: Send Allan the deploy message**

From the spec's action items:

> "iCloud-forbindelsen virker nu for Indbakke og I dag. Morgenbriefen bruger fortsat din Gmail. Forvent at briefen er sparsom indtil iCloud-brief-support er klar eller du bruger Gmail mere."

Send via direct channel.

- [ ] **Step 10: Delete the tcp-probe function (if not already deleted)**

```bash
supabase functions delete tcp-probe --project-ref sjkhfkatmeqtsrysixop
```

PROBE_EXPIRY would have killed it 48h after deploy anyway, but explicit cleanup is better.

---

## Self-review notes

The plan covers every spec section: data model (Phase 0.2 + 1.1), trust-model implementation (Phase 1.1 binding table + Phase 2.3 bind-on-first-fetch), credential storage (Phase 3), mail (Phase 4), calendar (Phase 5), setup screen (Phase 6), hooks integration (Phase 7), Settings (Phase 8), error banners (Phase 9), and verification + asset items (Phase 10).

The spec's "Implementation notes" section (deferred improvements: tighter wrong-format check, Genforbind-Gmail edge case, copy honesty, pepper rotation runbook) are not assigned tasks — they're labelled "implementer can adopt without re-review." If the implementer wants any of them, they're 1-15 line additions to existing tasks (Task 6.1 step 2 already implements the tighter wrong-format check; Task 8.4 would gain a Genforbind-Gmail branch in the sheet).

The TCP smoke-test Task 0.1 is the gating prerequisite. If it fails, the whole Phase 2 changes runtime (Fly.io instead of Supabase). The plan's structure makes that pivot localised: only Phase 2 deploy steps and the URL constant in Phase 4 change.

Manual verification steps replace formal tests because the codebase has no test infrastructure. Adding jest/vitest just for this feature would be over-engineering relative to the project's existing conventions.
