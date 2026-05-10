# Microsoft Custom OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase gotrue's azure provider for the Microsoft connector flow with a custom PKCE flow that talks to `login.microsoftonline.com` directly. Removes the dependency on `graph.microsoft.com/me` returning an email claim, which blocks every Microsoft account whose tenant suppresses the email or whose AAD `mail` attribute is null (`kontakt@lkag.dk` was the surfacing case).

**Architecture:** Client opens login.microsoftonline.com with PKCE → Microsoft 302s the auth code to the app via `zolva://oauth/microsoft/callback` deep link → app POSTs `{code, code_verifier}` to a new `microsoft-oauth-exchange` edge function → function exchanges with Microsoft using the existing client_secret + reuses `_shared/oauth.ts` `parseTokenResponse` and `persistRefreshToken` → returns `access_token`. Connector-only — no Microsoft sign-up. The "linked" signal moves from `auth.identities` to `user_oauth_tokens` row presence so old- and new-flow users look identical to the UI.

**Tech Stack:** Deno + Supabase Edge Functions, TypeScript (React Native / Expo), `expo-web-browser`, `expo-crypto`, `expo-auth-session` (for `makeRedirectUri`), Jest (jest-expo) for client tests, Deno's built-in test runner for edge function.

**Spec:** [docs/superpowers/specs/2026-05-10-microsoft-custom-oauth-design.md](../specs/2026-05-10-microsoft-custom-oauth-design.md)

**Testing reality:** Pure helpers (PKCE generation, callback parsing, state validation, token-response parsing) are TDD'd. The end-to-end OAuth dance can only be verified manually with a real Microsoft account — Phase 4 has the explicit smoke checklist. Per project memory, server commits + deploys ship FIRST, then the client OTA.

---

## File structure

| File | Change |
|---|---|
| `supabase/functions/_shared/oauth.ts` | modify — add `exchangeAuthorizationCode(provider, code, codeVerifier, redirectUri)` reusing existing `parseTokenResponse` and the same env vars as `mintAccessToken` |
| `supabase/functions/_shared/oauth_exchange.test.ts` | create — Deno tests for `exchangeAuthorizationCode` with mocked Microsoft endpoint |
| `supabase/functions/microsoft-oauth-exchange/index.ts` | create — edge function: verify JWT → call `exchangeAuthorizationCode` → `persistRefreshToken` + `mail_watchers` upsert → return access token |
| `supabase/functions/microsoft-oauth-exchange/index.test.ts` | create — Deno integration tests for the handler with mocked Microsoft + service-role client |
| `src/lib/microsoft-oauth.ts` | create — client driver: PKCE generation, build authURL, openAuthSession, parse callback, invoke edge fn, broadcast token |
| `src/lib/__tests__/microsoft-oauth.test.ts` | create — Jest tests for PKCE, parseMicrosoftCallback, state validation, verifier-Map lifecycle |
| `src/lib/hooks.ts` | modify — add `useMicrosoftLinked()` hook reading `user_oauth_tokens` row presence; replace identity-based check in `useConnections` |
| `src/lib/auth.ts` | modify — `signInWithMicrosoft` calls `runMicrosoftOAuth` from new module; remove Microsoft branch from `runOAuth`; harden `disconnectProvider('microsoft')` to tolerate missing identity |
| `src/screens/SettingsScreen.tsx` | modify — line 1408 `microsoftLinked` swap |
| `src/screens/OnboardingFlowScreen.tsx` | modify — line 1104 `microsoftLinked` swap |
| `src/components/CalendarPickerSheet.tsx` | modify — `microsoftLinked` derivation swap |
| `App.tsx` | modify — Microsoft "linked" check (line ~116 area) swap if applicable |

---

## Phase 0 — Azure config (manual, no code)

### Task 0: Add deep-link redirect URI to Azure app registration

**Why first:** The new client flow won't work until Azure accepts `zolva://oauth/microsoft/callback` as a valid redirect URI. Adding it has zero effect on the existing gotrue flow (it uses the Web platform redirect, separate from Mobile). Safe to do well before code lands.

- [ ] **Step 1: Open the Zolva Azure app registration**

In the Azure portal: Azure Active Directory → App registrations → "Zolva" (or whatever the existing app for `MICROSOFT_OAUTH_CLIENT_ID` is named) → Authentication.

- [ ] **Step 2: Add Mobile and desktop applications platform**

If a "Mobile and desktop applications" platform is not already present, click **Add a platform → Mobile and desktop applications**. In the redirect URIs box, enter:

```
zolva://oauth/microsoft/callback
```

Save.

- [ ] **Step 3: Verify the existing Web platform redirect is untouched**

Confirm the Web platform still has `https://auth.zolva.io/auth/v1/callback` (or whatever the gotrue callback for this Supabase project is). It must NOT be removed — the existing gotrue flow for already-linked users still uses it.

- [ ] **Step 4: Verify "Allow public client flows" remains OFF**

Authentication → Advanced settings → "Allow public client flows" must stay OFF. We are a confidential client doing PKCE alongside the secret. This combination has been Azure-supported since 2022.

- [ ] **Step 5: Verify API permissions unchanged**

