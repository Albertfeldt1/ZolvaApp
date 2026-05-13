import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { googleListEvents, outlookListEvents, type CalFetch } from './calendar.ts';

Deno.test('googleListEvents: lists events in window with attendees', async () => {
  let calledUrl = '';
  const fetch: CalFetch = async (url) => {
    calledUrl = url;
    return new Response(JSON.stringify({
      items: [
        {
          id: 'evt-1',
          summary: 'Frokost',
          start: { dateTime: '2026-05-14T11:30:00+02:00' },
          end: { dateTime: '2026-05-14T12:30:00+02:00' },
          attendees: [
            { email: 'kollega@example.com' },
            { email: 'albert@example.com', self: true },
          ],
          location: 'Kantinen',
        },
      ],
    }), { status: 200 });
  };
  const events = await googleListEvents({
    fetch,
    accessToken: 'tok',
    startIso: '2026-05-14T00:00:00Z',
    endIso: '2026-05-15T00:00:00Z',
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].title, 'Frokost');
  assertEquals(events[0].start, '2026-05-14T11:30:00+02:00');
  assertEquals(events[0].attendees, ['kollega@example.com']);
  assertEquals(events[0].location, 'Kantinen');
  assertEquals(calledUrl.includes('timeMin=2026-05-14T00%3A00%3A00Z'), true);
  assertEquals(calledUrl.includes('singleEvents=true'), true);
});

Deno.test('googleListEvents: handles all-day events (date instead of dateTime)', async () => {
  const fetch: CalFetch = async () =>
    new Response(JSON.stringify({
      items: [{
        summary: 'Ferie',
        start: { date: '2026-05-20' },
        end: { date: '2026-05-21' },
      }],
    }), { status: 200 });
  const events = await googleListEvents({
    fetch,
    accessToken: 'tok',
    startIso: '2026-05-20T00:00:00Z',
    endIso: '2026-05-22T00:00:00Z',
  });
  assertEquals(events[0].start, '2026-05-20');
  assertEquals(events[0].end, '2026-05-21');
  assertEquals(events[0].attendees, []);
});

Deno.test('googleListEvents: throws with status + detail on non-2xx', async () => {
  const fetch: CalFetch = async () =>
    new Response('{"error":{"message":"Invalid grant"}}', { status: 401 });
  await assertRejects(
    () => googleListEvents({ fetch, accessToken: 'tok', startIso: 'a', endIso: 'b' }),
    Error,
    'google calendar.list 401',
  );
});

Deno.test('outlookListEvents: queries calendarView with start/end + UTC prefer header', async () => {
  let calledUrl = '';
  let preferHeader = '';
  const fetch: CalFetch = async (url, init) => {
    calledUrl = url;
    preferHeader = (init?.headers as Record<string, string> | undefined)?.['prefer'] ?? '';
    return new Response(JSON.stringify({
      value: [{
        subject: 'Standup',
        start: { dateTime: '2026-05-14T09:00:00' },
        end: { dateTime: '2026-05-14T09:15:00' },
        attendees: [
          { type: 'required', emailAddress: { address: 'kollega@example.com' } },
          { type: 'resource', emailAddress: { address: 'rum-103@example.com' } },
        ],
        location: { displayName: 'Mødelokale 1' },
      }],
    }), { status: 200 });
  };
  const events = await outlookListEvents({
    fetch,
    accessToken: 'tok',
    startIso: '2026-05-14T00:00:00Z',
    endIso: '2026-05-15T00:00:00Z',
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].title, 'Standup');
  assertEquals(events[0].attendees, ['kollega@example.com']); // resource filtered out
  assertEquals(events[0].location, 'Mødelokale 1');
  assertEquals(calledUrl.includes('startDateTime=2026-05-14T00%3A00%3A00Z'), true);
  assertEquals(preferHeader.includes('UTC'), true);
});
