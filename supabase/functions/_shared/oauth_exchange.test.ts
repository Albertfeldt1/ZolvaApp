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
    // Public client (mobile PKCE redirect): Microsoft rejects a client_secret on
    // the authorization_code grant with AADSTS700025. The code_verifier is the
    // proof; the secret must NOT be sent here.
    assertEquals(params.get('client_secret'), null);
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
