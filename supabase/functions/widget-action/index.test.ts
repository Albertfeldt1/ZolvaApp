import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { verifyJwt } from './jwt.ts';
import { workerHandler } from './index.ts';

Deno.test('verifyJwt rejects missing token', async () => {
  await assertRejects(() => verifyJwt(null), Error, 'missing');
});

Deno.test('verifyJwt rejects malformed token', async () => {
  await assertRejects(() => verifyJwt('not.a.jwt'), Error);
});

Deno.test('rejects missing Authorization header → 401 + logged out snippet', async () => {
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
});

// claude.ts is fetch-based; stub global fetch for these tests.
const originalFetch = globalThis.fetch;

function stubAnthropic(extraction: Partial<{ title: string; start: string; end: string; calendar_label: string | null; prompt_language: string }>) {
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.anthropic.com')) {
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'tool_use', name: 'create_calendar_event', input: {
          title: 'UNPARSEABLE',
          start: '2026-04-29T17:00:00+02:00',
          calendar_label: null,
          prompt_language: 'unknown',
          ...extraction,
        } }],
        usage: { input_tokens: 100, output_tokens: 30 },
        model: 'claude-haiku-4-5-20251001',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return originalFetch(input as RequestInfo, init);
  };
}

function restoreFetch() { globalThis.fetch = originalFetch; }