Confirm Microsoft Graph permissions still include: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.Read`, `offline_access`, `openid`, `email`, `profile`, `User.Read`. We keep `email` / `profile` / `User.Read` even though the new flow doesn't need them — removing them would force every existing user to re-consent on next refresh.

---

## Phase 1 — Server (shared helper + edge function + deploy)

Per project memory: server changes get their own commit and deploy FIRST, before client OTA. Phase 1 ends with the edge function live in production.

### Task 1: Add `exchangeAuthorizationCode` to `_shared/oauth.ts`

**Files:**
- Modify: `supabase/functions/_shared/oauth.ts`

- [ ] **Step 1: Append the new helper at the end of the file**

```ts
// Authorization-code flow exchange. Mirrors mintAccessToken's structure but
// uses grant_type=authorization_code with code_verifier (PKCE) instead of
// grant_type=refresh_token. Returns the same MintedToken shape so callers can
// pull access_token + the freshly issued refresh_token uniformly.
//
// Microsoft requires both client_secret AND code_verifier on confidential
// clients - PKCE is layered on top of the secret, not a replacement.
export async function exchangeAuthorizationCode(
  provider: Provider,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<MintedToken> {
  if (provider !== 'microsoft') {
    throw new Error(`exchangeAuthorizationCode: provider ${provider} not implemented`);
  }
  const clientId = Deno.env.get('MICROSOFT_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_OAUTH_CLIENT_SECRET');
  const tenant = Deno.env.get('MICROSOFT_OAUTH_TENANT') ?? 'common';
  if (!clientId || !clientSecret) throw new Error('microsoft oauth env missing');
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  return parseTokenResponse('microsoft', res);
}
```

Also export the existing internal `MintedToken` type so the edge function and tests can reference its shape:

Find the existing `type MintedToken = {` declaration (around line 198) and add `export` in front:

```ts
export type MintedToken = {
  accessToken: string;
  expiresIn: number;
  rotatedRefreshToken?: string;
};
```

- [ ] **Step 2: Verify the file type-checks**

Run from repo root:

```bash
cd supabase/functions/_shared && deno check --no-lock oauth.ts
```

Expected: no errors. (Deno may emit warnings about unused symbols in test files — ignore.)

### Task 2: Write Deno tests for `exchangeAuthorizationCode`

**Files:**
- Create: `supabase/functions/_shared/oauth_exchange.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exchangeAuthorizationCode, RefreshRejectedError } from './oauth.ts';

const ENV: Record<string, string> = {
  MICROSOFT_OAUTH_CLIENT_ID: 'test-client-id',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'test-secret',
};

function setEnv() {
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
}

function mockFetch(handler: (req: Request) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(req));
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

Deno.test('exchangeAuthorizationCode posts correct body and returns tokens', async () => {
  setEnv();
  let capturedBody = '';
  const restore = mockFetch(async (req) => {
    capturedBody = await req.text();
    return new Response(
      JSON.stringify({ access_token: 'at-x', refresh_token: 'rt-y', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const result = await exchangeAuthorizationCode(
      'microsoft',
      'authcode-1',
      'verifier-2',
      'zolva://oauth/microsoft/callback',
    );
    assertEquals(result.accessToken, 'at-x');
    assertEquals(result.rotatedRefreshToken, 'rt-y');
    assertEquals(result.expiresIn, 3600);
    const params = new URLSearchParams(capturedBody);
    assertEquals(params.get('client_id'), 'test-client-id');
    assertEquals(params.get('client_secret'), 'test-secret');
    assertEquals(params.get('code'), 'authcode-1');
    assertEquals(params.get('code_verifier'), 'verifier-2');
    assertEquals(params.get('redirect_uri'), 'zolva://oauth/microsoft/callback');
    assertEquals(params.get('grant_type'), 'authorization_code');
  } finally {
    restore();
  }
});

Deno.test('exchangeAuthorizationCode bubbles invalid_grant as RefreshRejectedError', async () => {
  setEnv();
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70008: code expired' }),
      { status: 400 },
    ),
  );
  try {
    await assertRejects(
      () => exchangeAuthorizationCode('microsoft', 'c', 'v', 'r'),
      RefreshRejectedError,
    );
  } finally {
    restore();
  }
});

Deno.test('exchangeAuthorizationCode bubbles non-invalid_grant 4xx as Error', async () => {
  setEnv();
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({ error: 'invalid_request', error_description: 'AADSTS90094: admin consent' }),
      { status: 400 },
    ),
  );
  try {
    await assertRejects(
      () => exchangeAuthorizationCode('microsoft', 'c', 'v', 'r'),
      Error,
      'AADSTS90094',
    );
  } finally {
    restore();
  }
});

Deno.test('exchangeAuthorizationCode rejects google for now', async () => {
  setEnv();
  await assertRejects(
    () => exchangeAuthorizationCode('google', 'c', 'v', 'r'),
    Error,
    'not implemented',
  );
});

Deno.test('exchangeAuthorizationCode throws when env missing', async () => {
  Deno.env.delete('MICROSOFT_OAUTH_CLIENT_ID');
  Deno.env.delete('MICROSOFT_OAUTH_CLIENT_SECRET');
  await assertRejects(
    () => exchangeAuthorizationCode('microsoft', 'c', 'v', 'r'),
    Error,
    'microsoft oauth env missing',
  );
  setEnv();
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
cd supabase/functions/_shared && deno test --allow-net --allow-env oauth_exchange.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/oauth.ts supabase/functions/_shared/oauth_exchange.test.ts
git commit -m "feat(oauth): add exchangeAuthorizationCode for PKCE auth-code flow

Mirrors mintAccessToken's shape; reuses parseTokenResponse so error
handling (invalid_grant → RefreshRejectedError) is identical to the
refresh path. Confidential-client PKCE: client_secret AND code_verifier."
```

### Task 3: Create `microsoft-oauth-exchange` edge function

**Files:**
- Create: `supabase/functions/microsoft-oauth-exchange/index.ts`
- Create: `supabase/functions/microsoft-oauth-exchange/deno.json`

- [ ] **Step 1: Create the deno.json**

Write `supabase/functions/microsoft-oauth-exchange/deno.json`:

```json
{
  "imports": {}
}
```

- [ ] **Step 2: Write the function**

Write `supabase/functions/microsoft-oauth-exchange/index.ts`:

```ts
// microsoft-oauth-exchange - Supabase Edge Function (user-scoped).
//
// Exchanges a Microsoft authorization code for access + refresh tokens via
// PKCE, then persists the refresh_token to user_oauth_tokens. This bypasses
// gotrue's azure provider entirely - we never call /me, so accounts whose
// tenant suppresses the email claim (or whose AAD mail attribute is null)
// can connect successfully where gotrue would have 500'd with "Error
// getting user email from external provider". See the design spec for
// the full rationale.
//
// Caller: authenticated Supabase user only. Reads user JWT from the
// Authorization header, verifies via anon client, then uses service-role
// internally to upsert user_oauth_tokens + mail_watchers.
//
// Response:
//   200 { access_token, expires_in } - tokens minted and persisted
//   400 { error: 'invalid-body' }    - missing code / code_verifier / redirect_uri
//   401 { error: 'unauthorized' }    - no/invalid user JWT
//   401 { error: 'invalid-code' }    - Microsoft rejected the auth code
//   502 { error: 'no-refresh-token' }- Microsoft returned 200 with no refresh_token
//                                       (means offline_access scope wasn't granted)
//   400/500 with passthrough for AADSTS errors

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { exchangeAuthorizationCode, RefreshRejectedError } from '../_shared/oauth.ts';

type Body = {
  code?: string;
  code_verifier?: string;
  redirect_uri?: string;
  mail_watcher_enabled?: boolean;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: 'missing env' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'unauthorized' }, 401);
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { return json({ error: 'invalid-body' }, 400); }
  const { code, code_verifier, redirect_uri } = body;
  if (!code || !code_verifier || !redirect_uri) {
    return json({ error: 'invalid-body' }, 400);
  }
  const watcherEnabled = body.mail_watcher_enabled === true;

  let minted;
  try {
    minted = await exchangeAuthorizationCode('microsoft', code, code_verifier, redirect_uri);
  } catch (err) {
    if (err instanceof RefreshRejectedError) {
      console.warn('[microsoft-oauth-exchange] code rejected:', err.message);
      return json({ error: 'invalid-code', detail: err.message }, 401);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[microsoft-oauth-exchange] exchange failed:', msg);
    return json({ error: 'exchange-failed', detail: msg }, 400);
  }

  if (!minted.rotatedRefreshToken) {
    console.warn('[microsoft-oauth-exchange] no refresh_token in response - offline_access not granted?');
    return json({ error: 'no-refresh-token' }, 502);
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: tokenErr } = await service.from('user_oauth_tokens').upsert(
    {
      user_id: userId,
      provider: 'microsoft',
      refresh_token: minted.rotatedRefreshToken,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
  if (tokenErr) {
    console.warn('[microsoft-oauth-exchange] persist token failed:', tokenErr.message);
    return json({ error: 'persist-failed', detail: tokenErr.message }, 500);
  }

  const { error: watcherErr } = await service.from('mail_watchers').upsert(
    {
      user_id: userId,
      provider: 'microsoft',
      enabled: watcherEnabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' },
  );
  if (watcherErr) {
    // Watcher is best-effort - log but don't fail the exchange. The user
    // already has a working refresh token; missing watcher just means cron
    // polling stays off until they re-toggle it in Settings.
    console.warn('[microsoft-oauth-exchange] watcher upsert failed:', watcherErr.message);
  }

  return json({ access_token: minted.accessToken, expires_in: minted.expiresIn });
}

if (import.meta.main) serve(handler);
```

- [ ] **Step 3: Type-check**

Run:

```bash
cd supabase/functions/microsoft-oauth-exchange && deno check --no-lock index.ts
```

Expected: no errors.

### Task 4: Write tests for the edge function handler

**Files:**
- Create: `supabase/functions/microsoft-oauth-exchange/index.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handler } from './index.ts';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
  MICROSOFT_OAUTH_CLIENT_ID: 'test-client-id',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'test-secret',
};
function setEnv() { for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v); }

type FetchHandler = (req: Request) => Promise<Response> | Response;
function mockFetch(handler: FetchHandler) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return Promise.resolve(handler(req));
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

function req(body: unknown, opts: { auth?: string } = {}) {
  return new Request('http://x/microsoft-oauth-exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.auth === undefined
        ? { Authorization: 'Bearer user-jwt' }
        : opts.auth ? { Authorization: opts.auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Build a fetch handler that responds for both supabase REST (getUser, upsert)
// and the Microsoft token endpoint.
function buildFetch(opts: {
  msResponse: { status: number; body: unknown };
  upsertOk?: boolean;
}): FetchHandler {
  const upserts: Array<{ url: string; body: string }> = [];
  const handler: FetchHandler = async (r) => {
    const url = r.url;
    if (url.includes('/auth/v1/user')) {
      return new Response(
        JSON.stringify({ id: 'user-uuid-1', email: 'a@b.c' }),
        { status: 200 },
      );
    }
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify(opts.msResponse.body), { status: opts.msResponse.status });
    }
    if (url.includes('/rest/v1/user_oauth_tokens') || url.includes('/rest/v1/mail_watchers')) {
      upserts.push({ url, body: await r.text() });
      return new Response('[]', { status: opts.upsertOk === false ? 500 : 201 });
    }
    return new Response('not mocked', { status: 599 });
  };
  (handler as unknown as { upserts: typeof upserts }).upserts = upserts;
  return handler;
}

Deno.test('handler rejects non-POST', async () => {
  setEnv();
  const r = await handler(new Request('http://x', { method: 'GET' }));
  assertEquals(r.status, 405);
});

Deno.test('handler rejects missing Authorization', async () => {
  setEnv();
  const restore = mockFetch(buildFetch({ msResponse: { status: 200, body: {} } }));
  try {
    const r = await handler(req({ code: 'c', code_verifier: 'v', redirect_uri: 'r' }, { auth: '' }));
    assertEquals(r.status, 401);
  } finally { restore(); }
});

Deno.test('handler rejects invalid body', async () => {
  setEnv();
  const restore = mockFetch(buildFetch({ msResponse: { status: 200, body: {} } }));
  try {
    const r = await handler(req({ code: 'c' /* no verifier or redirect */ }));
    assertEquals(r.status, 400);
    const j = await r.json();
    assertEquals(j.error, 'invalid-body');
  } finally { restore(); }
});

Deno.test('handler returns 401 invalid-code on Microsoft invalid_grant', async () => {
  setEnv();
  const restore = mockFetch(buildFetch({
    msResponse: {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'AADSTS70008: code expired' },
    },
  }));
  try {
    const r = await handler(req({ code: 'c', code_verifier: 'v', redirect_uri: 'r' }));
    assertEquals(r.status, 401);
    const j = await r.json();
    assertEquals(j.error, 'invalid-code');
  } finally { restore(); }
});

Deno.test('handler returns 502 no-refresh-token when offline_access missing', async () => {
  setEnv();
  const restore = mockFetch(buildFetch({
    msResponse: {
      status: 200,
      body: { access_token: 'at', expires_in: 3600 /* no refresh_token */ },
    },
  }));
  try {
    const r = await handler(req({ code: 'c', code_verifier: 'v', redirect_uri: 'r' }));
    assertEquals(r.status, 502);
    const j = await r.json();
    assertEquals(j.error, 'no-refresh-token');
  } finally { restore(); }
});

Deno.test('handler returns 200 + access_token, upserts both rows', async () => {
  setEnv();
  const fh = buildFetch({
    msResponse: {
      status: 200,
      body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
    },
  });
  const restore = mockFetch(fh);
  try {
    const r = await handler(req({
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'zolva://oauth/microsoft/callback',
      mail_watcher_enabled: true,
    }));
    assertEquals(r.status, 200);
    const j = await r.json();
    assertEquals(j.access_token, 'at-1');
    assertEquals(j.expires_in, 3600);
    const upserts = (fh as unknown as { upserts: Array<{ url: string; body: string }> }).upserts;
    const tokenUpsert = upserts.find((u) => u.url.includes('user_oauth_tokens'));
    const watcherUpsert = upserts.find((u) => u.url.includes('mail_watchers'));
    if (!tokenUpsert) throw new Error('no token upsert');
    if (!watcherUpsert) throw new Error('no watcher upsert');
    const tokenBody = JSON.parse(tokenUpsert.body);
    assertEquals(tokenBody.refresh_token, 'rt-1');
    assertEquals(tokenBody.provider, 'microsoft');
    const watcherBody = JSON.parse(watcherUpsert.body);
    assertEquals(watcherBody.enabled, true);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
cd supabase/functions/microsoft-oauth-exchange && deno test --allow-net --allow-env index.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/microsoft-oauth-exchange/
git commit -m "feat(oauth): add microsoft-oauth-exchange edge function

Server-side PKCE auth-code exchange for the new Microsoft connector flow.
Verifies user JWT, calls exchangeAuthorizationCode helper, persists the
rotated refresh token to user_oauth_tokens and bootstraps mail_watchers,
returns the fresh access_token to the client.

Bypasses gotrue entirely - graph.microsoft.com/me is never called, so
accounts whose tenants suppress the email claim can connect."
```

### Task 5: Deploy the edge function to production

**Files:** none (deploy step)

- [ ] **Step 1: Confirm Supabase CLI is linked to project `sjkhfkatmeqtsrysixop`**

```bash
cat supabase/.temp/project-ref
```

Expected output: `sjkhfkatmeqtsrysixop`

- [ ] **Step 2: Deploy with --no-verify-jwt**

Per project memory (`project_supabase_asymmetric_jwt.md`), Supabase uses ES256 JWTs and edge functions need `--no-verify-jwt` to keep the gateway from rejecting them at the edge. The function itself does `getUser()` to verify.

```bash
supabase functions deploy microsoft-oauth-exchange --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

Expected: "Deployed Functions on project sjkhfkatmeqtsrysixop: microsoft-oauth-exchange"

- [ ] **Step 3: Smoke test the deployed function (no-auth path)**

```bash
curl -i -X POST https://sjkhfkatmeqtsrysixop.functions.supabase.co/microsoft-oauth-exchange \
  -H 'content-type: application/json' \
  -d '{}'
```

Expected: `HTTP/2 401` with body `{"error":"unauthorized"}` — proves the function is live and the auth check works. No real tokens needed for this smoke.

---

## Phase 2 — Client driver + tests

### Task 6: Write client OAuth driver

**Files:**
- Create: `src/lib/microsoft-oauth.ts`

- [ ] **Step 1: Write the module**

```ts
// Microsoft custom OAuth driver - bypasses Supabase's gotrue azure provider.
//
// See docs/superpowers/specs/2026-05-10-microsoft-custom-oauth-design.md for
// the full design and root cause. TL;DR: gotrue 500s when graph.microsoft.com
// /me returns no email claim. We open login.microsoftonline.com directly with
// PKCE, hand the auth code to a server-side edge function for the secret-using
// exchange, and never call /me.

import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

// Hardcoded - must match the redirect URI registered in the Azure app
// registration's "Mobile and desktop applications" platform. Changing this
// requires an Azure portal update first.
export const MICROSOFT_REDIRECT_URI = 'zolva://oauth/microsoft/callback';

const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

const MICROSOFT_SCOPES = [
  'openid',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.Read',
].join(' ');

export type RunMicrosoftOAuthResult =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; cancelled: true }
  | { ok: false; error: Error };

// In-memory state→verifier map. Lives only across the open-browser-then-handle-
// redirect window (~30s typical). If the JS context dies (app killed long enough),
// the user just retaps "Forbind".
const pendingVerifiers = new Map<string, string>();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = '';
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  // 32 random bytes → 43-char base64url verifier (well within RFC 7636's 43-128 range).
  const verifier = base64url(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  // digestStringAsync returns standard base64; convert to base64url.
  const challenge = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

export type ParsedCallback =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

export function parseMicrosoftCallback(rawUrl: string): ParsedCallback {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: 'invalid callback URL' }; }
  const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  const hashParams = new URLSearchParams(hash);
  const errorDesc =
    u.searchParams.get('error_description') ??
    hashParams.get('error_description') ??
    u.searchParams.get('error') ??
    hashParams.get('error');
  if (errorDesc) return { ok: false, error: errorDesc };
  const code = u.searchParams.get('code') ?? hashParams.get('code');
  const state = u.searchParams.get('state') ?? hashParams.get('state');
  if (!code) return { ok: false, error: 'missing code in callback' };
  if (!state) return { ok: false, error: 'missing state in callback' };
  return { ok: true, code, state };
}

export function consumePendingVerifier(state: string): string | null {
  const v = pendingVerifiers.get(state);
  if (v === undefined) return null;
  pendingVerifiers.delete(state);
  return v;
}

export function rememberPendingVerifier(state: string, verifier: string): void {
  pendingVerifiers.set(state, verifier);
}

function buildAuthorizeUrl(input: {
  clientId: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: MICROSOFT_REDIRECT_URI,
    scope: MICROSOFT_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    prompt: 'consent',
  });
  return `${MICROSOFT_AUTHORIZE_URL}?${params.toString()}`;
}

export type RunMicrosoftOAuthDeps = {
  getClientId: () => string | null;
  openAuthSession: (
    url: string,
    redirect: string,
  ) => Promise<{ type: string; url?: string }>;
  invokeExchange: (body: {
    code: string;
    code_verifier: string;
    redirect_uri: string;
    mail_watcher_enabled: boolean;
  }) => Promise<{ data: { access_token?: string; expires_in?: number } | null; error: { message: string; status?: number } | null }>;
  getMailWatcherEnabled: () => boolean;
};

// Pure orchestrator - dependencies injected for tests. Production callers use
// runMicrosoftOAuth which wires real expo-web-browser + supabase.functions.invoke.
export async function runMicrosoftOAuthWithDeps(
  deps: RunMicrosoftOAuthDeps,
): Promise<RunMicrosoftOAuthResult> {
  const clientId = deps.getClientId();
  if (!clientId) return { ok: false, error: new Error('Microsoft OAuth client_id missing') };

  const { verifier, challenge } = await generatePkce();
  const state = base64url(Crypto.getRandomBytes(16));
  rememberPendingVerifier(state, verifier);

  const authUrl = buildAuthorizeUrl({ clientId, challenge, state });
  const result = await deps.openAuthSession(authUrl, MICROSOFT_REDIRECT_URI);
  if (result.type !== 'success' || !result.url) {
    consumePendingVerifier(state); // clean up pending entry
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { ok: false, cancelled: true };
    }
    return { ok: false, error: new Error(`OAuth-flowet blev afbrudt (${result.type})`) };
  }

  const parsed = parseMicrosoftCallback(result.url);
  if (!parsed.ok) {
    consumePendingVerifier(state);
    return { ok: false, error: new Error(parsed.error) };
  }
  const storedVerifier = consumePendingVerifier(parsed.state);
  if (!storedVerifier) {
    return { ok: false, error: new Error('Forbindelsen blev afbrudt - prøv igen') };
  }
  if (parsed.state !== state) {
    return { ok: false, error: new Error('OAuth state mismatch') };
  }

  const exchange = await deps.invokeExchange({
    code: parsed.code,
    code_verifier: storedVerifier,
    redirect_uri: MICROSOFT_REDIRECT_URI,
    mail_watcher_enabled: deps.getMailWatcherEnabled(),
  });
  if (exchange.error) {
    return { ok: false, error: new Error(exchange.error.message) };
  }
  const accessToken = exchange.data?.access_token;
  if (!accessToken) {
    return { ok: false, error: new Error('No access_token returned from exchange') };
  }
  return { ok: true, accessToken, expiresIn: exchange.data?.expires_in ?? 3600 };
}

// Production wrapper - wires real dependencies. Imported by auth.ts.
export async function runMicrosoftOAuth(opts: {
  clientId: string | null;
  mailWatcherEnabled: boolean;
}): Promise<RunMicrosoftOAuthResult> {
  return runMicrosoftOAuthWithDeps({
    getClientId: () => opts.clientId,
    openAuthSession: (url, redirect) =>
      WebBrowser.openAuthSessionAsync(url, redirect) as Promise<{ type: string; url?: string }>,
    invokeExchange: async (body) => {
      const res = await supabase.functions.invoke<{ access_token?: string; expires_in?: number }>(
        'microsoft-oauth-exchange',
        { body },
      );
      return {
        data: res.data,
        error: res.error
          ? { message: res.error.message, status: (res.error as unknown as { status?: number }).status }
          : null,
      };
    },
    getMailWatcherEnabled: () => opts.mailWatcherEnabled,
  });
}
```

- [ ] **Step 2: Type-check**

Run from repo root:

```bash
npx tsc --noEmit src/lib/microsoft-oauth.ts 2>&1 | head -20
```

Expected: no errors specific to `microsoft-oauth.ts`. (The pre-existing `hooks.ts:4961` error from prior memory is unrelated and will appear; ignore it.)

### Task 7: Write Jest tests for the client driver

**Files:**
- Create: `src/lib/__tests__/microsoft-oauth.test.ts`

- [ ] **Step 1: Write the test file**

```ts
// Mock supabase + native crypto/web-browser before importing the SUT, matching
// the project convention (see reminders.test.ts).
jest.mock('../supabase', () => ({ supabase: { functions: { invoke: jest.fn() } } }));
jest.mock('expo-crypto', () => ({
  __esModule: true,
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  // 32 deterministic bytes - enough for tests; actual randomness covered by manual smoke.
  getRandomBytes: (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i + 1)),
  digestStringAsync: jest.fn(async () => 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='),
}));
jest.mock('expo-web-browser', () => ({
  __esModule: true,
  openAuthSessionAsync: jest.fn(),
}));

import {
  generatePkce,
  parseMicrosoftCallback,
  rememberPendingVerifier,
  consumePendingVerifier,
  runMicrosoftOAuthWithDeps,
  MICROSOFT_REDIRECT_URI,
} from '../microsoft-oauth';

describe('generatePkce', () => {
  it('returns verifier in 43-128 char base64url range', async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe('parseMicrosoftCallback', () => {
  it('extracts code and state from query string', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?code=abc&state=xyz');
    expect(r).toEqual({ ok: true, code: 'abc', state: 'xyz' });
  });

  it('extracts code and state from URL fragment', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback#code=abc&state=xyz');
    expect(r).toEqual({ ok: true, code: 'abc', state: 'xyz' });
  });

  it('surfaces error_description', () => {
    const r = parseMicrosoftCallback(
      'zolva://oauth/microsoft/callback?error=consent_required&error_description=AADSTS65001',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('AADSTS65001');
  });

  it('returns error when code missing', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?state=xyz');
    expect(r).toEqual({ ok: false, error: 'missing code in callback' });
  });

  it('returns error when state missing', () => {
    const r = parseMicrosoftCallback('zolva://oauth/microsoft/callback?code=abc');
    expect(r).toEqual({ ok: false, error: 'missing state in callback' });
  });

  it('rejects malformed URL', () => {
    const r = parseMicrosoftCallback('not a url at all');
    expect(r.ok).toBe(false);
  });
});

describe('verifier Map lifecycle', () => {
  it('remember + consume returns the same value once', () => {
    rememberPendingVerifier('s1', 'v1');
    expect(consumePendingVerifier('s1')).toBe('v1');
    expect(consumePendingVerifier('s1')).toBeNull();
  });
});

describe('runMicrosoftOAuthWithDeps', () => {
  const baseDeps = () => ({
    getClientId: () => 'client-x',
    openAuthSession: jest.fn(),
    invokeExchange: jest.fn(),
    getMailWatcherEnabled: () => true,
  });

  it('returns cancelled when WebBrowser cancels', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockResolvedValue({ type: 'cancel' });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(deps.invokeExchange).not.toHaveBeenCalled();
  });

  it('returns error when client_id missing', async () => {
    const deps = baseDeps();
    deps.getClientId = () => null;
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('client_id missing');
  });

  it('surfaces Microsoft error_description from callback', async () => {
    const deps = baseDeps();
    let capturedAuthUrl = '';
    deps.openAuthSession.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
      return {
        type: 'success',
        url: 'zolva://oauth/microsoft/callback?error=consent_required&error_description=AADSTS65001%20admin',
      };
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('AADSTS65001');
    expect(capturedAuthUrl).toContain('login.microsoftonline.com');
    expect(capturedAuthUrl).toContain('code_challenge_method=S256');
    expect(deps.invokeExchange).not.toHaveBeenCalled();
  });

  it('returns access_token on happy path', async () => {
    const deps = baseDeps();
    let capturedState = '';
    deps.openAuthSession.mockImplementation(async (url: string) => {
      const u = new URL(url);
      capturedState = u.searchParams.get('state') ?? '';
      return {
        type: 'success',
        url: `zolva://oauth/microsoft/callback?code=THE_CODE&state=${capturedState}`,
      };
    });
    deps.invokeExchange.mockResolvedValue({
      data: { access_token: 'AT', expires_in: 3600 },
      error: null,
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r).toEqual({ ok: true, accessToken: 'AT', expiresIn: 3600 });
    expect(deps.invokeExchange).toHaveBeenCalledWith({
      code: 'THE_CODE',
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      redirect_uri: MICROSOFT_REDIRECT_URI,
      mail_watcher_enabled: true,
    });
  });

  it('errors when exchange returns no access_token', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockImplementation(async (url: string) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      return { type: 'success', url: `zolva://oauth/microsoft/callback?code=c&state=${state}` };
    });
    deps.invokeExchange.mockResolvedValue({ data: {}, error: null });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('No access_token');
  });

  it('errors with state mismatch when callback state was never issued', async () => {
    const deps = baseDeps();
    deps.openAuthSession.mockResolvedValue({
      type: 'success',
      url: 'zolva://oauth/microsoft/callback?code=c&state=NEVER_ISSUED',
    });
    const r = await runMicrosoftOAuthWithDeps(deps);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error.message).toContain('Forbindelsen blev afbrudt');
  });
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
npx jest src/lib/__tests__/microsoft-oauth.test.ts
```

Expected: all tests pass (15 total across the describes).

- [ ] **Step 3: Commit**

```bash
git add src/lib/microsoft-oauth.ts src/lib/__tests__/microsoft-oauth.test.ts
git commit -m "feat(oauth): add client-side Microsoft PKCE driver

