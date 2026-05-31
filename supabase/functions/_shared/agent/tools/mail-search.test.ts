import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { gmailSearch, outlookSearch } from './mail-search.ts';

Deno.test('gmailSearch returns one row per thread with from/subject/snippet', async () => {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.includes('/messages?')) {
      return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'm1', threadId: 't1', snippet: 'Hej om tallene',
      payload: { headers: [
        { name: 'From', value: 'Anders <anders@x.dk>' },
        { name: 'Subject', value: 'Tal til mødet' },
        { name: 'Date', value: 'Tue, 27 May 2026 10:00:00 +0200' },
      ] },
    }), { status: 200 });
  };
  const rows = await gmailSearch({ fetch: fetch as never, accessToken: 'tok', query: 'anders@x.dk', limit: 5 });
  assertEquals(rows.length, 1);
  assertEquals(rows[0], { thread_id: 't1', from: 'Anders <anders@x.dk>', subject: 'Tal til mødet', snippet: 'Hej om tallene', date: 'Tue, 27 May 2026 10:00:00 +0200' });
  assertEquals(calls[0].includes('q=anders%40x.dk'), true);
});

Deno.test('outlookSearch maps Graph $search results', async () => {
  const fetch = async (url: string) => {
    assertEquals(url.includes('%24search') || url.includes('$search'), true);
    return new Response(JSON.stringify({ value: [{
      conversationId: 'c1',
      subject: 'Tal til mødet',
      bodyPreview: 'Hej om tallene',
      receivedDateTime: '2026-05-27T08:00:00Z',
      from: { emailAddress: { name: 'Anders', address: 'anders@x.dk' } },
    }] }), { status: 200 });
  };
  const rows = await outlookSearch({ fetch: fetch as never, accessToken: 'tok', query: 'anders@x.dk', limit: 5 });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].thread_id, 'c1');
  assertEquals(rows[0].from, 'Anders <anders@x.dk>');
  assertEquals(rows[0].subject, 'Tal til mødet');
  assertEquals(rows[0].snippet, 'Hej om tallene');
});
