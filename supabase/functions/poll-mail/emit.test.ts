// supabase/functions/poll-mail/emit.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMailNewEventRows, isInboundGmailMessage } from './emit.ts';

Deno.test('isInboundGmailMessage: a received inbox message is inbound', () => {
  assertEquals(isInboundGmailMessage(['INBOX', 'UNREAD', 'IMPORTANT']), true);
});

Deno.test('isInboundGmailMessage: the agent\'s own DRAFT is NOT inbound (breaks the re-draft loop)', () => {
  assertEquals(isInboundGmailMessage(['DRAFT']), false);
  // A draft that also carries INBOX must still be rejected.
  assertEquals(isInboundGmailMessage(['INBOX', 'DRAFT']), false);
});

Deno.test('isInboundGmailMessage: a SENT message is NOT inbound (breaks the auto-send loop)', () => {
  assertEquals(isInboundGmailMessage(['SENT']), false);
});

Deno.test('isInboundGmailMessage: a message not in INBOX (archived/spam) is NOT inbound', () => {
  assertEquals(isInboundGmailMessage(['SPAM']), false);
  assertEquals(isInboundGmailMessage(['CATEGORY_PROMOTIONS']), false);
});

Deno.test('isInboundGmailMessage: missing labels → not inbound (skip rather than risk a loop)', () => {
  assertEquals(isInboundGmailMessage(undefined), false);
  assertEquals(isInboundGmailMessage([]), false);
});

Deno.test('buildMailNewEventRows: one row per gmail message with idem_key', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'google',
    messages: [
      { messageId: 'm1', threadId: 't1', subject: 'Hi', from: 'a@x' },
      { messageId: 'm2', threadId: 't2', subject: 'Hello', from: 'b@x' },
    ],
  });
  assertEquals(rows.length, 2);
  assertEquals(rows[0].kind, 'mail.new');
  assertEquals(rows[0].user_id, 'u-1');
  assertEquals(rows[0].payload, {
    provider: 'google',
    message_id: 'm1',
    thread_id: 't1',
    from: 'a@x',
    subject: 'Hi',
    idem_key: 'google:m1',
  });
});

Deno.test('buildMailNewEventRows: handles missing threadId', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'google',
    messages: [
      { messageId: 'm1', threadId: undefined, subject: 'Hi', from: 'a@x' },
    ],
  });
  assertEquals(rows[0].payload.thread_id, null);
});

Deno.test('buildMailNewEventRows: emits for microsoft with provider=microsoft', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'microsoft',
    messages: [
      { messageId: 'AAMkADk=', threadId: 'AAQkAD=', subject: 'Hej', from: 'kollega@firma.dk' },
    ],
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].kind, 'mail.new');
  assertEquals(rows[0].payload.provider, 'microsoft');
  assertEquals(rows[0].payload.message_id, 'AAMkADk=');
  assertEquals(rows[0].payload.idem_key, 'microsoft:AAMkADk=');
});

Deno.test('buildMailNewEventRows: microsoft handles missing threadId', () => {
  const rows = buildMailNewEventRows({
    userId: 'u-1',
    provider: 'microsoft',
    messages: [
      { messageId: 'AAMkAD=', threadId: undefined, subject: 'Hej', from: 'x@y.com' },
    ],
  });
  assertEquals(rows[0].payload.thread_id, null);
});
