// supabase/functions/_shared/agent/claude.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { callClaude, type ClaudeFetch } from './claude.ts';

function makeFetch(body: unknown, status = 200): { fetch: ClaudeFetch; last: { body: string } } {
  const last = { body: '' };
  return {
    last,
    fetch: async (_url, init) => {
      last.body = String(init?.body ?? '');
      return new Response(JSON.stringify(body), { status });
    },
  };
}

Deno.test('callClaude: sends system + messages + tools, returns parsed body', async () => {
  const { fetch, last } = makeFetch({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 12, output_tokens: 5 },
    stop_reason: 'end_turn',
  });
  const out = await callClaude({
    fetch,
    apiKey: 'sk-fake',
    system: [{ type: 'text', text: 'You are Zolva.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Triage these mails.' }],
    tools: [{ name: 'mail.archive', input_schema: { type: 'object' } }],
  });
  assertEquals(out.usage.input_tokens, 12);
  assertEquals(out.usage.output_tokens, 5);
  assertEquals(out.stop_reason, 'end_turn');
  const sent = JSON.parse(last.body);
  assertEquals(sent.model, 'claude-haiku-4-5-20251001');
  assertEquals(sent.system[0].cache_control, { type: 'ephemeral' });
  assertEquals(sent.tools.length, 1);
});

Deno.test('callClaude: throws on 4xx with body excerpt', async () => {
  const { fetch } = makeFetch({ error: { message: 'bad' } }, 400);
  try {
    await callClaude({
      fetch,
      apiKey: 'sk-fake',
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    });
    throw new Error('expected throw');
  } catch (e) {
    assertEquals(String(e).includes('claude 400'), true);
  }
});
