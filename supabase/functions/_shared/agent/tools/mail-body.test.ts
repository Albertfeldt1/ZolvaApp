import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { gmailGetBody, outlookGetBody, type GmailFetch, type OutlookFetch } from './mail-body.ts';

Deno.test('gmailGetBody: fetches latest message in thread, decodes text body', async () => {
  const bodyText = 'Hej Albert,\n\nKan vi mødes kl. 12 i morgen?\n\nMvh, Mor';
  // Real Gmail base64url-encodes UTF-8 bytes, not Latin-1 code points. Match that.
  const utf8 = new TextEncoder().encode(bodyText);
  const b64 = btoa(String.fromCharCode(...utf8))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const responses = [
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/t-1?format=metadata',
      body: { id: 't-1', messages: [{ id: 'm-1' }, { id: 'm-2' }] },
    },
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/m-2?format=full',
      body: {
        id: 'm-2',
        internalDate: '1716120000000',
        payload: {
          headers: [
            { name: 'From', value: 'Mor <mor@example.dk>' },
            { name: 'To', value: 'Albert <albert@example.com>' },
            { name: 'Subject', value: 'Frokost?' },
          ],
          body: { data: b64 },
          mimeType: 'text/plain',
        },
      },
    },
  ];
  let i = 0;
  const fetch: GmailFetch = async (url) => {
    const r = responses[i++];
    if (r.url !== url) throw new Error(`unexpected url ${url}`);
    return new Response(JSON.stringify(r.body), { status: 200 });
  };
  const result = await gmailGetBody({ fetch, accessToken: 'tok', threadId: 't-1' });
  assertEquals(result.from, 'Mor <mor@example.dk>');
  assertEquals(result.to, 'Albert <albert@example.com>');
  assertEquals(result.subject, 'Frokost?');
  assertEquals(result.body_text, bodyText);
});

Deno.test('gmailGetBody: throws with status + detail on non-2xx', async () => {
  const fetch: GmailFetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Insufficient Permission' } }), { status: 403 });
  await assertRejects(
    () => gmailGetBody({ fetch, accessToken: 'tok', threadId: 't-x' }),
    Error,
    'gmail threads.get 403',
  );
});

Deno.test('outlookGetBody: strips <style> content from HTML body', async () => {
  const html =
    '<html><head><style>.a{color:red}.b{font-size:99px}</style></head>' +
    '<body><p>Hej Albert,</p><p>Mødes kl. 14?</p></body></html>';
  const fetch: OutlookFetch = async () =>
    new Response(JSON.stringify({
      value: [{
        id: 'm-out-2',
        from: { emailAddress: { name: 'Far', address: 'far@outlook.com' } },
        toRecipients: [{ emailAddress: { address: 'albert@example.com' } }],
        subject: 'Aftale',
        sentDateTime: '2026-05-13T08:00:00Z',
        uniqueBody: { content: html, contentType: 'html' },
      }],
    }), { status: 200 });
  const result = await outlookGetBody({ fetch, accessToken: 'tok', threadId: 'c-2' });
  // CSS rules must NOT bleed into body_text.
  assertEquals(result.body_text.includes('color:red'), false);
  assertEquals(result.body_text.includes('font-size'), false);
  assertEquals(result.body_text, 'Hej Albert, Mødes kl. 14?');
});

Deno.test('outlookGetBody: fetches by conversationId, uses uniqueBody for plain text', async () => {
  const fetch: OutlookFetch = async (url) => {
    if (url.startsWith('https://graph.microsoft.com/v1.0/me/messages')) {
      return new Response(JSON.stringify({
        value: [{
          id: 'm-out-1',
          from: { emailAddress: { name: 'Mor', address: 'mor@outlook.com' } },
          toRecipients: [{ emailAddress: { name: 'Albert', address: 'albert@example.com' } }],
          subject: 'Møde?',
          sentDateTime: '2026-05-13T08:00:00Z',
          uniqueBody: { content: 'Kan du mødes torsdag kl. 14?', contentType: 'text' },
        }],
      }), { status: 200 });
    }
    throw new Error('unexpected url ' + url);
  };
  const result = await outlookGetBody({ fetch, accessToken: 'tok', threadId: 'conv-1' });
  assertEquals(result.subject, 'Møde?');
  assertEquals(result.body_text, 'Kan du mødes torsdag kl. 14?');
  assertEquals(result.from, 'Mor <mor@outlook.com>');
});
