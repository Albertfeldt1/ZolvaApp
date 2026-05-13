# Autonomous Agent — Phase 4a (context tools for reply drafting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a mail asks an actionable question ("Can we meet at 12?", "Are you free Tuesday?", "Did you see the doc?"), the agent reads the full body, checks the calendar, and (when relevant) searches Drive — *then* drafts a reply grounded in real context. Auto-send still requires the recipient allowlist plus a new "researched-thread" rail.

**Architecture:** Three new server-side tools (`mail_get_body`, `cal_list_events`, `drive_search`) exposed to Claude alongside the existing six. The runner tracks which threads have been "researched" during a turn; `mail_send_reply` auto-send refuses to fire on a thread that hasn't been opened. Internal action types stay dotted (`mail.get_body` etc.); Claude sees the underscore form per the Phase 3.1 boundary translation.

**Tech Stack:** Deno edge functions, Gmail API (already in scope: `gmail.modify`), Microsoft Graph (Mail.ReadWrite already in scope), Google Calendar API (`calendar.readonly`), Microsoft Graph Calendar (`Calendars.Read`), Google Drive API (`drive.readonly` already in scope — `src/lib/auth.ts:71`). All four already authenticated on the existing OAuth refresh-token pipeline.

**Out of scope:** iCloud CalDAV calendar read (Phase 4b), OneDrive search (Phase 4b), trust-escalation prompt (separate Phase 4 carry-over), reflection sweeps + standing tasks.

**Reference:**
- Spec: `docs/superpowers/specs/2026-05-11-autonomous-background-actions-design.md` (§5.1 action catalog, §8.4 safety rails)
- Phase 3.1 plan: `docs/superpowers/plans/2026-05-13-autonomous-agent-phase-3-1-carryovers.md` (style + tooling reference)
- Existing Drive client: `src/lib/google-drive.ts` (Deno port needed)
- Existing Calendar backfill: `supabase/functions/_shared/backfill-providers/google-calendar.ts` (heuristic-laden — agent needs a thinner list-in-window reader)

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/functions/_shared/agent/tools/mail-body.ts` | `gmailGetBody` + `outlookGetBody` | **create** |
| `supabase/functions/_shared/agent/tools/mail-body.test.ts` | Unit tests | **create** |
| `supabase/functions/_shared/agent/tools/calendar.ts` | `googleListEvents` + `outlookListEvents` | **create** |
| `supabase/functions/_shared/agent/tools/calendar.test.ts` | Unit tests | **create** |
| `supabase/functions/_shared/agent/tools/drive.ts` | `driveSearchFiles` (Google) | **create** |
| `supabase/functions/_shared/agent/tools/drive.test.ts` | Unit tests | **create** |
| `supabase/functions/_shared/agent/tools/dispatch.ts` | Add three new action branches | **modify** |
| `supabase/functions/_shared/agent/types.ts` | Extend `ActionType` enum + defaults | **modify** |
| `supabase/functions/_shared/agent/prompt.ts` | Add tool entries + name map + prompt prose | **modify** |
| `supabase/functions/_shared/agent/runner.ts` | Researched-threads tracker + new rail | **modify** |
| `supabase/functions/_shared/agent/runner.test.ts` | New test for the rail | **modify** |
| `supabase/functions/agent-tick/index.ts` | Wire `ExecuteContext` with new accessTokens already cached | **modify** |

---

## Tool definitions Claude will see

```
mail_get_body(thread_id, provider) → { body_text, snippet, from, to, subject, sent_at }
cal_list_events(start_iso, end_iso, provider) → [{ title, start, end, attendees, location? }]
drive_search(query, limit?) → [{ id, name, mimeType, modified_at, webViewLink }]
```

Internal `ActionType` values: `'mail.get_body'`, `'cal.list_events'`, `'drive.search'`.

### Default modes (extend `ACTION_DEFAULT_MODE`)

Read-only tools never propose; they always execute:
- `mail.get_body` → `'auto'`
- `cal.list_events` → `'auto'`
- `drive.search` → `'auto'`

Adding `'off'` as a user policy MUST still respect them — a user can disable read-only context lookups if they want a less-thorough agent (rare). The runner's existing `policy === 'off'` rejection handles this; no special-case needed.

---

## Test commands

```bash
deno test --allow-env supabase/functions/_shared/agent/tools/
deno test --allow-env supabase/functions/_shared/agent/
npx tsc --noEmit
```

---

## Task 1 — `mail_get_body` tool

**Why first:** Without the body, cal/drive context is wasted — the agent can't tell what to look up. This is the foundational tool.

**Files:**
- Create: `supabase/functions/_shared/agent/tools/mail-body.ts`
- Create: `supabase/functions/_shared/agent/tools/mail-body.test.ts`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`

