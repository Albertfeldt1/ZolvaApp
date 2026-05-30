# Calendar Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the autonomous mail-triage agent the ability to create and update Google + Outlook calendar events, surfaced as approve-cards on the Today feed and reversible via the existing Undo button.

**Architecture:** Calendar writes reuse the existing propose → approve → execute → undo machinery. The dispatcher returns `mode:'propose'` (no write) on a normal tick and only performs the write when called with `policy:'auto'` (which `agent-approve` already does on user approval). Undo is extended to be provider-aware and to handle four new reverse-token kinds. New API calls live in a focused `calendar-write.ts` module beside the read-only `calendar.ts`.

**Tech Stack:** Deno (Supabase edge functions, TypeScript), `deno test` for server units; React Native + jest/tsc for the client. Google Calendar API v3 and Microsoft Graph v1.0.

---

## Conventions used throughout

- **Run a single server test file:** `cd supabase/functions && deno test <relative/path>.test.ts --allow-env`
- **Run the whole agent suite:** `cd supabase/functions && deno test _shared/agent/ --allow-env`
- **Client type check:** `npx tsc --noEmit` (from repo root)
- **Client jest:** `npm test -- <pattern>` (from repo root)
- **Times contract:** Claude is instructed to pass `start_iso` / `end_iso` as **UTC ISO-8601 ending in `Z`**. Google accepts the `Z` form directly. Outlook (Graph) gets `dateTime` with the trailing `Z` stripped plus `timeZone: 'UTC'`.
- **Reverse-token naming** follows the existing convention: Google kinds use a `gcal.` prefix (alongside `gmail.modify`/`gmail.draft`), Outlook kinds use a `graph.` prefix (alongside `graph.draft`/`graph.move`).

## File structure

**Server — create:**
- `supabase/functions/_shared/agent/tools/calendar-write.ts` — Google + Outlook create/get/patch/delete/update primitives and reverse-token types.
- `supabase/functions/_shared/agent/tools/calendar-write.test.ts` — unit tests for the above.
- `supabase/functions/_shared/agent/tools/reverse-provider.ts` — maps a reverse-token `kind` to its provider.
- `supabase/functions/_shared/agent/tools/reverse-provider.test.ts`

**Server — modify:**
- `supabase/functions/_shared/agent/tools/calendar.ts` — add `id` to `CalEvent` (read tool).
- `supabase/functions/_shared/agent/tools/calendar.test.ts` — assert `id` is returned.
- `supabase/functions/_shared/agent/tools/dispatch.ts` — add `cal.create_event` / `cal.update_event` cases + extend `ExecuteReverseToken`.
- `supabase/functions/_shared/agent/tools/dispatch.test.ts` — tests for the two new cases.
- `supabase/functions/_shared/agent/idem.ts` — idem-key cases for the two actions.
- `supabase/functions/_shared/agent/idem.test.ts` — tests.
- `supabase/functions/_shared/agent/prompt.ts` — tool schemas, name map, system-prompt guidance.
- `supabase/functions/_shared/agent/prompt.test.ts` — tests.
- `supabase/functions/_shared/agent/runner.ts` — `SUPPORTED_ACTIONS`, `NON_THREAD_ACTIONS`, `buildProposalPreview`.
- `supabase/functions/_shared/agent/runner.test.ts` — preview test.
- `supabase/functions/agent-undo/index.ts` — provider-aware token load + new reverse-token kinds.

**Client — modify:**
- `src/lib/agent-feed.ts` — extend `AgentActionRow.action_type` union.
- `src/components/AgentActionCard.tsx` — `TITLES` + `detailFor` cases.
- `src/components/AgentActionPolicySection.tsx` — `ActionType` union + `ROWS`.

---

## Task 1: Add event `id` to the read-only calendar tool

`cal.update_event` needs an event id to target, and the agent only learns ids from `cal_list_events`. Extend `CalEvent` and both readers to surface `id`.

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/calendar.ts`
- Test: `supabase/functions/_shared/agent/tools/calendar.test.ts`

- [ ] **Step 1: Update the existing tests to assert `id`**

In `calendar.test.ts`, in the test `'googleListEvents: lists events in window with attendees'`, add after line 30 (`assertEquals(events.length, 1);`):

```typescript
  assertEquals(events[0].id, 'evt-1');
```

In `'outlookListEvents: queries calendarView with start/end + UTC prefer header'`, change the mocked event to include an id and assert it. Update the `value` array's single object to add `id: 'evt-ms-1',` as its first property, then add after `assertEquals(events.length, 1);`:

```typescript
  assertEquals(events[0].id, 'evt-ms-1');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar.test.ts --allow-env`
Expected: FAIL — `events[0].id` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add `id` to `CalEvent` and both mappers**

In `calendar.ts`, add `id` to the interface:

```typescript
export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
}
```

In `googleListEvents`: add `id` to the `fields` param and the item type, and map it. Change the `fields` value to `'items(id,summary,start,end,attendees(email,self),location)'`, add `id?: string;` to the item type, and add `id: it.id ?? '',` as the first property of the returned object.

In `outlookListEvents`: add `id` to `$select` (change to `$select=id,subject,start,end,attendees,location`), add `id?: string;` to the value item type, and add `id: it.id ?? '',` as the first property of the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/calendar.ts supabase/functions/_shared/agent/tools/calendar.test.ts
git commit -m "feat(agent): expose event id in cal_list_events results"
```

