import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  outlookCreateDraft,
  outlookSendDraft,
  outlookDeleteDraft,
  outlookMoveMessage,
  outlookSetFlag,
  outlookAddCategory,
  outlookUpdateDraft,
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

Deno.test('outlookMoveMessage: pre-fetches parent folder then POSTs /move with destinationId', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-1?$select=parentFolderId',
      status: 200,
      body: { id: 'm-1', parentFolderId: 'inbox' },
    },
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-1/move',
      status: 201,
      body: { id: 'm-1-moved', parentFolderId: 'archive' },
    },
  ]);
  const result = await outlookMoveMessage({
    fetch,
    accessToken: 'tok',
    messageId: 'm-1',
    destinationFolderId: 'archive',
  });
  assertEquals(result.newMessageId, 'm-1-moved');
  assertEquals(result.reverseToken, {
    kind: 'graph.move',
    new_message_id: 'm-1-moved',
    original_folder_id: 'inbox',
  });
  assertEquals(calls[0].method, 'GET');
  assertEquals(calls[1].method, 'POST');
  assertEquals(JSON.parse(calls[1].body!), { destinationId: 'archive' });
});

Deno.test('outlookMoveMessage: skips pre-fetch when originalFolderId provided', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-2/move',
      status: 201,
      body: { id: 'm-2-moved' },
    },
  ]);
  const result = await outlookMoveMessage({
    fetch,
    accessToken: 'tok',
    messageId: 'm-2',
    destinationFolderId: 'archive',
    originalFolderId: 'inbox',
  });
  assertEquals(result.reverseToken.original_folder_id, 'inbox');
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
});

Deno.test('outlookSetFlag: PATCH /me/messages/{id} flag.flagStatus', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-2',
      status: 200,
      body: { id: 'm-2', flag: { flagStatus: 'flagged' } },
    },
  ]);
  const result = await outlookSetFlag({
    fetch,
    accessToken: 'tok',
    messageId: 'm-2',
    flagged: true,
  });
  assertEquals(result.reverseToken, {
    kind: 'graph.flag',
    message_id: 'm-2',
    previous: 'notFlagged',
  });
  assertEquals(JSON.parse(calls[0].body!), {
    flag: { flagStatus: 'flagged' },
  });
});

Deno.test('outlookAddCategory: PATCH /me/messages/{id} adds category preserving existing', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-3?$select=categories',
      status: 200,
      body: { id: 'm-3', categories: ['Existing'] },
    },
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-3',
      status: 200,
      body: { id: 'm-3', categories: ['Existing', 'Zolva'] },
    },
  ]);
  const result = await outlookAddCategory({
    fetch,
    accessToken: 'tok',
    messageId: 'm-3',
    category: 'Zolva',
  });
  assertEquals(result.reverseToken, {
    kind: 'graph.category',
    message_id: 'm-3',
    category: 'Zolva',
    previous_categories: ['Existing'],
  });
  assertEquals(JSON.parse(calls[1].body!), { categories: ['Existing', 'Zolva'] });
});

Deno.test('outlookUpdateDraft: PATCHes the draft body', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/d1',
      status: 200,
      body: { id: 'd1' },
    },
  ]);
  await outlookUpdateDraft({ fetch, accessToken: 'tok', draftId: 'd1', bodyText: 'Nyt svar' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'PATCH');
  assertEquals(calls[0].url, 'https://graph.microsoft.com/v1.0/me/messages/d1');
  const parsed = JSON.parse(calls[0].body!) as { body: { contentType: string; content: string } };
  assertEquals(parsed.body.contentType, 'Text');
  assertEquals(parsed.body.content, 'Nyt svar');
});

Deno.test('outlookUpdateDraft: 4xx surfaces error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/d1',
      status: 403,
      body: { error: { message: 'insufficient_scope' } },
    },
  ]);
  await assertRejects(
    () => outlookUpdateDraft({ fetch, accessToken: 'tok', draftId: 'd1', bodyText: 'Nyt svar' }),
    Error,
    'graph messages.patch(update draft) 4',
  );
});