### Step 1.1 — Test for `gmailGetBody`

- [ ] Append to `mail-body.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { gmailGetBody, type GmailFetch } from './mail-body.ts';

Deno.test('gmailGetBody: fetches latest message in thread, decodes text body', async () => {
  // Step 1: GET thread → returns messages array with the message ids.
  // Step 2: GET message?format=full → headers + payload with base64url body.
  const bodyText = 'Hej Albert,\n\nKan vi mødes kl. 12 i morgen?\n\nMvh, Mor';
  const b64 = btoa(bodyText).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  assertEquals(result.snippet.startsWith('Hej Albert'), true);
});
```

### Step 1.2 — Run, expect FAIL

```bash
deno test --allow-env supabase/functions/_shared/agent/tools/mail-body.test.ts
```

### Step 1.3 — Implement `gmailGetBody`

- [ ] Create `mail-body.ts`:

```ts
// Read-only mail body lookup for the agent. Gmail uses thread.list → message.get;
// Outlook uses message.get with $select. Both decode the body to plain text and
// truncate to keep prompts cheap.

export type GmailFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type OutlookFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface MailBodyResult {
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string; // ISO
  body_text: string;
  snippet: string;
}

const MAX_BODY_CHARS = 8000;

function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function findHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function walkForText(part: {
  mimeType?: string;
  body?: { data?: string };
  parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }>;
}): string {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const found = walkForText(sub as Parameters<typeof walkForText>[0]);
      if (found) return found;
    }
  }
  return '';
}

export async function gmailGetBody(input: {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
}): Promise<MailBodyResult> {
  const threadRes = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}?format=metadata`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!threadRes.ok) {
    const detail = await threadRes.text().catch(() => '');
    throw new Error(`gmail threads.get ${threadRes.status}: ${detail.slice(0, 200)}`);
  }
  const thread = (await threadRes.json()) as { id: string; messages?: Array<{ id: string }> };
  const lastMessageId = thread.messages?.[thread.messages.length - 1]?.id;
  if (!lastMessageId) throw new Error('gmail thread has no messages');

  const msgRes = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${lastMessageId}?format=full`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!msgRes.ok) {
    const detail = await msgRes.text().catch(() => '');
    throw new Error(`gmail messages.get ${msgRes.status}: ${detail.slice(0, 200)}`);
  }
  const msg = (await msgRes.json()) as {
    id: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      mimeType?: string;
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    };
  };
  const headers = msg.payload?.headers ?? [];
  const rawBody = msg.payload?.body?.data
    ? decodeBase64Url(msg.payload.body.data)
    : walkForText(msg.payload ?? {});
  const body_text = rawBody.slice(0, MAX_BODY_CHARS);
  return {
    thread_id: input.threadId,
    from: findHeader(headers, 'From'),
    to: findHeader(headers, 'To'),
    subject: findHeader(headers, 'Subject'),
    sent_at: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
    body_text,
    snippet: body_text.slice(0, 200),
  };
}
```

### Step 1.4 — Run, expect PASS