---

## Task 2: Google create-event primitive + reverse token

**Files:**
- Create: `supabase/functions/_shared/agent/tools/calendar-write.ts`
- Test: `supabase/functions/_shared/agent/tools/calendar-write.test.ts`

- [ ] **Step 1: Write the failing test**

Create `calendar-write.test.ts`:

```typescript
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { googleCreateEvent, type CalWriteFetch } from './calendar-write.ts';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: FAIL — module `./calendar-write.ts` not found.

- [ ] **Step 3: Create `calendar-write.ts` with the shared types and `googleCreateEvent`**

```typescript
// Write tools for the agent: create / update calendar events on Google + Outlook.
// Sits beside the read-only calendar.ts. Each create returns a delete reverse
// token; each update reads-then-patches and returns a restore reverse token
// carrying the prior field values.

export type CalWriteFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

// A provider-neutral set of mutable event fields. Used both as the update
// payload and as the captured "prior" state inside a restore reverse token.
export interface EventPatch {
  title?: string;
  startIso?: string;
  endIso?: string;
  location?: string;
}

export interface GcalEventDeleteToken {
  kind: 'gcal.event_delete';
  provider: 'google';
  event_id: string;
}
export interface GcalEventRestoreToken {
  kind: 'gcal.event_restore';
  provider: 'google';
  event_id: string;
  prior: EventPatch;
}
export interface GraphEventDeleteToken {
  kind: 'graph.event_delete';
  provider: 'microsoft';
  event_id: string;
}
export interface GraphEventRestoreToken {
  kind: 'graph.event_restore';
  provider: 'microsoft';
  event_id: string;
  prior: EventPatch;
}

export interface CreateEventInput {
  fetch: CalWriteFetch;
  accessToken: string;
  title: string;
  startIso: string;
  endIso: string;
  attendees?: string[];
  location?: string;
}

