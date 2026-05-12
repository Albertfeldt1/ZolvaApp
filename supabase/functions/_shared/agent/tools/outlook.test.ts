import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  outlookCreateDraft,
  outlookSendDraft,
  outlookDeleteDraft,
  type OutlookFetch,
} from './outlook.ts';

function makeFetch(
  responses: Array<{ url: string; status: number; body: unknown }>,
): { fetch: OutlookFetch; calls: Array<{ url: string; method: string; body: string | null }> } {
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
      const isNullBodyStatus = r.status === 204 || r.status === 304;
      return new Response(isNullBodyStatus ? null : JSON.stringify(r.body), { status: r.status });
    },
  };
}

Deno.test('outlookCreateDraft: creates a reply draft via /me/messages/{id}/createReply', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-orig/createReply',
      status: 201,
      body: { id: 'draft-1', conversationId: 't1' },
    },
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1',
      status: 200,
      body: { id: 'draft-1' },
    },
  ]);
  const result = await outlookCreateDraft({
    fetch,
    accessToken: 'tok',
    inReplyToMessageId: 'm-orig',
    bodyText: 'Tak for invitationen.',
  });
  assertEquals(result.draftId, 'draft-1');
  assertEquals(result.reverseToken, { kind: 'graph.draft', draft_id: 'draft-1' });
  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[1].method, 'PATCH');
  const patch = JSON.parse(calls[1].body!);
  assertEquals(patch.body.contentType, 'Text');
  assertEquals(patch.body.content, 'Tak for invitationen.');
});

Deno.test('outlookSendDraft: POSTs /me/messages/{id}/send', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1/send',
      status: 202,
      body: {},
    },
  ]);
  await outlookSendDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
});

Deno.test('outlookDeleteDraft: DELETEs the draft message', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1',
      status: 204,
      body: {},
    },
  ]);
  await outlookDeleteDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls[0].method, 'DELETE');
});

Deno.test('outlookCreateDraft: 4xx surfaces error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-orig/createReply',
      status: 403,
      body: { error: { message: 'insufficient_scope' } },
    },
  ]);
  await assertRejects(
    () =>
      outlookCreateDraft({
        fetch,
        accessToken: 'tok',
        inReplyToMessageId: 'm-orig',
        bodyText: 'b',
      }),
    Error,
    'graph createReply 403',
  );
});