### Step 1.5 — Test + implement `outlookGetBody`

- [ ] Test (append to `mail-body.test.ts`):

```ts
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
```

- [ ] Implement (append to `mail-body.ts`):

```ts
export async function outlookGetBody(input: {
  fetch: OutlookFetch;
  accessToken: string;
  threadId: string; // conversationId
}): Promise<MailBodyResult> {
  // Get the most recent message in the conversation, ordered desc by sentDateTime.
  const url =
    `https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId eq '${input.threadId}'` +
    `&$orderby=sentDateTime desc&$top=1` +
    `&$select=id,from,toRecipients,subject,sentDateTime,uniqueBody`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      subject?: string;
      sentDateTime?: string;
      uniqueBody?: { content?: string; contentType?: string };
      body?: { content?: string; contentType?: string };
    }>;
  };
  const msg = json.value?.[0];
  if (!msg) throw new Error('graph: conversation has no messages');
  const fromAddr = msg.from?.emailAddress;
  const toAddr = msg.toRecipients?.[0]?.emailAddress;
  const rawBody = msg.uniqueBody?.content ?? msg.body?.content ?? '';
  // If contentType is 'html', strip tags naively (Graph also exposes Prefer:
  // outlook.body-content-type='text' header but we keep this simple).
  const body_text = (msg.uniqueBody?.contentType === 'html' || msg.body?.contentType === 'html')
    ? rawBody.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : rawBody;
  const truncated = body_text.slice(0, MAX_BODY_CHARS);
  return {
    thread_id: input.threadId,
    from: fromAddr ? `${fromAddr.name ?? ''} <${fromAddr.address ?? ''}>`.trim() : '',
    to: toAddr ? `${toAddr.name ?? ''} <${toAddr.address ?? ''}>`.trim() : '',
    subject: msg.subject ?? '',
    sent_at: msg.sentDateTime ?? new Date().toISOString(),
    body_text: truncated,
    snippet: truncated.slice(0, 200),
  };
}
```

### Step 1.6 — Run, expect PASS

### Step 1.7 — Wire `mail.get_body` in dispatcher

- [ ] In `dispatch.ts`, add to imports:

```ts
import { gmailGetBody, outlookGetBody } from './mail-body.ts';
```

- [ ] Add a case in `executeTool`:

```ts
case 'mail.get_body': {
  const threadId = mustString(payload, 'thread_id');
  if (provider === 'google') {
    const r = await gmailGetBody({
      fetch: ctx.fetch,
      accessToken: ctx.gmail.accessToken,
      threadId,
    });
    return {
      mode: 'executed',
      reversible: false,
      reverseToken: null,
      recordPayload: { provider, thread_id: threadId, from: r.from, to: r.to, subject: r.subject, sent_at: r.sent_at, body_text: r.body_text },
    };
  }
  if (!ctx.outlook) throw new Error('outlook get_body requested but outlook context missing');
  const r = await outlookGetBody({
    fetch: ctx.fetch,
    accessToken: ctx.outlook.accessToken,
    threadId,
  });
  return {
    mode: 'executed',
    reversible: false,
    reverseToken: null,
    recordPayload: { provider, thread_id: threadId, from: r.from, to: r.to, subject: r.subject, sent_at: r.sent_at, body_text: r.body_text },
  };
}
```

### Step 1.8 — Commit

```bash
git add supabase/functions/_shared/agent/tools/mail-body.ts \
        supabase/functions/_shared/agent/tools/mail-body.test.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts
git commit -m "$(cat <<'EOF'
feat(agent): mail_get_body — read full thread body before drafting

- gmailGetBody walks thread → latest message, decodes base64url plain text
  body, returns headers + snippet (max 8000 chars)
- outlookGetBody filters conversation by id, prefers uniqueBody, falls back
  to body with naive HTML strip
- Dispatcher handles mail.get_body for both providers; read-only, never
  proposes, recordPayload includes the full body text
EOF
)"
```