Pure-orchestrator runMicrosoftOAuthWithDeps takes web-browser, exchange-fn,
and mail-watcher-pref as injected dependencies for testability. The
production wrapper runMicrosoftOAuth wires real expo-web-browser and
supabase.functions.invoke. PKCE verifier uses 32 random bytes via expo-crypto;
state mismatch and error_description handling covered by tests."
```

---

## Phase 3 — Wire client to new driver and replace identity checks

### Task 8: Add `useMicrosoftLinked` hook

**Files:**
- Modify: `src/lib/hooks.ts`

- [ ] **Step 1: Add the hook export**

Find a logical location near other token-related hooks (the file is large; near the top with other hook exports is fine). Add:

```ts
// Reads user_oauth_tokens row presence to decide whether Microsoft is
// connected. Replaces user.identities-based checks - works for both old-flow
// (gotrue identity exists, token row exists) and new-flow (no identity, only
// token row) users since both paths populate user_oauth_tokens. Re-checks
// whenever the broadcast access token flips (connect or disconnect events
// both flip it: connect sets non-null, disconnect sets null).
export function useMicrosoftLinked(userId: string | null | undefined): boolean {
  const { microsoftAccessToken } = useAuth();
  const [linked, setLinked] = useState<boolean>(false);
  useEffect(() => {
    if (!userId) { setLinked(false); return; }
    let cancelled = false;
    const check = async () => {
      const { count, error } = await supabase
        .from('user_oauth_tokens')
        .select('user_id', { head: true, count: 'exact' })
        .eq('user_id', userId)
        .eq('provider', 'microsoft');
      if (cancelled) return;
      if (error) {
        // Network/RLS error - keep last-known state, don't flip to false noisily.
        return;
      }
      setLinked((count ?? 0) > 0);
    };
    void check();
    return () => { cancelled = true; };
  // microsoftAccessToken in deps so the row-check re-runs on connect/disconnect.
  }, [userId, microsoftAccessToken]);
  return linked;
}
```

If `useAuth` and `supabase` are not yet imported in `hooks.ts`, add them. (`useAuth` is exported from `./auth`; `supabase` from `./supabase`.) Also add `useEffect`, `useState` to the React import if missing.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep "hooks.ts" | grep -v "hooks.ts(4961" | head
```

