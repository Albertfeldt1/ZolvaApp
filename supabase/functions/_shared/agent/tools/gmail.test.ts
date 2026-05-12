// supabase/functions/_shared/agent/tools/gmail.test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
} from './gmail.ts';

function makeFetch(
  responses: Array<{ url: string; status: number; body: unknown }>,
): { fetch: GmailFetch; calls: Array<{ url: string; method: string; body: string | null }> } {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const r = responses[i++];
      if (r.url !== url) {
        throw new Error(`unexpected url at step ${i}: got ${url}, want ${r.url}`);
      }
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  };
}

Deno.test('gmailModifyThread: add Receipts label, reverseToken removes it', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 200,
      body: { id: 't1' },
    },
  ]);
  const result = await gmailModifyThread({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    addLabelIds: ['L_RCPT'],
    removeLabelIds: [],
  });
  assertEquals(result.reverseToken, {
    kind: 'gmail.modify',
    thread_id: 't1',
    add_label_ids: [],
    remove_label_ids: ['L_RCPT'],
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
  assertEquals(JSON.parse(calls[0].body!), {
    addLabelIds: ['L_RCPT'],
    removeLabelIds: [],
  });
});

Deno.test('gmailModifyThread: archive (remove INBOX) reverses by re-adding', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 200,
      body: { id: 't1' },
    },
  ]);
  const result = await gmailModifyThread({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    addLabelIds: [],
    removeLabelIds: ['INBOX'],
  });
  assertEquals(result.reverseToken, {
    kind: 'gmail.modify',
    thread_id: 't1',
    add_label_ids: ['INBOX'],
    remove_label_ids: [],
  });
});

Deno.test('gmailModifyThread: surfaces Gmail 4xx as a typed error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify',
      status: 403,
      body: { error: { message: 'insufficient permissions' } },
    },
  ]);
  await assertRejects(
    () =>
      gmailModifyThread({
        fetch,
        accessToken: 'tok',
        threadId: 't1',
        addLabelIds: ['L'],
        removeLabelIds: [],
      }),
    Error,
    'gmail threads.modify 403',
  );
});

Deno.test('resolveLabelId: finds existing label by case-insensitive name', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: {
        labels: [
          { id: 'L_RCPT', name: 'Receipts' },
          { id: 'L_ZOLVA', name: 'Zolva flaggede' },
        ],
      },
    },
  ]);
  const id = await resolveLabelId({ fetch, accessToken: 'tok', name: 'receipts' });
  assertEquals(id, 'L_RCPT');
});

Deno.test('resolveLabelId: creates the Zolva-flagged label when missing', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: { labels: [] },
    },
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      status: 200,
      body: { id: 'L_NEW', name: ZOLVA_FLAGGED_LABEL },
    },
  ]);
  const id = await resolveLabelId({ fetch, accessToken: 'tok', name: ZOLVA_FLAGGED_LABEL });
  assertEquals(id, 'L_NEW');
  assertEquals(calls.length, 2);
  assertEquals(calls[1].method, 'POST');
});
