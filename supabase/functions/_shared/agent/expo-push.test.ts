// supabase/functions/_shared/agent/expo-push.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { dispatchExpoPush, type PushFetch } from './expo-push.ts';

function makeFetch(): { fetch: PushFetch; last: { url: string; body: string } } {
  const last = { url: '', body: '' };
  return {
    last,
    fetch: async (url, init) => {
      last.url = url;
      last.body = String(init?.body ?? '');
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
    },
  };
}

Deno.test('dispatchExpoPush: posts one message per token to expo push api', async () => {
  const { fetch, last } = makeFetch();
  await dispatchExpoPush({
    fetch,
    tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
    title: 'Zolva',
    body: 'Et udkast venter',
    data: { type: 'agent_proposal', action_id: 'p-1' },
  });
  assertEquals(last.url, 'https://exp.host/--/api/v2/push/send');
  const sent = JSON.parse(last.body) as Array<Record<string, unknown>>;
  assertEquals(sent.length, 2);
  assertEquals(sent[0].to, 'ExponentPushToken[a]');
  assertEquals(sent[0].title, 'Zolva');
  assertEquals(sent[0].data, { type: 'agent_proposal', action_id: 'p-1' });
});

Deno.test('dispatchExpoPush: empty token list is a noop', async () => {
  let calls = 0;
  const fetch: PushFetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  await dispatchExpoPush({
    fetch,
    tokens: [],
    title: 'Zolva',
    body: 'B',
    data: {},
  });
  assertEquals(calls, 0);
});