Expected: no new errors (the pre-existing 4961 line error is unrelated).

- [ ] **Step 3: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(oauth): add useMicrosoftLinked hook reading user_oauth_tokens

Replaces auth.identities-based linked check across UI callsites. Works
for both legacy gotrue-linked users (token row was written by
persistProviderRefreshToken) and new-flow users (token row written by
microsoft-oauth-exchange edge function). Re-checks on broadcast."
```

### Task 9: Wire `signInWithMicrosoft` to the new driver

**Files:**
- Modify: `src/lib/auth.ts`

- [ ] **Step 1: Add the import**

Near the top of `src/lib/auth.ts`, add to existing imports:

```ts
import { runMicrosoftOAuth } from './microsoft-oauth';
import { getNotificationSettings } from './notification-settings';
```

If `getNotificationSettings` is already imported, skip the second line.

- [ ] **Step 2: Replace `signInWithMicrosoft`**

Find the existing definition (currently around line 554):

```ts
async function signInWithMicrosoft() {
  return runOAuth('azure', MICROSOFT_SCOPES);
}
```

Replace with:

```ts
async function signInWithMicrosoft() {
  const clientId = process.env.EXPO_PUBLIC_MICROSOFT_OAUTH_CLIENT_ID ?? null;
  const result = await runMicrosoftOAuth({
    clientId,
    mailWatcherEnabled: getNotificationSettings().newMail,
  });
  if (result.ok) {
    const uid = currentUserId();
    if (uid) {
      try {
        await secureStorage.setItem(tokenKey('microsoft', uid), result.accessToken);
      } catch (err) {
        if (__DEV__) console.warn('[auth] microsoft token persist failed:', err);
      }
    }
    broadcastMicrosoft(result.accessToken);
    return { data: { session: cachedSession }, error: null };
  }
  if ('cancelled' in result) {
    return { data: null, error: null, cancelled: true } as { data: null; error: null; cancelled: true };
  }
  return { data: null, error: result.error };
}
```

- [ ] **Step 3: Add the `EXPO_PUBLIC_MICROSOFT_OAUTH_CLIENT_ID` env var**

Open `.env` and add:

```
EXPO_PUBLIC_MICROSOFT_OAUTH_CLIENT_ID=<paste-the-MICROSOFT_OAUTH_CLIENT_ID-value-from-supabase-dashboard>
```

(Get the value from Supabase dashboard → Edge Functions → Secrets, OR from the Azure app registration → Application (client) ID. Both should match.)

Add the same key to `.env.example` with a placeholder:

```
EXPO_PUBLIC_MICROSOFT_OAUTH_CLIENT_ID=
```

- [ ] **Step 4: Confirm runOAuth's Microsoft branch is no longer reachable**

`signInWithMicrosoft` no longer calls `runOAuth`. Search to confirm nothing else does:

```bash
grep -n "runOAuth('azure'\|runOAuth(\"azure\"" src/ App.tsx 2>/dev/null
```

Expected: no matches. The Microsoft branch is dead code.

- [ ] **Step 5: Remove the now-dead Microsoft scope constant**

In `src/lib/auth.ts`, the `MICROSOFT_SCOPES` constant (around line 75) is no longer referenced. Delete it. Verify with:

```bash
grep -n "MICROSOFT_SCOPES" src/ App.tsx 2>/dev/null
```

Expected: no matches.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep -v "hooks.ts(4961" | head -20
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth.ts .env.example
git commit -m "feat(oauth): route signInWithMicrosoft through custom PKCE driver

No longer calls runOAuth/gotrue for Microsoft. Reads MICROSOFT_OAUTH_CLIENT_ID
from EXPO_PUBLIC env, calls runMicrosoftOAuth, persists access token to
secure storage and broadcasts on success - same surface contract as the old
function so callers (SettingsScreen, OnboardingFlowScreen, hooks.useConnections,
App.tsx, CalendarPickerSheet, InboxScreen) need no further changes for the
sign-in path itself.

Removes dead MICROSOFT_SCOPES constant."
```