const GCAL_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export async function googleCreateEvent(
  input: CreateEventInput,
): Promise<{ eventId: string; reverseToken: GcalEventDeleteToken }> {
  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: input.startIso, timeZone: 'UTC' },
    end: { dateTime: input.endIso, timeZone: 'UTC' },
  };
  if (input.location) body.location = input.location;
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  const res = await input.fetch(GCAL_EVENTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('google calendar.create: response missing id');
  return { eventId: j.id, reverseToken: { kind: 'gcal.event_delete', provider: 'google', event_id: j.id } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/calendar-write.ts supabase/functions/_shared/agent/tools/calendar-write.test.ts
git commit -m "feat(agent): google create-event primitive"
```

---

## Task 3: Outlook create-event primitive

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/calendar-write.ts`
- Test: `supabase/functions/_shared/agent/tools/calendar-write.test.ts`

- [ ] **Step 1: Write the failing test (append to `calendar-write.test.ts`)**

```typescript
import { outlookCreateEvent } from './calendar-write.ts';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: FAIL — `outlookCreateEvent` is not exported.

- [ ] **Step 3: Implement `outlookCreateEvent` + a `stripZone` helper (append to `calendar-write.ts`)**

```typescript
const GRAPH_EVENTS = 'https://graph.microsoft.com/v1.0/me/events';

// Graph wants a naive datetime plus an explicit timeZone; our contract is that
// callers pass UTC ISO ending in Z, so drop the Z and label it UTC.
function stripZone(iso: string): string {
  return iso.replace(/Z$/, '');
}

export async function outlookCreateEvent(
  input: CreateEventInput,
): Promise<{ eventId: string; reverseToken: GraphEventDeleteToken }> {
  const body: Record<string, unknown> = {
    subject: input.title,
    start: { dateTime: stripZone(input.startIso), timeZone: 'UTC' },
    end: { dateTime: stripZone(input.endIso), timeZone: 'UTC' },
  };
  if (input.location) body.location = { displayName: input.location };
  if (input.attendees && input.attendees.length) {
    body.attendees = input.attendees.map((address) => ({
      emailAddress: { address },
      type: 'required',
    }));
  }
  const res = await input.fetch(GRAPH_EVENTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw new Error('graph events.create: response missing id');
  return { eventId: j.id, reverseToken: { kind: 'graph.event_delete', provider: 'microsoft', event_id: j.id } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/calendar-write.ts supabase/functions/_shared/agent/tools/calendar-write.test.ts
git commit -m "feat(agent): outlook create-event primitive"
```

---

## Task 4: Delete + patch + get primitives (both providers, used by update and undo)

These are the lower-level operations update and undo reuse: `googleDeleteEvent`, `outlookDeleteEvent` (idempotent on 404/410), `googleGetEventPatch`, `outlookGetEventPatch`, `googlePatchEvent`, `outlookPatchEvent`.

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/calendar-write.ts`
- Test: `supabase/functions/_shared/agent/tools/calendar-write.test.ts`

- [ ] **Step 1: Write the failing tests (append)**

```typescript
import {
  googleDeleteEvent,
  outlookDeleteEvent,
  googlePatchEvent,
  outlookPatchEvent,
  googleGetEventPatch,
  outlookGetEventPatch,
} from './calendar-write.ts';

Deno.test('googleDeleteEvent: DELETEs the event', async () => {
  let captured = '';
  const fetch: CalWriteFetch = async (url, init) => {
    captured = `${init?.method} ${url}`;
    return new Response('', { status: 204 });
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
  const fetch: CalWriteFetch = async () =>
    new Response(JSON.stringify({
      subject: 'Møde', start: { dateTime: '2026-06-02T10:00:00.0000000' }, end: { dateTime: '2026-06-02T11:00:00.0000000' }, location: { displayName: 'A' },
    }), { status: 200 });
  const prior = await outlookGetEventPatch({ fetch, accessToken: 't', eventId: 'e1' });
  assertEquals(prior, { title: 'Møde', startIso: '2026-06-02T10:00:00.0000000', endIso: '2026-06-02T11:00:00.0000000', location: 'A' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: FAIL — the six functions are not exported.

- [ ] **Step 3: Implement the six primitives (append to `calendar-write.ts`)**

```typescript
export async function googleDeleteEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<void> {
  const res = await input.fetch(`${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  // 404/410 = already gone — for an undo that's the desired end state.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function outlookDeleteEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<void> {
  const res = await input.fetch(`${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function googlePatchEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.patch.title !== undefined) body.summary = input.patch.title;
  if (input.patch.startIso !== undefined) body.start = { dateTime: input.patch.startIso, timeZone: 'UTC' };
  if (input.patch.endIso !== undefined) body.end = { dateTime: input.patch.endIso, timeZone: 'UTC' };
  if (input.patch.location !== undefined) body.location = input.patch.location;
  const res = await input.fetch(`${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.patch ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function outlookPatchEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.patch.title !== undefined) body.subject = input.patch.title;
  if (input.patch.startIso !== undefined) body.start = { dateTime: stripZone(input.patch.startIso), timeZone: 'UTC' };
  if (input.patch.endIso !== undefined) body.end = { dateTime: stripZone(input.patch.endIso), timeZone: 'UTC' };
  if (input.patch.location !== undefined) body.location = { displayName: input.patch.location };
  const res = await input.fetch(`${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.patch ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export async function googleGetEventPatch(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<EventPatch> {
  const res = await input.fetch(
    `${GCAL_EVENTS}/${encodeURIComponent(input.eventId)}?fields=summary,start,end,location`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.get ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
  };
  return {
    title: j.summary,
    startIso: j.start?.dateTime ?? j.start?.date,
    endIso: j.end?.dateTime ?? j.end?.date,
    location: j.location,
  };
}

export async function outlookGetEventPatch(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
}): Promise<EventPatch> {
  const res = await input.fetch(
    `${GRAPH_EVENTS}/${encodeURIComponent(input.eventId)}?$select=subject,start,end,location`,
    { headers: { authorization: `Bearer ${input.accessToken}`, prefer: 'outlook.timezone="UTC"' } },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph events.get ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    subject?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    location?: { displayName?: string };
  };
  return {
    title: j.subject,
    startIso: j.start?.dateTime,
    endIso: j.end?.dateTime,
    location: j.location?.displayName,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/calendar-write.ts supabase/functions/_shared/agent/tools/calendar-write.test.ts
git commit -m "feat(agent): event delete/patch/get primitives (idempotent delete)"
```

---

## Task 5: Update-event (read-then-patch, restore reverse token), both providers

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/calendar-write.ts`
- Test: `supabase/functions/_shared/agent/tools/calendar-write.test.ts`

- [ ] **Step 1: Write the failing tests (append)**

```typescript
import { googleUpdateEvent, outlookUpdateEvent } from './calendar-write.ts';

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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: FAIL — `googleUpdateEvent` / `outlookUpdateEvent` not exported.

- [ ] **Step 3: Implement the two update functions (append)**

```typescript
export async function googleUpdateEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<{ reverseToken: GcalEventRestoreToken }> {
  const prior = await googleGetEventPatch(input);
  await googlePatchEvent(input);
  return {
    reverseToken: { kind: 'gcal.event_restore', provider: 'google', event_id: input.eventId, prior },
  };
}

export async function outlookUpdateEvent(input: {
  fetch: CalWriteFetch;
  accessToken: string;
  eventId: string;
  patch: EventPatch;
}): Promise<{ reverseToken: GraphEventRestoreToken }> {
  const prior = await outlookGetEventPatch(input);
  await outlookPatchEvent(input);
  return {
    reverseToken: { kind: 'graph.event_restore', provider: 'microsoft', event_id: input.eventId, prior },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/tools/calendar-write.test.ts --allow-env`
Expected: PASS (all calendar-write tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/calendar-write.ts supabase/functions/_shared/agent/tools/calendar-write.test.ts
git commit -m "feat(agent): update-event with prior-capture restore token"
```

---

## Task 6: Dispatcher cases for `cal.create_event` + `cal.update_event`

The propose/execute split: `policy !== 'auto'` → return `mode:'propose'` with no write; `policy === 'auto'` → perform the write and return the reverse token.

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`
- Test: `supabase/functions/_shared/agent/tools/dispatch.test.ts`

- [ ] **Step 1: Write the failing tests (append to `dispatch.test.ts`)**

```typescript
Deno.test('executeTool: cal.create_event proposes (no write) when policy != auto', async () => {
  let called = false;
  const ctx = makeCtx({ fetch: async () => { called = true; return new Response('{}', { status: 200 }); } });
  const result = await executeTool(
    'cal.create_event',
    { provider: 'google', title: 'Frokost', start_iso: '2026-06-01T11:00:00Z', end_iso: '2026-06-01T12:00:00Z' },
    ctx,
  );
  assertEquals(result.mode, 'propose');
  assertEquals(result.reversible, false);
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.title, 'Frokost');
  assertEquals(called, false);
});

Deno.test('executeTool: cal.create_event (google) writes + returns delete token when policy=auto', async () => {
  let captured: { url: string; method: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, method: init?.method ?? 'GET' };
      return new Response(JSON.stringify({ id: 'evt-9' }), { status: 200 });
    },
  });
  const result = await executeTool(
    'cal.create_event',
    { provider: 'google', title: 'Frokost', start_iso: '2026-06-01T11:00:00Z', end_iso: '2026-06-01T12:00:00Z' },
    ctx,
    { policy: 'auto' },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(result.reverseToken?.kind, 'gcal.event_delete');
  assertEquals(result.recordPayload.event_id, 'evt-9');
  assertEquals(captured!.method, 'POST');
});

Deno.test('executeTool: cal.update_event proposes when policy != auto', async () => {
  const ctx = makeCtx();
  const result = await executeTool(
    'cal.update_event',
    { provider: 'microsoft', event_id: 'e1', start_iso: '2026-06-02T14:00:00Z' },
    ctx,
  );
  assertEquals(result.mode, 'propose');
  assertEquals(result.recordPayload.event_id, 'e1');
  assertEquals(result.recordPayload.start_iso, '2026-06-02T14:00:00Z');
});

Deno.test('executeTool: cal.update_event throws when no change fields given', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () => executeTool('cal.update_event', { provider: 'google', event_id: 'e1' }, ctx, { policy: 'auto' }),
    Error,
    'no fields to change',
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/tools/dispatch.test.ts --allow-env`
Expected: FAIL — `executeTool: unsupported action type cal.create_event`.

- [ ] **Step 3: Add imports and the two cases in `dispatch.ts`**

Add to the imports near the top (after the `calendar.ts` import on line 26):

```typescript
import {
  googleCreateEvent,
  outlookCreateEvent,
  googleUpdateEvent,
  outlookUpdateEvent,
  type EventPatch,
  type GcalEventDeleteToken,
  type GcalEventRestoreToken,
  type GraphEventDeleteToken,
  type GraphEventRestoreToken,
} from './calendar-write.ts';
```

Extend the `ExecuteReverseToken` union (after `OutlookCategoryReverseToken`):

```typescript
export type ExecuteReverseToken =
  | GmailModifyReverseToken
  | GmailDraftReverseToken
  | OutlookDraftReverseToken
  | OutlookMoveReverseToken
  | OutlookFlagReverseToken
  | OutlookCategoryReverseToken
  | GcalEventDeleteToken
  | GcalEventRestoreToken
  | GraphEventDeleteToken
  | GraphEventRestoreToken
  | null;
```

Add the two cases inside the `switch (action)` block, immediately before `default:`:

```typescript
    case 'cal.create_event': {
      const title = mustString(payload, 'title');
      const startIso = mustString(payload, 'start_iso');
      const endIso = mustString(payload, 'end_iso');
      const attendees = Array.isArray(payload.attendees)
        ? (payload.attendees as unknown[]).filter((a): a is string => typeof a === 'string')
        : undefined;
      const location = typeof payload.location === 'string' ? payload.location : undefined;
      const baseRecord: Record<string, unknown> = { provider, title, start_iso: startIso, end_iso: endIso };
      if (attendees && attendees.length) baseRecord.attendees = attendees;
      if (location) baseRecord.location = location;

      // Propose path: no write. Runner writes a proposed_actions row; the real
      // create happens when agent-approve re-dispatches with policy='auto'.
      if (opts.policy !== 'auto') {
        return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
      }
      if (provider === 'google') {
        const out = await googleCreateEvent({
          fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, title, startIso, endIso, attendees, location,
        });
        return {
          mode: 'executed', reversible: true, reverseToken: out.reverseToken,
          recordPayload: { ...baseRecord, event_id: out.eventId },
        };
      }
      if (!ctx.outlook) throw new Error('outlook create_event requested but outlook context missing');
      const out = await outlookCreateEvent({
        fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, title, startIso, endIso, attendees, location,
      });
      return {
        mode: 'executed', reversible: true, reverseToken: out.reverseToken,
        recordPayload: { ...baseRecord, event_id: out.eventId },
      };
    }
    case 'cal.update_event': {
      const eventId = mustString(payload, 'event_id');
      const patch: EventPatch = {};
      if (typeof payload.title === 'string') patch.title = payload.title;
      if (typeof payload.start_iso === 'string') patch.startIso = payload.start_iso;
      if (typeof payload.end_iso === 'string') patch.endIso = payload.end_iso;
      if (typeof payload.location === 'string') patch.location = payload.location;
      if (Object.keys(patch).length === 0) {
        throw new Error('cal.update_event: no fields to change');
      }
      const baseRecord: Record<string, unknown> = { provider, event_id: eventId };
      if (patch.title !== undefined) baseRecord.title = patch.title;
      if (patch.startIso !== undefined) baseRecord.start_iso = patch.startIso;
      if (patch.endIso !== undefined) baseRecord.end_iso = patch.endIso;
      if (patch.location !== undefined) baseRecord.location = patch.location;

      if (opts.policy !== 'auto') {
        return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
      }
      if (provider === 'google') {
        const out = await googleUpdateEvent({ fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, eventId, patch });
        return { mode: 'executed', reversible: true, reverseToken: out.reverseToken, recordPayload: baseRecord };
      }
      if (!ctx.outlook) throw new Error('outlook update_event requested but outlook context missing');
      const out = await outlookUpdateEvent({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, eventId, patch });
      return { mode: 'executed', reversible: true, reverseToken: out.reverseToken, recordPayload: baseRecord };
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/tools/dispatch.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/dispatch.ts supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "feat(agent): dispatch cal.create_event + cal.update_event (propose/execute split)"
```

---

## Task 7: Idem-key cases for the two calendar actions

The runner calls `deriveIdemKey(action, recordPayload)` on the propose path; it currently throws for these action types.

**Files:**
- Modify: `supabase/functions/_shared/agent/idem.ts`
- Test: `supabase/functions/_shared/agent/idem.test.ts`

- [ ] **Step 1: Write the failing tests (append to `idem.test.ts`)**

```typescript
Deno.test('deriveIdemKey: cal.create_event keys on provider+title+start', () => {
  const key = deriveIdemKey('cal.create_event', {
    provider: 'google', title: 'Frokost', start_iso: '2026-06-01T11:00:00Z',
  });
  assertEquals(key, 'cal.create_event:google:Frokost:2026-06-01T11:00:00Z');
});

Deno.test('deriveIdemKey: cal.update_event keys on provider+event_id', () => {
  const key = deriveIdemKey('cal.update_event', { provider: 'microsoft', event_id: 'e1' });
  assertEquals(key, 'cal.update_event:microsoft:e1');
});
```

(If `idem.test.ts` does not already import `deriveIdemKey` / `assertEquals`, add `import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';` and `import { deriveIdemKey } from './idem.ts';` at the top.)

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/idem.test.ts --allow-env`
Expected: FAIL — `deriveIdemKey: unsupported action type cal.create_event`.

- [ ] **Step 3: Add the two cases in `idem.ts`** (before `default:`)

```typescript
    case 'cal.create_event':
      return `cal.create_event:${req(payload, 'provider')}:${req(payload, 'title')}:${req(payload, 'start_iso')}`;
    case 'cal.update_event':
      return `cal.update_event:${req(payload, 'provider')}:${req(payload, 'event_id')}`;
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/idem.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/idem.ts supabase/functions/_shared/agent/idem.test.ts
git commit -m "feat(agent): idem keys for cal.create_event + cal.update_event"
```

---

## Task 8: Tools, name map, and system-prompt guidance

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts`
- Test: `supabase/functions/_shared/agent/prompt.test.ts`

- [ ] **Step 1: Write the failing tests (append to `prompt.test.ts`)**

```typescript
Deno.test('actionTypeFromToolName: maps the two calendar-write tools', () => {
  assertEquals(actionTypeFromToolName('cal_create_event'), 'cal.create_event');
  assertEquals(actionTypeFromToolName('cal_update_event'), 'cal.update_event');
});

Deno.test('MAIL_TRIAGE_TOOLS: includes calendar-write tools', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name);
  assertEquals(names.includes('cal_create_event'), true);
  assertEquals(names.includes('cal_update_event'), true);
});
```

(Ensure the test file imports `actionTypeFromToolName` and `MAIL_TRIAGE_TOOLS` from `./prompt.ts` and `assertEquals` — add to existing imports if missing.)

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/prompt.test.ts --allow-env`
Expected: FAIL — `actionTypeFromToolName('cal_create_event')` returns `null`.

- [ ] **Step 3: Update `prompt.ts`**

Add to `TOOL_NAME_TO_ACTION` (after `drive_search`):

```typescript
  cal_create_event: 'cal.create_event',
  cal_update_event: 'cal.update_event',
```

Add to `MAIL_TRIAGE_TOOLS` (after the `drive_search` entry, before the closing `]`):

```typescript
  {
    name: 'cal_create_event',
    description:
      'Create a calendar event. Use only when a human thread proposes a concrete date+time. Provide start_iso/end_iso as UTC ISO-8601 ending in Z. The event is proposed to the user for approval before it is created. Both providers.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        end_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'attendee email addresses' },
        location: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['title', 'start_iso', 'end_iso', 'provider'],
    },
  },
  {
    name: 'cal_update_event',
    description:
      'Change an existing calendar event\'s time, title, or location. event_id MUST come from a prior cal_list_events result — never invent it. Provide new times as UTC ISO-8601 ending in Z. Proposed to the user for approval. Both providers.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'from cal_list_events — never invented' },
        title: { type: 'string' },
        start_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        end_iso: { type: 'string', description: 'UTC ISO-8601, ends with Z' },
        location: { type: 'string' },
        provider: { type: 'string', enum: ['google', 'microsoft'] },
      },
      required: ['event_id', 'provider'],
    },
  },
```

Extend `SYSTEM_PROMPT`: add a numbered item under "Tilladte handlinger" (after item 4) and a matching rule under "Regler". Insert after the line for item 4 (the `mail_send_reply` paragraph ending `...Spring det aldrig over.`):

```
5. KALENDER: hvis en menneskelig tråd foreslår et konkret mødetidspunkt, kald cal_list_events (±2 timer omkring tidspunktet) for at tjekke for konflikter, og foreslå derefter cal_create_event med UTC ISO-8601 tider (slut med Z). Hvis tråden beder om at flytte/ændre et eksisterende møde, find begivenheden via cal_list_events og kald cal_update_event med dens event_id. Begge foreslås til brugeren, før de udføres.
```

Add to the "Regler" list (after the `drive_search er KUN Google.` rule):

```
- event_id til cal_update_event SKAL komme fra cal_list_events — opfind ALDRIG et event_id. Brug UTC (Z-suffiks) for alle tider i kalenderhandlinger.
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/prompt.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/prompt.test.ts
git commit -m "feat(agent): expose cal_create_event + cal_update_event tools to Claude"
```

---

## Task 9: Runner — register actions, skip thread-guard, build proposal previews

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`
- Test: `supabase/functions/_shared/agent/runner.test.ts`

- [ ] **Step 1: Write the failing test (append to `runner.test.ts`)**

`buildProposalPreview` is module-private. Export it for testing by adding `export` to its declaration in `runner.ts` (change `function buildProposalPreview` → `export function buildProposalPreview`), then add this test:

```typescript
import { buildProposalPreview } from './runner.ts';

Deno.test('buildProposalPreview: cal.create_event shows title + time', () => {
  const p = buildProposalPreview('cal.create_event', { title: 'Frokost', start_iso: '2026-06-01T11:00:00Z' });
  assertEquals(p.title, 'Opret begivenhed?');
  assertEquals(p.body, 'Frokost · 2026-06-01T11:00:00Z');
});

Deno.test('buildProposalPreview: cal.update_event describes the change', () => {
  const p = buildProposalPreview('cal.update_event', { start_iso: '2026-06-02T14:00:00Z' });
  assertEquals(p.title, 'Ret begivenhed?');
  assertEquals(p.body, 'ny tid 2026-06-02T14:00:00Z');
});
```

(Add `assertEquals` import if the test file does not already have it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/runner.test.ts --allow-env`
Expected: FAIL — `buildProposalPreview` falls into `default` and returns `{ title: 'Zolva foreslår', body: 'cal.create_event' }`.

- [ ] **Step 3: Update `runner.ts`**

Add both actions to `SUPPORTED_ACTIONS` (insert after `'drive.search',`):

```typescript
  'cal.create_event',
  'cal.update_event',
```

Add both to `NON_THREAD_ACTIONS` (they carry no `thread_id`; the thread hallucination-guard must be skipped or it throws on the empty id):

```typescript
const NON_THREAD_ACTIONS = new Set<ActionType>([
  'cal.list_events',
  'drive.search',
  'cal.create_event',
  'cal.update_event',
]);
```

Add the two cases in `buildProposalPreview` (before `default:`):

```typescript
    case 'cal.create_event': {
      const title = typeof payload.title === 'string' ? payload.title : 'begivenhed';
      const when = typeof payload.start_iso === 'string' ? payload.start_iso : '';
      return { title: 'Opret begivenhed?', body: when ? `${title} · ${when}` : title };
    }
    case 'cal.update_event': {
      const parts: string[] = [];
      if (typeof payload.start_iso === 'string') parts.push(`ny tid ${payload.start_iso}`);
      if (typeof payload.title === 'string') parts.push(`ny titel ${payload.title}`);
      if (typeof payload.location === 'string') parts.push(`nyt sted ${payload.location}`);
      return { title: 'Ret begivenhed?', body: parts.join(' · ') || 'Opdatér begivenhed' };
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/runner.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): runner supports cal writes + calendar proposal previews"
```

---

## Task 10: Reverse-token → provider helper

`agent-undo` is currently Google-only. Extract a tested helper that maps any reverse-token `kind` to its provider so undo can load the correct refresh token.

**Files:**
- Create: `supabase/functions/_shared/agent/tools/reverse-provider.ts`
- Test: `supabase/functions/_shared/agent/tools/reverse-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `reverse-provider.test.ts`:

```typescript
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { reverseTokenProvider } from './reverse-provider.ts';

Deno.test('reverseTokenProvider: google kinds', () => {
  assertEquals(reverseTokenProvider({ kind: 'gmail.modify' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gmail.draft' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gcal.event_delete' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gcal.event_restore' }), 'google');
});

Deno.test('reverseTokenProvider: microsoft kinds', () => {
  assertEquals(reverseTokenProvider({ kind: 'graph.draft' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.move' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.event_delete' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.event_restore' }), 'microsoft');
});

Deno.test('reverseTokenProvider: unknown kind throws', () => {
  assertThrows(() => reverseTokenProvider({ kind: 'nope' }), Error, 'unknown');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd supabase/functions && deno test _shared/agent/tools/reverse-provider.test.ts --allow-env`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reverse-provider.ts`**

```typescript
// Maps a reverse-token `kind` to the OAuth provider whose token can apply it.
// agent-undo uses this to load the correct refresh token (it was Google-only
// before calendar writes added Outlook-reversible actions).
export function reverseTokenProvider(token: { kind: string }): 'google' | 'microsoft' {
  switch (token.kind) {
    case 'gmail.modify':
    case 'gmail.draft':
    case 'gcal.event_delete':
    case 'gcal.event_restore':
      return 'google';
    case 'graph.draft':
    case 'graph.move':
    case 'graph.flag':
    case 'graph.category':
    case 'graph.event_delete':
    case 'graph.event_restore':
      return 'microsoft';
    default:
      throw new Error(`reverseTokenProvider: unknown reverse_token kind ${token.kind}`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd supabase/functions && deno test _shared/agent/tools/reverse-provider.test.ts --allow-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/reverse-provider.ts supabase/functions/_shared/agent/tools/reverse-provider.test.ts
git commit -m "feat(agent): reverse-token provider mapping helper"
```

---

## Task 11: Make `agent-undo` provider-aware + handle calendar reverse tokens

**Files:**
- Modify: `supabase/functions/agent-undo/index.ts`

This edge function has no test file (it is a thin `serve()` wrapper; its logic now lives in the tested `reverse-provider.ts` and `calendar-write.ts`). Verify with `deno check`.

- [ ] **Step 1: Update imports**

Replace the existing tool imports (lines 13-14) with:

```typescript
import { gmailDeleteDraft, gmailModifyThread } from '../_shared/agent/tools/gmail.ts';
import type { GmailDraftReverseToken, GmailModifyReverseToken } from '../_shared/agent/tools/gmail.ts';
import {
  googleDeleteEvent,
  googlePatchEvent,
  outlookDeleteEvent,
  outlookPatchEvent,
} from '../_shared/agent/tools/calendar-write.ts';
import type {
  GcalEventDeleteToken,
  GcalEventRestoreToken,
  GraphEventDeleteToken,
  GraphEventRestoreToken,
} from '../_shared/agent/tools/calendar-write.ts';
import { reverseTokenProvider } from '../_shared/agent/tools/reverse-provider.ts';
```

- [ ] **Step 2: Widen the `ReverseToken` type**

Replace line 16 (`type ReverseToken = GmailModifyReverseToken | GmailDraftReverseToken;`) with:

```typescript
type ReverseToken =
  | GmailModifyReverseToken
  | GmailDraftReverseToken
  | GcalEventDeleteToken
  | GcalEventRestoreToken
  | GraphEventDeleteToken
  | GraphEventRestoreToken;
```

- [ ] **Step 3: Rewrite `applyReverseToken` to be provider-aware and handle calendar kinds**

Replace the whole `applyReverseToken` function (lines 33-61) with:

```typescript
async function applyReverseToken(
  client: SupabaseClient,
  userId: string,
  token: ReverseToken,
): Promise<void> {
  const provider = reverseTokenProvider(token);
  const refresh = await loadRefreshToken(client, userId, provider);
  if (!refresh) throw new Error(`no ${provider} refresh token for user`);
  const { accessToken } = await refreshAccessToken(client, userId, provider, refresh);

  switch (token.kind) {
    case 'gmail.modify':
      await gmailModifyThread({
        fetch: fetch as never,
        accessToken,
        threadId: token.thread_id,
        addLabelIds: token.add_label_ids,
        removeLabelIds: token.remove_label_ids,
      });
      return;
    case 'gmail.draft':
      await gmailDeleteDraft({ fetch: fetch as never, accessToken, draftId: token.draft_id });
      return;
    case 'gcal.event_delete':
      await googleDeleteEvent({ fetch: fetch as never, accessToken, eventId: token.event_id });
      return;
    case 'gcal.event_restore':
      await googlePatchEvent({ fetch: fetch as never, accessToken, eventId: token.event_id, patch: token.prior });
      return;
    case 'graph.event_delete':
      await outlookDeleteEvent({ fetch: fetch as never, accessToken, eventId: token.event_id });
      return;
    case 'graph.event_restore':
      await outlookPatchEvent({ fetch: fetch as never, accessToken, eventId: token.event_id, patch: token.prior });
      return;
    default:
      throw new Error(`unsupported reverse_token kind ${(token as { kind: string }).kind}`);
  }
}
```

- [ ] **Step 4: Type-check the function**

Run: `cd supabase/functions && deno check agent-undo/index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/agent-undo/index.ts
git commit -m "feat(agent): agent-undo handles calendar event reverse tokens (provider-aware)"
```

---

## Task 12: Full server suite green

**Files:** none (verification only).

- [ ] **Step 1: Run the entire agent test suite**

Run: `cd supabase/functions && deno test _shared/agent/ --allow-env`
Expected: PASS — all tests, including the new calendar-write, dispatch, idem, prompt, runner, and reverse-provider tests.

- [ ] **Step 2: Type-check the touched edge functions**

Run: `cd supabase/functions && deno check agent-undo/index.ts agent-approve/index.ts agent-tick/index.ts`
Expected: no errors. (`agent-approve` is unchanged but should still type-check against the widened reverse-token union.)

---

## Task 13: Client — extend the executed-action union

**Files:**
- Modify: `src/lib/agent-feed.ts`

- [ ] **Step 1: Add the two action types to `AgentActionRow.action_type`**

In the `action_type` union (currently ending `| 'mail.send_new';`), add:

```typescript
    | 'cal.create_event'
    | 'cal.update_event'
```

- [ ] **Step 2: Type-check**

Run (from repo root): `npx tsc --noEmit`
Expected: no new errors. (A pre-existing TS2322 in `hooks.ts:5037` is known tech debt — ignore it if present.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/agent-feed.ts
git commit -m "feat(agent): client action-row type covers calendar writes"
```

---

## Task 14: Client — executed-card labels & details for calendar writes

**Files:**
- Modify: `src/components/AgentActionCard.tsx`

- [ ] **Step 1: Add titles**

Add to the `TITLES` map:

```typescript
  'cal.create_event': 'Begivenhed oprettet',
  'cal.update_event': 'Begivenhed opdateret',
```

- [ ] **Step 2: Add detail cases**

In `detailFor`, before `default:`:

```typescript
    case 'cal.create_event': {
      const title = str(row.payload.title);
      const when = str(row.payload.start_iso);
      if (title && when) return `${title} · ${when}`;
      return title || when;
    }
    case 'cal.update_event': {
      const parts: string[] = [];
      if (str(row.payload.start_iso)) parts.push(`ny tid ${str(row.payload.start_iso)}`);
      if (str(row.payload.title)) parts.push(`ny titel ${str(row.payload.title)}`);
      if (str(row.payload.location)) parts.push(`nyt sted ${str(row.payload.location)}`);
      return parts.join(' · ');
    }
```

- [ ] **Step 3: Type-check**

Run (from repo root): `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentActionCard.tsx
git commit -m "feat(agent): Today-feed labels for calendar create/update"
```

---

## Task 15: Client — Settings policy rows for calendar writes

**Files:**
- Modify: `src/components/AgentActionPolicySection.tsx`

- [ ] **Step 1: Extend the local `ActionType` union**

Add to the union (after `| 'mail.send_reply';` — note it ends the union, so adjust accordingly):

```typescript
type ActionType =
  | 'mail.archive'
  | 'mail.label'
  | 'mail.flag_important'
  | 'mail.summarize'
  | 'mail.draft_reply'
  | 'mail.send_reply'
  | 'cal.create_event'
  | 'cal.update_event';
```

- [ ] **Step 2: Add rows**

Append to the `ROWS` array (default mode `propose`, matching the server `DEFAULT_POLICY`):

```typescript
  { key: 'cal.create_event', label: 'Opret begivenhed', defaultMode: 'propose' },
  { key: 'cal.update_event', label: 'Ret begivenhed', defaultMode: 'propose' },
```

- [ ] **Step 3: Type-check and run client tests**

Run (from repo root): `npx tsc --noEmit` then `npm test -- agent`
Expected: no new type errors; existing agent-related jest tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentActionPolicySection.tsx
git commit -m "feat(agent): Settings policy rows for calendar create/update"
```

---

## Task 16: Deploy (server first, then client OTA)

Per the project's client/server split convention, deploy edge functions before shipping the client.

**Files:** none (deploy only).

- [ ] **Step 1: Verify the Google Calendar write scope is granted**

The agent's Google access token already reads calendar (`cal_list_events`). Confirm the OAuth grant includes `https://www.googleapis.com/auth/calendar.events` (write), not only a read scope. Check `src/lib/auth.ts` scope list. If write is missing, STOP — adding a scope is a consent-screen change that must be surfaced to the user before this feature can ship. (Outlook's `Calendars.ReadWrite` should likewise be confirmed in the Microsoft app registration.)

- [ ] **Step 2: Merge the feature branch to main**

Builds/OTA ship from `main`. Merge `feature/calendar-writes` into `main` first.

```bash
git checkout main && git merge --no-ff feature/calendar-writes
```

- [ ] **Step 3: Deploy the changed edge functions**

```bash
supabase functions deploy agent-undo --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

(`agent-tick` and `agent-approve` import the shared `_shared/agent` code; redeploy them too so they pick up the new dispatch/runner/prompt code.)

```bash
supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
supabase functions deploy agent-approve --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

- [ ] **Step 4: OTA the client**

```bash
eas update --branch production --message "calendar writes: create/update events"
```

- [ ] **Step 5: Smoke test**

Send yourself a mail proposing a concrete meeting time on each provider. Confirm: an "Opret begivenhed?" card appears on Today → approve → the event lands in the calendar → the executed card shows "Begivenhed oprettet" → tap Fortryd → the event is removed. Repeat with a "move our meeting" thread for `cal.update_event` (verify Fortryd restores the prior time).

---

## Self-review notes (for the implementer)

- **Spec coverage:** create + update (both providers) = Tasks 2-6; propose/approve reuse = Task 6 + existing `agent-approve` (unchanged); undo = Tasks 10-11; `cal_list_events` id = Task 1; previews = Task 9; client labels/policy/types = Tasks 13-15; scope check + deploy order = Task 16. RSVP / invite emitter / iCloud are intentionally absent per the spec.
- **`agent-approve` needs no change** — it already calls `executeTool(..., {policy:'auto'})` and mirrors `recordPayload`/`reverseToken` to `agent_actions`, which is exactly what the new dispatch cases return. Confirm with the Task 12 `deno check`.
- **Type consistency:** reverse-token kinds (`gcal.event_delete`/`gcal.event_restore`/`graph.event_delete`/`graph.event_restore`), `EventPatch` field names (`title`/`startIso`/`endIso`/`location`), and payload field names (`start_iso`/`end_iso`/`event_id`) are used identically across dispatch, calendar-write, idem, runner, undo, and the client cards.
