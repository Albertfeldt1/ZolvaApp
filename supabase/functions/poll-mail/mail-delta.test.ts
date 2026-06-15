import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { fetchGmailSince, fetchGraphSince, type FetchFn } from './mail-delta.ts';

// Builds a fake fetch that routes by URL substring to a queued JSON body.
function routerFetch(routes: Array<{ match: string; body: unknown }>): {
  fetchFn: FetchFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn: FetchFn = (url, _init) => {
    const u = String(url);
    calls.push(u);
    const route = routes.find((r) => u.includes(r.match));
    if (!route) throw new Error(`no route for ${u}`);
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: 200 }));
  };
  return { fetchFn, calls };
}

Deno.test('fetchGraphSince follows @odata.nextLink across pages and accumulates messages', async () => {
  const { fetchFn } = routerFetch([
    {
      match: 'mailFolders/Inbox/messages/delta', // page 1 (existing deltaLink)
      body: {
        value: [{ id: 'm1', subject: 'One', from: { emailAddress: { address: 'a@x.dk' } } }],
        '@odata.nextLink': 'https://graph.microsoft.com/PAGE2',
      },
    },
    {
      match: 'PAGE2',
      body: {
        value: [{ id: 'm2', subject: 'Two', from: { emailAddress: { name: 'B' } } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/DELTA',
      },
    },
  ]);
  const res = await fetchGraphSince('tok', 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=old', fetchFn);
  assertEquals(res.messages.map((m) => m.messageId), ['m1', 'm2']);
  assertEquals(res.nextDeltaLink, 'https://graph.microsoft.com/DELTA');
});

Deno.test('fetchGraphSince baseline walks pages, emits nothing, returns final deltaLink', async () => {
  const { fetchFn } = routerFetch([
    {
      match: 'mailFolders/Inbox/messages/delta',
      body: { value: [{ id: 'x' }], '@odata.nextLink': 'https://graph.microsoft.com/P2' },
    },
    { match: 'P2', body: { value: [{ id: 'y' }], '@odata.deltaLink': 'https://graph.microsoft.com/D' } },
  ]);
  const res = await fetchGraphSince('tok', null, fetchFn);
  assertEquals(res.messages, []);
  assertEquals(res.nextDeltaLink, 'https://graph.microsoft.com/D');
});

Deno.test('fetchGmailSince follows nextPageToken and accumulates added inbox messages', async () => {
  const { fetchFn } = routerFetch([
    { match: 'pageToken=TOK', body: { history: [{ messagesAdded: [{ message: { id: 'm2' } }] }], historyId: '160' } },
    { match: '/history', body: { history: [{ messagesAdded: [{ message: { id: 'm1' } }] }], historyId: '150', nextPageToken: 'TOK' } },
    { match: '/messages/m1', body: { labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'A' }, { name: 'From', value: 'a@x.dk' }] } } },
    { match: '/messages/m2', body: { labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'B' }, { name: 'From', value: 'b@x.dk' }] } } },
  ]);
  const res = await fetchGmailSince('tok', '100', fetchFn);
  assertEquals(res.messages.map((m) => m.messageId), ['m1', 'm2']);
  assertEquals(res.nextHistoryId, '160');
});