### Task 10: Harden `disconnectProvider('microsoft')` for new-flow users

**Files:**
- Modify: `src/lib/auth.ts`

- [ ] **Step 1: Locate the unlinkIdentity call**

Find the body of `disconnectProvider` (currently starts around line 697). Look for the part that calls `supabase.auth.unlinkIdentity` for Microsoft. New-flow users have no Microsoft identity in `auth.identities`, so this call will return a 422 ("single_identity_not_deletable" or "identity_not_found"). The current code may already tolerate this; verify by reading the function body. If it does NOT swallow the error, wrap the call:

```ts
// New-flow Microsoft users have no auth.identities row to unlink. Tolerate
// the 422 / not-found from gotrue and proceed with the rest of the teardown
// (token row delete, mail_watchers flip, secure-store clear). For old-flow
// users this path still runs and removes the legacy gotrue identity.
try {
  const { error: unlinkErr } = await supabase.auth.unlinkIdentity(microsoftIdentity);
  if (unlinkErr) {
    if (__DEV__) console.log('[auth] disconnectProvider unlinkIdentity (microsoft) returned', unlinkErr.message);
  }
} catch (err) {
  if (__DEV__) console.log('[auth] disconnectProvider unlinkIdentity (microsoft) threw', err);
}
```

If the existing code already calls `unlinkIdentity` only when `microsoftIdentity` exists in `cachedSession?.user?.identities`, no change needed - the new-flow user simply has no identity to unlink, so the call is skipped. Verify the existing branching by reading lines 697-770.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep -v "hooks.ts(4961" | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit (only if changes were made)**