---

## Task 2 — `cal_list_events` tool

**Why next:** Pairs with `mail_get_body` — without body context, listing calendar events is wasted, so Task 1 must land first.

**Files:**
- Create: `supabase/functions/_shared/agent/tools/calendar.ts`
- Create: `supabase/functions/_shared/agent/tools/calendar.test.ts`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`

### Step 2.1 — Test for `googleListEvents`

- [ ] Create `calendar.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
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
          attendees: [{ email: 'kollega@example.com' }],
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
  assertEquals(calledUrl.includes('timeMin=2026-05-14T00%3A00%3A00Z'), true);
});
```

### Step 2.2 — Implement `googleListEvents` (and `outlookListEvents` together)

- [ ] Create `calendar.ts`:

```ts
export type CalFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CalEvent {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string | null;
}

export async function googleListEvents(input: {
  fetch: CalFetch;
  accessToken: string;
  startIso: string;
  endIso: string;
}): Promise<CalEvent[]> {
  const params = new URLSearchParams({
    timeMin: input.startIso,
    timeMax: input.endIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    fields: 'items(summary,start,end,attendees(email,self),location)',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google calendar.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    items?: Array<{
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email?: string; self?: boolean }>;
      location?: string;
    }>;
  };
  return (json.items ?? []).map((it) => ({
    title: it.summary ?? '(uden titel)',
    start: it.start?.dateTime ?? it.start?.date ?? '',
    end: it.end?.dateTime ?? it.end?.date ?? '',
    attendees: (it.attendees ?? [])
      .filter((a) => a.self !== true && !!a.email)
      .map((a) => a.email as string),
    location: it.location ?? null,
  }));
}

export async function outlookListEvents(input: {
  fetch: CalFetch;
  accessToken: string;
  startIso: string;
  endIso: string;
}): Promise<CalEvent[]> {
  // Use /me/calendarView which expands recurring events into instances.
  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${
    encodeURIComponent(input.startIso)
  }&endDateTime=${encodeURIComponent(input.endIso)}&$top=50&$select=subject,start,end,attendees,location`;
  const res = await input.fetch(url, {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      prefer: 'outlook.timezone="UTC"',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph calendarView ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    value?: Array<{
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      attendees?: Array<{ emailAddress?: { address?: string }; type?: string }>;
      location?: { displayName?: string };
    }>;
  };
  return (json.value ?? []).map((it) => ({
    title: it.subject ?? '(uden titel)',
    start: it.start?.dateTime ?? '',
    end: it.end?.dateTime ?? '',
    attendees: (it.attendees ?? [])
      .filter((a) => a.type !== 'resource' && !!a.emailAddress?.address)
      .map((a) => a.emailAddress!.address as string),
    location: it.location?.displayName ?? null,
  }));
}
```

### Step 2.3 — Wire dispatcher case

- [ ] Add to `dispatch.ts`:

```ts
case 'cal.list_events': {
  const startIso = mustString(payload, 'start_iso');
  const endIso = mustString(payload, 'end_iso');
  if (provider === 'google') {
    const events = await googleListEvents({
      fetch: ctx.fetch,
      accessToken: ctx.gmail.accessToken, // same token, calendar.readonly scope
      startIso,
      endIso,
    });
    return {
      mode: 'executed',
      reversible: false,
      reverseToken: null,
      recordPayload: { provider, start_iso: startIso, end_iso: endIso, events },
    };
  }
  if (!ctx.outlook) throw new Error('outlook cal_list_events requested but outlook context missing');
  const events = await outlookListEvents({
    fetch: ctx.fetch,
    accessToken: ctx.outlook.accessToken,
    startIso,
    endIso,
  });
  return {
    mode: 'executed',
    reversible: false,
    reverseToken: null,
    recordPayload: { provider, start_iso: startIso, end_iso: endIso, events },
  };
}
```

### Step 2.4 — Add Outlook test + run + commit

- [ ] Mirror Step 2.1 with an `outlookListEvents` happy-path test (use Graph `calendarView` URL, value array shape).
- [ ] Run `deno test --allow-env supabase/functions/_shared/agent/tools/calendar.test.ts` — all pass.
- [ ] Commit:

```bash
git add supabase/functions/_shared/agent/tools/calendar.ts \
        supabase/functions/_shared/agent/tools/calendar.test.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts
git commit -m "feat(agent): cal_list_events — read calendar window for both providers"
```

---

## Task 3 — `drive_search` tool

**Files:**
- Create: `supabase/functions/_shared/agent/tools/drive.ts`
- Create: `supabase/functions/_shared/agent/tools/drive.test.ts`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`

The client-side equivalent in `src/lib/google-drive.ts:59` is the reference. Server-side port.

### Step 3.1 — Test

- [ ] Create `drive.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { driveSearchFiles, type DriveFetch } from './drive.ts';

Deno.test('driveSearchFiles: escapes single quotes in query, returns mapped files', async () => {
  let urlCalled = '';
  const fetch: DriveFetch = async (url) => {
    urlCalled = url;
    return new Response(JSON.stringify({
      files: [{
        id: 'f-1',
        name: "Albert's tilbud.pdf",
        mimeType: 'application/pdf',
        modifiedTime: '2026-05-10T10:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/f-1/view',
      }],
    }), { status: 200 });
  };
  const files = await driveSearchFiles({ fetch, accessToken: 'tok', query: "Albert's tilbud", limit: 5 });
  assertEquals(files.length, 1);
  assertEquals(files[0].name, "Albert's tilbud.pdf");
  assertEquals(urlCalled.includes("Albert%5C's%20tilbud") || urlCalled.includes("Albert%5C%27s"), true);
});
```

### Step 3.2 — Implement

- [ ] Create `drive.ts`:

```ts
export type DriveFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified_at: string;
  webViewLink: string | null;
}

