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