```bash
git add src/lib/auth.ts
git commit -m "fix(oauth): tolerate missing Microsoft identity on disconnect

New-flow Microsoft users have no auth.identities row. The unlinkIdentity
call's 422/not-found is swallowed so the rest of the teardown (token row
delete, mail_watchers flip, secure-store clear) proceeds normally."
```

If no change was needed (existing branching already handles it), skip this commit and note in the next task's commit body.

### Task 11: Replace identity-based "linked" checks across UI

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/screens/OnboardingFlowScreen.tsx`
- Modify: `src/lib/hooks.ts` (the `useConnections` hook)
- Modify: `src/components/CalendarPickerSheet.tsx`
- Modify: `App.tsx` (if a Microsoft-linked check exists there)

- [ ] **Step 1: Update `SettingsScreen.tsx`**

Find line 1408 (or `microsoftLinked = ` near top of `SettingsScreen`):

```ts
const microsoftLinked = !!authUser?.identities?.some((i) => i.provider === 'azure');
```

Change to:

```ts
const microsoftLinked = useMicrosoftLinked(authUser?.id ?? null);
```

Add to the existing import from `'../lib/hooks'`:

```ts
import { /* existing names, */ useMicrosoftLinked } from '../lib/hooks';
```

- [ ] **Step 2: Update `OnboardingFlowScreen.tsx`**

Find line 1104:

```ts
const microsoftLinked = !!user?.identities?.some((i) => i.provider === 'azure');
```

Change to:

```ts
const microsoftLinked = useMicrosoftLinked(user?.id ?? null);
```

Add `useMicrosoftLinked` to the import from `'../lib/hooks'`.

- [ ] **Step 3: Update `useConnections` in `src/lib/hooks.ts`**

Find line 2771 (within `useConnections`):

```ts
const microsoftLinked = !!user?.identities?.some((i) => i.provider === 'azure');
```

Change to:

```ts
const microsoftLinked = useMicrosoftLinked(user?.id ?? null);
```

- [ ] **Step 4: Update `CalendarPickerSheet.tsx`**

Find any `microsoftLinked` derivation in this file. Apply the same swap.

- [ ] **Step 5: Update `App.tsx` if needed**

Search:

```bash
grep -n "identities?.some\|identities\.some" App.tsx
```

If a Microsoft check exists, swap to `useMicrosoftLinked(user?.id ?? null)`. If no Microsoft-specific identity check exists in `App.tsx`, skip.

- [ ] **Step 6: Hunt for stragglers**

```bash
grep -rn "identities.*provider.*azure\|identities.*azure" src/ App.tsx 2>/dev/null
```

Expected: zero matches. If any remain, swap them.

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep -v "hooks.ts(4961" | head -30
```

Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add -A src/screens/SettingsScreen.tsx src/screens/OnboardingFlowScreen.tsx src/lib/hooks.ts src/components/CalendarPickerSheet.tsx App.tsx
git commit -m "refactor(oauth): read Microsoft 'linked' from user_oauth_tokens

