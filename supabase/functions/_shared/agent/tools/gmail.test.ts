// supabase/functions/_shared/agent/tools/gmail.test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
} from './gmail.ts';
import { gmailCreateDraft, gmailSendDraft, gmailDeleteDraft } from './gmail.ts';

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
      // HTTP 204/304 are null-body statuses; passing a body throws in Deno.
      const nullBodyStatus = r.status === 204 || r.status === 304;
      return new Response(nullBodyStatus ? null : JSON.stringify(r.body), { status: r.status });
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

Deno.test('gmailCreateDraft: posts to drafts endpoint with RFC822 body', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      status: 200,
      body: { id: 'draft-1', message: { id: 'm-1', threadId: 't1' } },
    },
  ]);
  const result = await gmailCreateDraft({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    to: 'recipient@x.com',
    subject: 'Re: Faktura',
    bodyText: 'Tak for fakturaen.',
    inReplyToMessageId: 'm-orig',
  });
  assertEquals(result.draftId, 'draft-1');
  assertEquals(result.messageId, 'm-1');
  assertEquals(result.reverseToken, {
    kind: 'gmail.draft',
    draft_id: 'draft-1',
  });
  assertEquals(calls.length, 1);
  const sent = JSON.parse(calls[0].body!);
  assertEquals(sent.message.threadId, 't1');
  assertEquals(typeof sent.message.raw, 'string');
});

Deno.test('gmailSendDraft: POSTs to drafts/send and returns sent message id', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send',
      status: 200,
      body: { id: 'm-sent', threadId: 't1' },
    },
  ]);
  const result = await gmailSendDraft({
    fetch,
    accessToken: 'tok',
    draftId: 'draft-1',
  });
  assertEquals(result.messageId, 'm-sent');
  assertEquals(calls.length, 1);
  assertEquals(JSON.parse(calls[0].body!), { id: 'draft-1' });
});

Deno.test('gmailDeleteDraft: DELETEs the draft', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1',
      status: 204,
      body: {},
    },
  ]);
  await gmailDeleteDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls[0].method, 'DELETE');
});

Deno.test('gmailDeleteDraft: 404 (already deleted) is treated as success (idempotent undo)', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/gone-1',
      status: 404,
      body: { error: { message: 'Requested entity was not found.' } },
    },
  ]);
  // Must not throw — the draft being gone is the desired end state.
  await gmailDeleteDraft({ fetch, accessToken: 'tok', draftId: 'gone-1' });
});

Deno.test('gmailDeleteDraft: other 4xx still surfaces an error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1',
      status: 403,
      body: { error: { message: 'insufficient scope' } },
    },
  ]);
  let threw = false;
  try {
    await gmailDeleteDraft({ fetch, accessToken: 'tok', draftId: 'd1' });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('gmailCreateDraft: 4xx surfaces error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      status: 403,
      body: { error: { message: 'insufficient scope' } },
    },
  ]);
  await assertRejects(
    () =>
      gmailCreateDraft({
        fetch,
        accessToken: 'tok',
        threadId: 't1',
        to: 'r@x.com',
        subject: 'S',
        bodyText: 'B',
        inReplyToMessageId: 'm',
      }),
    Error,
    'gmail drafts.create 403',
  );
});
