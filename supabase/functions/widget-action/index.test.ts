import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { workerHandler } from './index.ts';
import { verifyJwt } from './jwt.ts';

// --- baseline JWT tests ---

Deno.test('verifyJwt rejects missing token', async () => {
  await assertRejects(() => verifyJwt(null), Error, 'missing');
});

Deno.test('verifyJwt rejects malformed token', async () => {
  await assertRejects(() => verifyJwt('not.a.jwt'), Error);
});

// --- fetch stubbing ---

type FetchStub = {
  anthropic?: (req: Request) => Promise<Response>;
  google?: (req: Request) => Promise<Response>;
  microsoft?: (req: Request) => Promise<Response>;
  supabase?: (req: Request) => Promise<Response>;
};

const originalFetch = globalThis.fetch;
function withFetch(stubs: FetchStub, fn: () => Promise<void>) {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const req = input instanceof Request ? input : new Request(url, init);
    if (url.startsWith('https://api.anthropic.com')) return stubs.anthropic?.(req) ?? new Response('no anthropic stub', { status: 500 });
    if (url.startsWith('https://www.googleapis.com') || url.startsWith('https://oauth2.googleapis.com')) return stubs.google?.(req) ?? new Response('no google stub', { status: 500 });
    if (url.startsWith('https://graph.microsoft.com') || url.startsWith('https://login.microsoftonline.com')) return stubs.microsoft?.(req) ?? new Response('no microsoft stub', { status: 500 });
    if (url.includes('/auth/v1/.well-known/jwks.json')) {
      // JWKS stub: see Task 11 — unit tests bypass real JWT verification by
      // constructing handler-level fixtures. For these end-to-end tests we
      // call workerHandler directly with an authorization header that the
      // stub on Supabase REST will accept.
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }
    if (url.includes('.supabase.co/rest/v1/')) return stubs.supabase?.(req) ?? new Response('[]', { status: 200 });
    return originalFetch(input as RequestInfo, init);
  };
  return fn().finally(() => { globalThis.fetch = originalFetch; });
}

// --- request helper ---

const makeReq = (prompt: string) =>
  new Request('http://localhost/widget-action', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer FAKE',
    },
    body: JSON.stringify({ prompt, timezone: 'Europe/Copenhagen' }),
  });

// --- standard claude responses ---

const okClaude = (override: Partial<{
  title: string; start: string; end: string;
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
}> = {}) =>
  new Response(JSON.stringify({
    content: [{ type: 'tool_use', name: 'create_calendar_event', input: {
      title: 'Møde med Sophie',
      start: '2026-04-29T17:00:00+02:00',
      calendar_label: null,
      prompt_language: 'da',
      ...override,
    } }],
    usage: { input_tokens: 100, output_tokens: 30 },
    model: 'claude-haiku-4-5-20251001',
  }), { status: 200 });

// --- supabase profile-row stub helper ---

function profileResp(work: null | { provider: 'google' | 'microsoft'; id: string }, personal: null | { provider: 'google' | 'microsoft'; id: string }) {
  return new Response(JSON.stringify([{
    work_calendar_provider: work?.provider ?? null,
    work_calendar_id: work?.id ?? null,
    personal_calendar_provider: personal?.provider ?? null,
    personal_calendar_id: personal?.id ?? null,
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
}

// --- environment overrides for tests (test-only bypass for JWT) ---

Deno.env.set('WIDGET_ACTION_TEST_USER_ID', '28c51177-aaaa-bbbb-cccc-ddddeeeeffff');
Deno.env.set('SUPABASE_URL', 'https://sjkhfkatmeqtsrysixop.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role');
Deno.env.set('ANTHROPIC_API_KEY', 'fake-anthropic');

// --- baseline auth ---

Deno.test('rejects missing Authorization header → 401 + logged out snippet', async () => {
  // Temporarily unset the test-user override so the JWT path actually runs.
  const prev = Deno.env.get('WIDGET_ACTION_TEST_USER_ID');
  Deno.env.delete('WIDGET_ACTION_TEST_USER_ID');
  try {
    const res = await workerHandler(
      new Request('http://localhost/widget-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.snippet.deepLink, 'zolva://settings');
  } finally {
    if (prev) Deno.env.set('WIDGET_ACTION_TEST_USER_ID', prev);
  }
});

// --- end-to-end ---

Deno.test('happy path → success snippet with deep link', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ calendar_label: 'work' })),
    supabase: (req) => {
      if (req.url.includes('user_profiles')) return Promise.resolve(profileResp({ provider: 'google', id: 'work@gmail.com' }, null));
      if (req.url.includes('user_oauth_tokens')) return Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt-fake' }]), { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    },
    google: (req) => {
      if (req.url.includes('/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }), { status: 200 }));
      // event POST
      return Promise.resolve(new Response(JSON.stringify({ id: 'event-123', htmlLink: 'https://calendar.google.com/event?eid=abc' }), { status: 200 }));
    },
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde i morgen kl. 17 i min arbejdskalender'));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.snippet.mood, 'happy');
    assertEquals(body.snippet.deepLink.startsWith('https://calendar.google.com'), true);
    assertEquals(body.dialog.length <= 120, true);
    assertEquals(body.snippet.summary.length <= 80, true);
  });
});

Deno.test('truncation: very long Claude title is truncated server-side', async () => {
  const longTitle = 'Møde '.repeat(40); // ~200 chars
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ title: longTitle })),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => req.url.includes('/token')
      ? Promise.resolve(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ id: 'e1', htmlLink: 'https://x' }), { status: 200 })),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.dialog.length <= 120, true);
    assertEquals(body.snippet.summary.length <= 80, true);
    assertEquals(body.dialog.endsWith('…') || body.dialog.length < 120, true);
  });
});