Swap auth.identities-based check for useMicrosoftLinked across UI callsites.
Both old-flow and new-flow users populate user_oauth_tokens, so the UI no
longer cares which OAuth path was used. Legacy gotrue identities for old
users remain inert and are never read."
```

---

## Phase 4 — Manual smoke + OTA

### Task 12: Manual smoke test before OTA

**Files:** none (verification)

These are the actual confidence path. Each item that fails must be fixed before proceeding.

- [ ] **Step 1: Build and run the app locally with the new bundle**

```bash
npx expo start --clear
```

Open in Expo Go or dev build. Sign in with `albertfeldt1@gmail.com` (the primary test account from project memory).

- [ ] **Step 2: Happy path — own Microsoft account**

In the app: Settings → Frakobl Outlook (if currently connected) → Forbind Outlook again. Microsoft consent page should appear. Approve. Browser should close and the Outlook button should flip to "Forbundet". Inbox tab should show Outlook messages within ~30s (after first poll).

Expected DB state (verify via Supabase MCP):

```sql
SELECT provider, length(refresh_token) AS tok_len, updated_at
FROM public.user_oauth_tokens
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'albertfeldt1@gmail.com')
  AND provider = 'microsoft';
```

Should show one row with a >100 char refresh_token, updated_at within the last minute.

- [ ] **Step 3: Anders-class smoke (the actual reason this exists)**

Set up a test Microsoft account on a tenant where the `mail` attribute is null. Easiest path: create a free `outlook.com` account (which exposes mail) AND create a `.onmicrosoft.com` user via the Microsoft 365 trial admin center with mail unlicensed — that's the closest to lkag.dk's failure mode.

In the app: connect with this account. Expected: success (where the old flow returned `500: Error getting user email from external provider`). DB row should appear identical to step 2.

If this fails, do NOT proceed. The whole point of the change is to fix this case.

- [ ] **Step 4: Cancelled consent**

Tap Forbind Outlook. When the Microsoft consent page appears, tap "Cancel" / back button. Browser should close. App should NOT show an error dialog. Button should remain "Forbind Outlook".

- [ ] **Step 5: Admin-consent tenant (existing detector still works)**

If you have access to a tenant that returns `AADSTS90094` or `consent_required`, run the connect flow. Expected: `MicrosoftAdminConsentScreen` opens (the existing `detectAdminConsentRequired` regex `/aadsts\d+/i` still catches the error_description from the redirect URL).

If you don't have such a tenant available, skip this step. The change to the regex is logically isolated and the codepath is exercised by Task 7's "AADSTS65001" test.

- [ ] **Step 6: Old-flow regression — complira user**

Do NOT touch the complira user's Microsoft connection. Verify that:

```sql
SELECT provider, updated_at
FROM public.user_oauth_tokens
WHERE user_id = '986d2225-0266-40ae-bfdd-5387df8f454a'
  AND provider = 'microsoft';
