import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { googleCreateEvent, type CalWriteFetch } from './calendar-write.ts';
import { outlookCreateEvent } from './calendar-write.ts';

Deno.test('googleCreateEvent: posts event and returns id + delete reverse token', async () => {
  let captured: { url: string; method: string; body: string } | null = null;
  const fetch: CalWriteFetch = async (url, init) => {
    captured = { url, method: init?.method ?? 'GET', body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ id: 'new-evt-1' }), { status: 200 });
  };
  const out = await googleCreateEvent({
    fetch,
    accessToken: 'tok',
    title: 'Frokost',
    startIso: '2026-06-01T11:00:00Z',
    endIso: '2026-06-01T12:00:00Z',
    attendees: ['a@example.com'],
    location: 'Kantinen',
  });
  assertEquals(out.eventId, 'new-evt-1');
  assertEquals(out.reverseToken, { kind: 'gcal.event_delete', provider: 'google', event_id: 'new-evt-1' });
  assertEquals(captured!.method, 'POST');
  assertEquals(captured!.url.endsWith('/calendars/primary/events'), true);
  const body = JSON.parse(captured!.body);
  assertEquals(body.summary, 'Frokost');
  assertEquals(body.start, { dateTime: '2026-06-01T11:00:00Z', timeZone: 'UTC' });
  assertEquals(body.end, { dateTime: '2026-06-01T12:00:00Z', timeZone: 'UTC' });
  assertEquals(body.location, 'Kantinen');
  assertEquals(body.attendees, [{ email: 'a@example.com' }]);
});

Deno.test('googleCreateEvent: throws with status on non-2xx', async () => {
  const fetch: CalWriteFetch = async () => new Response('{"error":{"message":"bad"}}', { status: 400 });
  await assertRejects(
    () => googleCreateEvent({ fetch, accessToken: 't', title: 'x', startIso: 'a', endIso: 'b' }),
    Error,
    'google calendar.create 400',
  );
});

Deno.test('outlookCreateEvent: posts to /me/events with UTC timeZone and strips Z', async () => {
  let captured: { url: string; method: string; body: string } | null = null;
  const fetch: CalWriteFetch = async (url, init) => {
    captured = { url, method: init?.method ?? 'GET', body: String(init?.body ?? '') };
    return new Response(JSON.stringify({ id: 'ms-evt-1' }), { status: 201 });
  };
  const out = await outlookCreateEvent({
    fetch,
    accessToken: 'tok',
    title: 'Standup',
    startIso: '2026-06-01T09:00:00Z',
    endIso: '2026-06-01T09:15:00Z',
    location: 'Rum 1',
  });
  assertEquals(out.eventId, 'ms-evt-1');
  assertEquals(out.reverseToken, { kind: 'graph.event_delete', provider: 'microsoft', event_id: 'ms-evt-1' });
  assertEquals(captured!.url.endsWith('/v1.0/me/events'), true);
  const body = JSON.parse(captured!.body);
  assertEquals(body.subject, 'Standup');
  assertEquals(body.start, { dateTime: '2026-06-01T09:00:00', timeZone: 'UTC' });
  assertEquals(body.end, { dateTime: '2026-06-01T09:15:00', timeZone: 'UTC' });
  assertEquals(body.location, { displayName: 'Rum 1' });
});