Deno.test('oauth_invalid: refresh fails → worried snippet', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => req.url.includes('/token')
      ? Promise.resolve(new Response('invalid_grant', { status: 400 }))
      : Promise.resolve(new Response('unreachable', { status: 500 })),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.snippet.deepLink, 'zolva://settings#calendars');
  });
});

Deno.test('permission_denied: provider returns 403 → worried snippet with calendar name', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'shared@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: (req) => {
      if (req.url.includes('/token')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }));
      if (req.url.includes('/events')) return Promise.resolve(new Response('forbidden', { status: 403 }));
      // calendarList lookup for the name
      return Promise.resolve(new Response(JSON.stringify({ summary: 'Acme Work Cal' }), { status: 200 }));
    },
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.dialog.includes('Acme Work Cal'), true);
  });
});

Deno.test('no_calendar_labels: no profile config → routes to settings', async () => {
  await withFetch({
    anthropic: () => Promise.resolve(okClaude()),
    supabase: () => Promise.resolve(profileResp(null, null)),
  }, async () => {
    const res = await workerHandler(makeReq('sæt et møde'));
    const body = await res.json();
    assertEquals(body.snippet.deepLink, 'zolva://settings');
  });
});

Deno.test('empty_prompt: blank prompt → worried "what to set up?" snippet', async () => {
  await withFetch({}, async () => {
    const res = await workerHandler(makeReq(''));
    const body = await res.json();
    assertEquals(body.snippet.mood, 'worried');
    assertEquals(body.dialog.includes('Hvad'), true);
  });
});

Deno.test('end-time default: claude omits end → server adds 60min', async () => {
  let receivedBody: string | null = null;
  await withFetch({
    anthropic: () => Promise.resolve(okClaude({ start: '2026-04-29T17:00:00+02:00' })),
    supabase: (req) => req.url.includes('user_profiles')
      ? Promise.resolve(profileResp(null, { provider: 'google', id: 'home@gmail.com' }))
      : req.url.includes('user_oauth_tokens')
      ? Promise.resolve(new Response(JSON.stringify([{ refresh_token: 'rt' }]), { status: 200 }))
      : Promise.resolve(new Response('[]', { status: 200 })),
    google: async (req) => {
      if (req.url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      if (req.url.endsWith('/events')) {
        receivedBody = await req.text();
        return new Response(JSON.stringify({ id: 'e1', htmlLink: 'https://x' }), { status: 200 });
      }
      return new Response('?', { status: 500 });
    },
  }, async () => {
    await workerHandler(makeReq('sæt et møde'));
    if (!receivedBody) throw new Error('event POST never reached');
    const body = JSON.parse(receivedBody) as { start: { dateTime: string }; end: { dateTime: string } };
    // end - start should be 60 min.
    const startMs = new Date(body.start.dateTime).getTime();
    const endMs = new Date(body.end.dateTime).getTime();
    assertEquals(endMs - startMs, 60 * 60 * 1000);
  });
});