```

…still shows their existing row, and their Outlook polling still appears in `mail_events` for that user (check `occurred_at` for any recent rows). The new code MUST NOT have disturbed them.

- [ ] **Step 7: Disconnect → reconnect cycle**

In the app: Settings → Frakobl Outlook. Confirm the prompt. After it completes, run:

```sql
SELECT provider FROM public.user_oauth_tokens
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'albertfeldt1@gmail.com')
  AND provider = 'microsoft';
```

Expected: zero rows. Then reconnect via Forbind Outlook → row reappears, fresh `updated_at`.

If any of these fail, fix the failing surface before continuing.

### Task 13: OTA the client to production

**Files:** none (deploy)

- [ ] **Step 1: Push committed branch to origin/main**

Per project memory, the user pushes; we don't push without explicit permission.

```
[stop here and ask the user]: All Phase 1-3 changes are committed locally on main. Want me to push origin/main now?
```

Wait for "yes" then continue. (If the user runs `git push` themselves via `!`, also acceptable.)

- [ ] **Step 2: Publish OTA**

```bash
eas update --branch production --message "feat(oauth): custom Microsoft PKCE flow (bypass gotrue)" --non-interactive
```

Expected: "Published!" with an update group ID for both Android and iOS.

- [ ] **Step 3: Monitor for 30 minutes**

Watch:
- Supabase auth logs for `/callback` 500s with `Error getting user email` — should drop toward zero (only old clients without OTA pickup will still hit it)
- New entries in edge function logs for `microsoft-oauth-exchange` — should appear as users hit Forbind Outlook
- New `user_oauth_tokens` rows shape-identical to old ones

```bash
# Drop these into the Supabase MCP for monitoring:
# get_logs service=edge-function (filter for microsoft-oauth-exchange)
# get_logs service=auth (filter for "external provider")
```

If a regression appears (e.g., new edge function 500s, or auth-log spikes), roll back via `eas update --branch production --republish --message "rollback"` to the prior update group ID.

### Task 14: Memory + cleanup

**Files:** modify memory

- [ ] **Step 1: Update `feedback_oauth_debugging.md`**

Append a note that the `external provider` 500 from gotrue is now structurally impossible for Microsoft (we don't go through gotrue anymore for Microsoft connect). Keep the note for Google (still gotrue-mediated) and as historical record.

- [ ] **Step 2: After ~2 weeks, optional cleanup**

If gateway logs show no more `external provider` 500s, the defensive branch in `src/utils/danish.ts` (commit `edfee2d`) can be removed. Optional, low-priority.

---

## Out of scope (explicit non-tasks)

- Microsoft sign-up via LoginCard (per spec — connector-only)
- Active migration of existing gotrue identities (left inert per spec)
- Refactoring Google OAuth (still uses runOAuth; works correctly)
- Token revocation at Microsoft on disconnect (no clean endpoint)