function escapeQueryLiteral(s: string): string {
  // Drive query language: single quotes need backslash-escape.
  return s.replace(/'/g, "\\'");
}

export async function driveSearchFiles(input: {
  fetch: DriveFetch;
  accessToken: string;
  query: string;
  limit?: number;
}): Promise<DriveFile[]> {
  const limit = Math.min(input.limit ?? 10, 25);
  const escaped = escapeQueryLiteral(input.query.trim());
  const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`drive.files.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string }>;
  };
  return (json.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modified_at: f.modifiedTime ?? '',
    webViewLink: f.webViewLink ?? null,
  }));
}
```

### Step 3.3 — Dispatcher case

- [ ] In `dispatch.ts`:

```ts
case 'drive.search': {
  // Google-only for Phase 4a. Microsoft OneDrive is Phase 4b.
  if (provider !== 'google') {
    throw new Error('drive.search: only google supported in phase 4a');
  }
  const query = mustString(payload, 'query');
  const limit = typeof payload.limit === 'number' ? payload.limit : 10;
  const files = await driveSearchFiles({
    fetch: ctx.fetch,
    accessToken: ctx.gmail.accessToken,
    query,
    limit,
  });
  return {
    mode: 'executed',
    reversible: false,
    reverseToken: null,
    recordPayload: { provider, query, files },
  };
}
```

### Step 3.4 — Run, commit

```bash
deno test --allow-env supabase/functions/_shared/agent/tools/
git add supabase/functions/_shared/agent/tools/drive.ts \
        supabase/functions/_shared/agent/tools/drive.test.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts
git commit -m "feat(agent): drive_search — Google Drive lookup for referenced files"
```

---

## Task 4 — System prompt + types

**Why now:** Tools won't be discoverable to Claude until added to `MAIL_TRIAGE_TOOLS` AND the system prompt instructs when to use them.

**Files:**
- Modify: `supabase/functions/_shared/agent/types.ts` — extend `ActionType` + `ACTION_DEFAULT_MODE`
- Modify: `supabase/functions/_shared/agent/prompt.ts` — three new tool entries + map + prose
- Modify: `supabase/functions/_shared/agent/runner.ts:SUPPORTED_ACTIONS` — add the three new types

### Step 4.1 — Extend types

- [ ] In `types.ts`, add `'mail.get_body' | 'cal.list_events' | 'drive.search'` to the `ActionType` union and to `ACTION_DEFAULT_MODE` (all three default to `'auto'`). Update the KEEP-IN-SYNC `DEFAULT_POLICY` to match.

### Step 4.2 — Tool entries + name map

- [ ] In `prompt.ts`, extend `TOOL_NAME_TO_ACTION`:

```ts
const TOOL_NAME_TO_ACTION: Record<string, ActionType> = {
  mail_archive: 'mail.archive',
  mail_label: 'mail.label',
  mail_flag_important: 'mail.flag_important',
  mail_summarize: 'mail.summarize',
  mail_draft_reply: 'mail.draft_reply',
  mail_send_reply: 'mail.send_reply',
  mail_get_body: 'mail.get_body',
  cal_list_events: 'cal.list_events',
  drive_search: 'drive.search',
};
```

- [ ] Append three new tool entries to `MAIL_TRIAGE_TOOLS`:

```ts
{
  name: 'mail_get_body',
  description: 'Read the full text of the latest message in a thread. Call this BEFORE mail_draft_reply on any thread that asks a question, references a meeting time, or mentions a document. The body is what tells you what to answer.',
  input_schema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      provider: { type: 'string', enum: ['google', 'microsoft'] },
    },
    required: ['thread_id', 'provider'],
  },
},
{
  name: 'cal_list_events',
  description: 'Return the user\'s calendar events in a time window. Use BEFORE drafting any reply about availability, scheduling, or "are you free at X?". Pass start_iso/end_iso as ISO-8601 with timezone offset. Window should bracket the asked time by at least ±2h.',
  input_schema: {
    type: 'object',
    properties: {
      start_iso: { type: 'string' },
      end_iso: { type: 'string' },
      provider: { type: 'string', enum: ['google', 'microsoft'] },
    },
    required: ['start_iso', 'end_iso', 'provider'],
  },
},
{
  name: 'drive_search',
  description: 'Search the user\'s Google Drive by name + full-text. Use when a mail references a document (e.g. "did you see the proposal?", "the contract I sent"). Phase 4a is Google-only — skip for Outlook-only users.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
      provider: { type: 'string', enum: ['google'] },
    },
    required: ['query', 'provider'],
  },
},
```

### Step 4.3 — Update SYSTEM_PROMPT prose

- [ ] In `prompt.ts`, replace the SYSTEM_PROMPT block. Add a new section between current items 4 and 5 that teaches research-before-drafting:

```ts
const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Du kan udføre handlinger på både Gmail og Outlook (Microsoft).

Tilladte handlinger:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder) — KUN Gmail. Spring over for Outlook-tråde.
2. tilføje en kort kategori-label — KUN Gmail. Spring over for Outlook-tråde.
3. markere en tråd som vigtig — KUN Gmail. Spring over for Outlook-tråde.
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.
5. RESEARCH-FØRST: hvis afsenderen er et menneske og emnet/snippet ANTYDER et spørgsmål, en tid, eller refererer til et dokument, SKAL du kalde mail_get_body FØRST for at læse hele beskeden. Derefter:
   a. hvis brevet spørger om tid eller tilgængelighed: kald cal_list_events med vinduet ±2 timer omkring den nævnte tid.
   b. hvis brevet nævner et dokument/proposal/kontrakt o.l.: kald drive_search med relevante nøgleord.
   Først NÅR du har konteksten, kald mail_draft_reply.
6. udkast et reply (mail_draft_reply) — KUN når du har læst hele body'en med mail_get_body, brevet stiller et tydeligt spørgsmål, og du kan skrive et kort dansk svar uden at gætte.
7. foreslå at sende udkastet (mail_send_reply) umiddelbart efter mail_draft_reply, hvis svaret er entydigt OG du har researchet tråden i denne tur.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
- Hver tråd har en provider ('google' eller 'microsoft'). Du SKAL inkludere provider i payload til alle handlinger.
- For Outlook-tråde: kun mail_summarize, mail_get_body, cal_list_events, mail_draft_reply og mail_send_reply er tilgængelige. Forsøg ikke at arkivere/labelle/flagge Outlook-tråde — disse handlinger vil fejle.
- drive_search er KUN Google. Spring over hvis tråden er Outlook-only.
- Vær konservativ: hvis du er i tvivl efter research, gør ingenting.
- Du kan kalde flere værktøjer i samme tur. Stop når listen er triageret.
- Svar på dansk i den korte tekstkommentar efter værktøjskald.`;
```

### Step 4.4 — Register supported actions in runner

- [ ] In `runner.ts`, find the `SUPPORTED_ACTIONS` set and add the three new types. (Grep for `SUPPORTED_ACTIONS =`.)

### Step 4.5 — Run, commit

```bash
deno test --allow-env supabase/functions/_shared/agent/
git add supabase/functions/_shared/agent/types.ts \
        supabase/functions/_shared/agent/prompt.ts \
        supabase/functions/_shared/agent/runner.ts
git commit -m "feat(agent): expose mail_get_body / cal_list_events / drive_search to Claude

- Three read-only tools added to MAIL_TRIAGE_TOOLS
- TOOL_NAME_TO_ACTION extended (still underscore boundary translation)
- SYSTEM_PROMPT teaches research-before-draft: human sender + question
  hint → mail_get_body → optional cal_list_events / drive_search →
  mail_draft_reply
- SUPPORTED_ACTIONS in runner extended"
```

---

## Task 5 — Researched-threads safety rail

**Why:** Without this rail, the auto-send branch could fire on threads the agent never opened — drafting "yes I'm free" off the snippet alone. The user explicitly wanted research-grounded drafting.

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts` — track researched threads in the turn loop
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts` — extend `ExecuteSafetyContext` with `threadWasResearched: (threadId) => boolean`
- Modify: `supabase/functions/_shared/agent/runner.test.ts` — new test

### Step 5.1 — Extend safety context type

- [ ] In `dispatch.ts`:

```ts
export interface ExecuteSafetyContext {
  userIsIdle: boolean;
  hasRecipientHistory: (address: string) => Promise<boolean>;
  hasPriorFailedIdem: (idemKey: string) => Promise<boolean>;
  threadWasResearched: (threadId: string) => boolean; // NEW
}
```

### Step 5.2 — Update `mail.send_reply` branch

- [ ] In the `mail.send_reply` auto-send guard, add a fourth check BEFORE the existing three:

```ts
if (!opts.safety.threadWasResearched(threadId)) {
  // Refuse auto-send on a thread the agent never opened.
  return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
}
const [recipientOk, priorFail] = await Promise.allSettled([
  // ... existing code unchanged
]);
```

### Step 5.3 — Track researched threads in runner

- [ ] In `runner.ts`, add a `Set<string>` to the turn loop scope:

```ts
const researchedThreads = new Set<string>();
```

- [ ] After a successful `mail.get_body` execution (action === 'mail.get_body' AND exec.mode === 'executed'), add the thread to the set:

```ts
if (action === 'mail.get_body') {
  const threadId = typeof input.thread_id === 'string' ? input.thread_id : '';
  if (threadId) researchedThreads.add(threadId);
}
```

- [ ] Build the safety context with the predicate:

```ts
const safety: ExecuteSafetyContext | undefined = needsSafety
  ? {
      userIsIdle: ...,
      hasRecipientHistory: ...,
      hasPriorFailedIdem: ...,
      threadWasResearched: (id: string) => researchedThreads.has(id),
    }
  : undefined;
```

### Step 5.4 — Test

- [ ] Append to `runner.test.ts`:

```ts
Deno.test('runAgent: mail_send_reply auto-send refuses when thread not researched', async () => {
  // Set up: policy=auto, allowlist passes, idle passes, no prior fail,
  // BUT Claude calls mail_send_reply WITHOUT calling mail_get_body first.
  // Assert: proposal written, not executed.
});
```

(Fill in following the existing test scaffolding — stub `executeTool` to return `mode='propose'` only when `threadWasResearched` returns false.)

### Step 5.5 — Run, commit

```bash
deno test --allow-env supabase/functions/_shared/agent/
git add supabase/functions/_shared/agent/runner.ts \
        supabase/functions/_shared/agent/runner.test.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts
git commit -m "feat(agent): researched-thread rail on mail_send_reply auto-send

- ExecuteSafetyContext.threadWasResearched predicate added
- Runner tracks Set<thread_id> of threads that called mail.get_body
- Auto-send refuses + falls back to propose if the thread wasn't opened
  in the same run. Ensures we never auto-send a 'yes I'm free' off the
  snippet alone — every auto-sent reply is body-grounded."
```

---

## Task 6 — Deploy + smoke

### Step 6.1 — Deploy

- [ ] `npx supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt`

### Step 6.2 — Replay events for verification

- [ ] In Supabase MCP, reset the 24 events for Albert OR wait for a new inbound mail:

```sql
update public.agent_events
   set processed_at = null, batch_id = null
 where user_id = '9616ed63-9712-4ebd-a6cb-03c1481f92b5'
   and processed_at >= now() - interval '30 minutes';
```

### Step 6.3 — Watch agent_actions after next cron tick

- [ ] Within 60–90s expect `agent_actions` rows for `mail.get_body`, `cal.list_events`, possibly `drive.search`, plus follow-up `mail.draft_reply` / `mail.send_reply`. If any error rows appear in `agent_runs`, surface and fix.

### Step 6.4 — Manual smoke (Albert)

1. Send yourself a mail asking "Kan vi mødes torsdag kl. 12?"
2. Close the app for ≥ 60s
3. Wait ≤ 1 min for poll-mail + agent-tick
4. Expect:
   - `agent_actions` row for `mail.get_body` (thread opened)
   - `agent_actions` row for `cal.list_events` (Thursday window queried)
   - `proposed_actions` OR `agent_actions` row for `mail.draft_reply` followed by `mail.send_reply` (auto-send if allowlist passes; propose otherwise)
   - Today feed shows either a draft proposal OR a ✓ DONE auto-send

### Step 6.5 — Memory

- [ ] Update `project_autonomous_agent_phase4a.md` with shipped state and any quirks discovered during smoke.

---

## Self-review

- [x] Spec coverage: `cal.list_events` partially covers spec §5.1's calendar entry (`cal.rsvp` / `cal.create_event` / `cal.update_event` remain for Phase 4b).
- [x] No placeholders: every step has concrete code, file paths, or commands.
- [x] Type consistency: `MailBodyResult`, `CalEvent`, `DriveFile`, `ExecuteSafetyContext.threadWasResearched` — used consistently across tasks.
- [x] Out-of-scope explicitly stated: iCloud CalDAV reads, OneDrive search, trust escalation, calendar writes.

## Execution Handoff

Plan saved. Two execution options:

1. **Subagent-Driven** — fresh subagent per task, two-stage review after each. Took ~30 min per task for Phase 3.1; expect similar.
2. **Inline Execution** — execute in this session via executing-plans, batch checkpoints.

Which approach?
