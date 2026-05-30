import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  googleCreateEvent,
  outlookCreateEvent,
  googleDeleteEvent,
  outlookDeleteEvent,
  googlePatchEvent,
  outlookPatchEvent,
  googleGetEventPatch,
  outlookGetEventPatch,
  googleUpdateEvent,
  outlookUpdateEvent,
  type CalWriteFetch,
} from './calendar-write.ts';

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
  assertEquals(captured!.method, 'POST');
  const body = JSON.parse(captured!.body);
  assertEquals(body.subject, 'Standup');
  assertEquals(body.start, { dateTime: '2026-06-01T09:00:00', timeZone: 'UTC' });
  assertEquals(body.end, { dateTime: '2026-06-01T09:15:00', timeZone: 'UTC' });
  assertEquals(body.location, { displayName: 'Rum 1' });
});

Deno.test('googleDeleteEvent: DELETEs the event', async () => {
  let captured = '';
  const fetch: CalWriteFetch = async (url, init) => {
    captured = `${init?.method} ${url}`;
    return new Response(null, { status: 204 });
  };
  await googleDeleteEvent({ fetch, accessToken: 't', eventId: 'e1' });
  assertEquals(captured, 'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/e1');
});

Deno.test('googleDeleteEvent: treats 404 as success (idempotent undo)', async () => {
  const fetch: CalWriteFetch = async () => new Response('', { status: 404 });
  await googleDeleteEvent({ fetch, accessToken: 't', eventId: 'gone' });
});

Deno.test('outlookDeleteEvent: treats 404 as success', async () => {
  const fetch: CalWriteFetch = async () => new Response('', { status: 404 });
  await outlookDeleteEvent({ fetch, accessToken: 't', eventId: 'gone' });
});

Deno.test('googlePatchEvent: PATCHes only provided fields', async () => {
  let body = '';
  const fetch: CalWriteFetch = async (_url, init) => {
    body = String(init?.body ?? '');
    return new Response('{}', { status: 200 });
  };
  await googlePatchEvent({ fetch, accessToken: 't', eventId: 'e1', patch: { startIso: '2026-06-02T10:00:00Z' } });
  assertEquals(JSON.parse(body), { start: { dateTime: '2026-06-02T10:00:00Z', timeZone: 'UTC' } });
});

Deno.test('outlookPatchEvent: PATCHes with UTC timeZone and stripped Z', async () => {
  let body = '';
  const fetch: CalWriteFetch = async (_url, init) => {
    body = String(init?.body ?? '');
    return new Response('{}', { status: 200 });
  };
  await outlookPatchEvent({ fetch, accessToken: 't', eventId: 'e1', patch: { startIso: '2026-06-02T10:00:00Z', title: 'Ny' } });
  assertEquals(JSON.parse(body), { start: { dateTime: '2026-06-02T10:00:00', timeZone: 'UTC' }, subject: 'Ny' });
});

Deno.test('googleGetEventPatch: maps current event to EventPatch', async () => {
  const fetch: CalWriteFetch = async () =>
    new Response(JSON.stringify({
      summary: 'Møde', start: { dateTime: '2026-06-02T10:00:00Z' }, end: { dateTime: '2026-06-02T11:00:00Z' }, location: 'A',
    }), { status: 200 });
  const prior = await googleGetEventPatch({ fetch, accessToken: 't', eventId: 'e1' });
  assertEquals(prior, { title: 'Møde', startIso: '2026-06-02T10:00:00Z', endIso: '2026-06-02T11:00:00Z', location: 'A' });
});

Deno.test('outlookGetEventPatch: maps current event to EventPatch', async () => {
  let preferHeader = '';
  const fetch: CalWriteFetch = async (_url, init) => {
    preferHeader = (init?.headers as Record<string, string> | undefined)?.['prefer'] ?? '';
    return new Response(JSON.stringify({
      subject: 'Møde', start: { dateTime: '2026-06-02T10:00:00.0000000' }, end: { dateTime: '2026-06-02T11:00:00.0000000' }, location: { displayName: 'A' },
    }), { status: 200 });
  };
  const prior = await outlookGetEventPatch({ fetch, accessToken: 't', eventId: 'e1' });
  assertEquals(prior, { title: 'Møde', startIso: '2026-06-02T10:00:00.0000000', endIso: '2026-06-02T11:00:00.0000000', location: 'A' });
  assertEquals(preferHeader.includes('UTC'), true);
});

Deno.test('outlookDeleteEvent: treats 410 as success', async () => {
  const fetch: CalWriteFetch = async () => new Response(null, { status: 410 });
  await outlookDeleteEvent({ fetch, accessToken: 't', eventId: 'gone' });
});

Deno.test('googleUpdateEvent: captures prior then patches; restore token carries prior', async () => {
  const calls: string[] = [];
  const fetch: CalWriteFetch = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url.split('/events/')[1] ?? url}`);
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({
        summary: 'Gammel', start: { dateTime: '2026-06-02T10:00:00Z' }, end: { dateTime: '2026-06-02T11:00:00Z' }, location: 'A',
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const out = await googleUpdateEvent({
    fetch, accessToken: 't', eventId: 'e1', patch: { startIso: '2026-06-02T14:00:00Z' },
  });
  assertEquals(out.reverseToken.kind, 'gcal.event_restore');
  assertEquals(out.reverseToken.provider, 'google');
  assertEquals(out.reverseToken.event_id, 'e1');
  assertEquals(out.reverseToken.prior, { title: 'Gammel', startIso: '2026-06-02T10:00:00Z', endIso: '2026-06-02T11:00:00Z', location: 'A' });
  assertEquals(calls[0].startsWith('GET'), true);
  assertEquals(calls[1].startsWith('PATCH'), true);
});

Deno.test('outlookUpdateEvent: restore token carries prior', async () => {
  const fetch: CalWriteFetch = async (_url, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({
        subject: 'Gammel', start: { dateTime: '2026-06-02T10:00:00.0000000' }, end: { dateTime: '2026-06-02T11:00:00.0000000' }, location: { displayName: 'A' },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const out = await outlookUpdateEvent({ fetch, accessToken: 't', eventId: 'e1', patch: { title: 'Ny' } });
  assertEquals(out.reverseToken.kind, 'graph.event_restore');
  assertEquals(out.reverseToken.prior.title, 'Gammel');
});
