# agent-reflect — calendar-prep nudges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first proactive agent behaviour — shortly before a calendar event, send the user one timely `nudge.push` enriched with light context pulled from their own mail.

**Architecture:** Extract the runner engine into a shared `executeRun`; mail-triage and a new reflect path are thin strategies that differ in context/prompt, tool set, and read-allowlist model. A new `agent-reflect` edge fn on a 30-min sweep computes upcoming events, emits deduped `calendar.upcoming` rows, and runs the reflect strategy. A new read-only `mail_search` tool lets reflect find a related thread; a discovered-thread allowlist keeps the no-hallucinated-ID guarantee.

**Tech Stack:** Deno + TypeScript Supabase edge functions; Claude (haiku) tool-use loop; Postgres (agent_events / agent_runs / agent_actions); pg_cron. Tests: Deno std `assert`.

**Spec:** `docs/superpowers/specs/2026-05-31-agent-reflect-calendar-prep-design.md`

**Conventions:** Run all tests from `supabase/functions/`: `deno test _shared/agent/ --allow-env`. Commit messages: Conventional Commits, scope `agent`, bullet bodies, no AI attribution. Server changes commit + deploy before any client work (there is no client work here).

---

## File Structure

- `_shared/agent/types.ts` — add `mail.search` to `DEFAULT_POLICY` + `ACTION_DEFAULT_MODE` (ActionType union already exists? no — add it).
- `_shared/agent/tools/mail-search.ts` — **new**: Gmail + Outlook search primitives.
- `_shared/agent/tools/dispatch.ts` — add `mail.search` case.
- `_shared/agent/prompt.ts` — add `mail_search` to `TOOL_NAME_TO_ACTION`; add `REFLECT_TOOLS` + `buildReflectPrompt`.
- `_shared/agent/reflect-events.ts` — **new**: pure `filterUpcomingEvents()` (window / all-day / solo / declined) + `toUpcomingPayload()`.
- `_shared/agent/runner.ts` — extract `executeRun`; add `AgentStrategy`; add `runReflect`; add allowlist-growth hook.
- `agent-reflect/index.ts` — **new** edge fn: compute → insert/dedup → runReflect.
- `supabase/migrations/<ts>_calendar_upcoming_dedup.sql` — partial unique index on agent_events.
- `supabase/schedule-agent-reflect.sql.template` — **new** cron template (manual apply).

---

## Task 1: Add `mail.search` action type + policy plumbing

**Files:**
- Modify: `supabase/functions/_shared/agent/types.ts`
- Test: `supabase/functions/_shared/agent/policy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `policy.test.ts`:

```ts
import { DEFAULT_POLICY, ACTION_DEFAULT_MODE } from './types.ts';

Deno.test('mail.search defaults to auto in both policy maps', () => {
  assertEquals(DEFAULT_POLICY['mail.search'], 'auto');
  assertEquals(ACTION_DEFAULT_MODE['mail.search'], 'auto');
});
```

(If `assertEquals` / the imports are already present at the top of the file, do not duplicate them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/policy.test.ts --allow-env`
Expected: FAIL — type error / `mail.search` not a key (the ActionType union has no `mail.search`).

- [ ] **Step 3: Implement**

In `types.ts`, add `'mail.search'` to the `ActionType` union (next to `mail.get_body`):

```ts
  | 'mail.get_body'
  | 'mail.search'
```

Add to **both** maps (next to the other auto context tools):

```ts
// in DEFAULT_POLICY
  'mail.get_body': 'auto',
  'mail.search': 'auto',
```
```ts
// in ACTION_DEFAULT_MODE
  'mail.get_body': 'auto',
  'mail.search': 'auto',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test _shared/agent/policy.test.ts --allow-env`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/types.ts supabase/functions/_shared/agent/policy.test.ts
git commit -m "feat(agent): add mail.search action type (auto, context-only)"
```

---

## Task 2: `mail_search` provider primitives

**Files:**
- Create: `supabase/functions/_shared/agent/tools/mail-search.ts`
- Test: `supabase/functions/_shared/agent/tools/mail-search.test.ts`

Pattern reference: `mail-body.ts` (Gmail vs Outlook fetch shape, `findHeader`, the `GmailFetch`/`OutlookFetch` types live in `gmail.ts`/`outlook.ts`).

- [ ] **Step 1: Write the failing test**

`mail-search.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { gmailSearch, outlookSearch } from './mail-search.ts';

Deno.test('gmailSearch returns one row per thread with from/subject/snippet', async () => {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.includes('/messages?')) {
      return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 });
    }
    // message get
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/tools/mail-search.test.ts --allow-env`
Expected: FAIL — `mail-search.ts` does not exist.

- [ ] **Step 3: Implement**

`mail-search.ts`:

```ts
// supabase/functions/_shared/agent/tools/mail-search.ts
//
// Read-only mailbox search for the reflect path. Returns one row per thread
// (deduped) so the agent can pick a related thread to read with mail_get_body.
import type { GmailFetch } from './gmail.ts';
import type { OutlookFetch } from './outlook.ts';

export interface MailSearchHit {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

function gmailHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function gmailSearch(input: {
  fetch: GmailFetch; accessToken: string; query: string; limit: number;
}): Promise<MailSearchHit[]> {
  const listUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${input.limit}&q=${encodeURIComponent(input.query)}`;
  const listRes = await input.fetch(listUrl, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!listRes.ok) throw new Error(`gmailSearch list ${listRes.status}`);
  const list = (await listRes.json()) as { messages?: Array<{ id: string; threadId: string }> };
  const seen = new Set<string>();
  const hits: MailSearchHit[] = [];
  for (const m of list.messages ?? []) {
    if (seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    const getRes = await input.fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    if (!getRes.ok) continue;
    const msg = (await getRes.json()) as {
      threadId: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = msg.payload?.headers ?? [];
    hits.push({
      thread_id: msg.threadId,
      from: gmailHeader(headers, 'From'),
      subject: gmailHeader(headers, 'Subject'),
      snippet: msg.snippet ?? '',
      date: gmailHeader(headers, 'Date'),
    });
  }
  return hits;
}

export async function outlookSearch(input: {
  fetch: OutlookFetch; accessToken: string; query: string; limit: number;
}): Promise<MailSearchHit[]> {
  const url =
    `https://graph.microsoft.com/v1.0/me/messages?$top=${input.limit}&$search=${encodeURIComponent(`"${input.query}"`)}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) throw new Error(`outlookSearch ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{
      conversationId: string; subject?: string; bodyPreview?: string; receivedDateTime?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
    }>;
  };
  const seen = new Set<string>();
  const hits: MailSearchHit[] = [];
  for (const m of data.value ?? []) {
    if (seen.has(m.conversationId)) continue;
    seen.add(m.conversationId);
    const name = m.from?.emailAddress?.name ?? '';
    const addr = m.from?.emailAddress?.address ?? '';
    hits.push({
      thread_id: m.conversationId,
      from: name ? `${name} <${addr}>` : addr,
      subject: m.subject ?? '',
      snippet: m.bodyPreview ?? '',
      date: m.receivedDateTime ?? '',
    });
  }
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test _shared/agent/tools/mail-search.test.ts --allow-env`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/mail-search.ts supabase/functions/_shared/agent/tools/mail-search.test.ts
git commit -m "feat(agent): add Gmail + Outlook mail search primitives"
```

---

## Task 3: `mail.search` dispatch case

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`
- Test: `supabase/functions/_shared/agent/tools/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `dispatch.test.ts`:

```ts
Deno.test('executeTool: mail.search (google) returns hits as context, no agent_actions semantics', async () => {
  const ctx = makeCtx({
    fetch: async (url: string) => {
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 });
      return new Response(JSON.stringify({ threadId: 't1', snippet: 's', payload: { headers: [{ name: 'From', value: 'A <a@x>' }, { name: 'Subject', value: 'Sub' }, { name: 'Date', value: 'd' }] } }), { status: 200 });
    },
  });
  const result = await executeTool('mail.search', { provider: 'google', query: 'a@x' }, ctx);
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, false);
  assertEquals(Array.isArray((result.recordPayload as { hits: unknown[] }).hits), true);
  assertEquals(((result.recordPayload as { hits: Array<{ thread_id: string }> }).hits)[0].thread_id, 't1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/tools/dispatch.test.ts --allow-env`
Expected: FAIL — `executeTool: unsupported action type mail.search`.

- [ ] **Step 3: Implement**

In `dispatch.ts`, add the import:

```ts
import { gmailSearch, outlookSearch } from './mail-search.ts';
```

Add a case in the `switch (action)` (next to `drive.search`):

```ts
    case 'mail.search': {
      const query = mustString(payload, 'query');
      const limit = typeof payload.limit === 'number' ? payload.limit : 10;
      const hits = provider === 'google'
        ? await gmailSearch({ fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, query, limit })
        : await (async () => {
            if (!ctx.outlook) throw new Error('outlook mail.search requested but outlook context missing');
            return outlookSearch({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, query, limit });
          })();
      return { mode: 'executed', reversible: false, reverseToken: null, recordPayload: { provider, query, hits } };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test _shared/agent/tools/dispatch.test.ts --allow-env`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/dispatch.ts supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "feat(agent): dispatch mail.search via provider search primitives"
```

---

## Task 4: Extract `executeRun` + `AgentStrategy` (mail-triage path unchanged)

This is a **refactor**. The regression gate is the existing 179 tests staying green — no behaviour change.

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`
- Test: existing `supabase/functions/_shared/agent/runner.test.ts` (must stay green)

- [ ] **Step 1: Define the strategy interface**

Add near the top of `runner.ts` (after the imports):

```ts
// A run strategy supplies the parts that differ between the mail-triage path
// (agent-tick) and the reflect path (agent-reflect). Everything else — the
// Claude loop, dispatch, idem, budget, trace — lives in executeRun and is shared.
export interface AgentStrategy {
  // Per-run system + user messages and the tool catalogue for this path.
  buildContext: (
    userId: string,
    events: ClaimedEvent[],
    deps: RunnerDeps,
  ) => Promise<{ system: ClaudeSystemBlock[]; messages: ClaudeUserMessage[]; tools: ReadonlyArray<unknown> }>;
  // Seed the readable-thread allowlist. mail-triage: the triggering threads.
  // reflect: empty (grown by mail_search).
  seedAllowlist: (events: ClaimedEvent[]) => Set<string>;
  // After a context tool returns, thread_ids to add to the allowlist.
  // reflect uses this for mail.search; mail-triage returns [].
  extendAllowlist: (action: ActionType, recordPayload: Record<string, unknown>) => string[];
}
```

- [ ] **Step 2: Move the engine into `executeRun`**

Refactor `runAgent` so its body from `openRun` through the `finally { finishRun }` becomes a new function:

```ts
async function executeRun(
  userId: string,
  trigger: AgentRunTrigger,
  events: ClaimedEvent[],
  deps: RunnerDeps,
  strategy: AgentStrategy,
): Promise<RunResult> { /* moved body */ }
```

Mechanical changes inside the moved body:
- Replace `const allow = buildThreadAllowlist(events);` with `const allow = strategy.seedAllowlist(events);` (allow is now a mutable `Set<string>`; `verifyThreadId` already takes a Set).
- Replace the context/prompt block
  `const { system, messages } = buildMailTriagePrompt({ threads, nowIso: ... }); const conversation = [...messages];`
  and the `loadThreadBriefs` + `senderByThread`/`sourceBody` setup with:
  `const { system, messages, tools } = await strategy.buildContext(userId, events, deps); const conversation = [...messages];`
  Move the mail-specific `loadThreadBriefs` + `senderByThread` + `soleSender` + `sourceBodyByThread` + `resolveSourceFrom` + `resolveSourceBody` setup **into the mail strategy's `buildContext`** (it returns the prompt; the maps it needs become closures it also returns — see Step 4). For the loop's `resolveSourceFrom`/`resolveSourceBody` usages (only in the propose / deferred-execute branches), have `buildContext` return them on the result object and read them in the loop via the returned object; reflect returns no-op versions.
- Replace `MAIL_TRIAGE_TOOLS` in the `callClaudeTurn(...)` call with the `tools` from `buildContext`.
- In the **context-only branch** (where `CONTEXT_ONLY_ACTIONS.has(action)` pushes the tool_result), after pushing, add:
  ```ts
  for (const tid of strategy.extendAllowlist(action, exec.recordPayload)) allow.add(tid);
  ```

> Implementation note: to keep `resolveSourceFrom`/`resolveSourceBody` working without leaking mail concepts into the core, widen the `buildContext` return type to also carry them:
> ```ts
> resolveSourceFrom?: (p: Record<string, unknown>) => string | undefined;
> resolveSourceBody?: (p: Record<string, unknown>) => string | undefined;
> ```
> In the loop, call `ctx.resolveSourceFrom?.(input) ?? undefined`. Reflect omits them.

- [ ] **Step 3: Re-point `runAgent` at the core**

```ts
export async function runAgent(input: RunInput): Promise<RunResult> {
  const { userId, trigger, deps } = input;
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) return { runId: null, processed: 0, status: 'budget_exceeded' };
  const events = await deps.claimEvents(userId, CLAIM_BATCH);
  if (events.length === 0) return { runId: null, processed: 0, status: 'ok' };
  return executeRun(userId, trigger, events, deps, mailTriageStrategy);
}
```

- [ ] **Step 4: Define `mailTriageStrategy`**

```ts
export const mailTriageStrategy: AgentStrategy = {
  async buildContext(userId, events, deps) {
    const threads = await deps.loadThreadBriefs(userId, events);
    const senderByThread = new Map<string, string>();
    for (const t of threads) if (t.from) senderByThread.set(t.thread_id, t.from);
    const soleSender = threads.length === 1 ? (threads[0].from ?? undefined) : undefined;
    const sourceBodyByThread = new Map<string, string>(); // populated by mail.get_body in the loop
    const resolveSourceFrom = (payload: Record<string, unknown>) => {
      const tid = typeof payload.thread_id === 'string' ? payload.thread_id : '';
      return (tid && senderByThread.get(tid)) || soleSender;
    };
    const resolveSourceBody = (payload: Record<string, unknown>) => {
      const tid = typeof payload.thread_id === 'string' ? payload.thread_id : '';
      if (tid && sourceBodyByThread.has(tid)) return sourceBodyByThread.get(tid);
      return sourceBodyByThread.size === 1 ? [...sourceBodyByThread.values()][0] : undefined;
    };
    const { system, messages } = buildMailTriagePrompt({ threads, nowIso: new Date().toISOString() });
    return { system, messages, tools: MAIL_TRIAGE_TOOLS, resolveSourceFrom, resolveSourceBody, _sourceBodyByThread: sourceBodyByThread };
  },
  seedAllowlist: (events) => buildThreadAllowlist(events),
  extendAllowlist: () => [],
};
```

> The `mail.get_body` context branch currently writes `sourceBodyByThread.set(...)`. Since that map now lives in the strategy result, store the returned `_sourceBodyByThread` reference in a loop-scoped variable and write to it in that branch (keeps current behaviour identical).

- [ ] **Step 5: Run the full suite to verify NO regression**

Run: `deno test _shared/agent/ --allow-env`
Expected: PASS — **179 passed** (same as before). If any mail-triage test fails, the extraction changed behaviour; fix until identical.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts
git commit -m "refactor(agent): extract executeRun + AgentStrategy (mail-triage unchanged)"
```

---

## Task 5: Reflect prompt + `REFLECT_TOOLS`

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts`
- Test: `supabase/functions/_shared/agent/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `prompt.test.ts`:

```ts
import { REFLECT_TOOLS, buildReflectPrompt } from './prompt.ts';

Deno.test('REFLECT_TOOLS is exactly mail_search, mail_get_body, nudge_push', () => {
  assertEquals(REFLECT_TOOLS.map((t) => t.name).sort(), ['mail_get_body', 'mail_search', 'nudge_push']);
});

Deno.test('actionTypeFromToolName maps mail_search', () => {
  assertEquals(actionTypeFromToolName('mail_search'), 'mail.search');
});

Deno.test('buildReflectPrompt lists events with time + attendees and injects Copenhagen date', () => {
  const { system, messages } = buildReflectPrompt({
    events: [{ event_id: 'e1', provider: 'google', title: 'Møde med Anders', start: '2026-06-01T12:00:00Z', location: 'Zoom', attendees: ['anders@x.dk'], description: '' }],
    nowIso: '2026-06-01T08:00:00Z',
  });
  const txt = (messages[0].content as string);
  assertEquals(txt.includes('Møde med Anders'), true);
  assertEquals(txt.includes('anders@x.dk'), true);
  assertEquals(txt.includes('Dags dato:'), true);
  assertEquals(system[0].cache_control, { type: 'ephemeral' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/prompt.test.ts --allow-env`
Expected: FAIL — `REFLECT_TOOLS` / `buildReflectPrompt` not exported.

- [ ] **Step 3: Implement**

In `prompt.ts`:

Add to `TOOL_NAME_TO_ACTION`: `mail_search: 'mail.search',`.

Add (reuse the existing `mail_search` not in MAIL_TRIAGE_TOOLS; define the tool def here and the prompt):

```ts
const MAIL_SEARCH_TOOL = {
  name: 'mail_search',
  description:
    'Search the user\'s mailbox for a thread related to an upcoming event — by an attendee\'s email address or by subject keywords. Returns recent matching threads (thread_id, from, subject, snippet, date). Use it before mail_get_body when you want context for a meeting. Include provider.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'attendee email and/or subject keywords' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      provider: { type: 'string', enum: ['google', 'microsoft'] },
    },
    required: ['query', 'provider'],
  },
} as const;

// mail_get_body and nudge_push tool defs already exist in MAIL_TRIAGE_TOOLS;
// reference the same objects so there is one source of truth.
const MAIL_GET_BODY_TOOL = MAIL_TRIAGE_TOOLS.find((t) => t.name === 'mail_get_body')!;
const NUDGE_PUSH_TOOL = MAIL_TRIAGE_TOOLS.find((t) => t.name === 'nudge_push')!;

export const REFLECT_TOOLS = [MAIL_SEARCH_TOOL, MAIL_GET_BODY_TOOL, NUDGE_PUSH_TOOL] as const;

const REFLECT_SYSTEM_PROMPT = `Du er Zolva. Du forbereder brugeren på kommende kalenderbegivenheder.

For hver begivenhed i brugerens besked:
- Afgør om en kort heads-up reelt hjælper. Spring rutine-/gentagne møder over, og alt der ikke kræver forberedelse.
- Hvis den hjælper, må du først kalde mail_search (på en deltagers e-mail eller emnet) for at finde en relateret tråd, og mail_get_body for at læse den. Du må KUN læse tråde som mail_search har returneret — opfind ALDRIG et thread_id.
- Send derefter PRÆCIS én nudge_push: en kort dansk påmindelse der nævner begivenheden (tid, evt. sted) og eventuel relevant kontekst fra mailen. Maks. én nudge pr. begivenhed.

Regler:
- provider ('google'/'microsoft') står ved hver begivenhed; inkludér den i alle kald.
- nudge_push: brug event_id som target_id, og en kort action_kind som 'meeting_prep'.
- Vær konservativ: i tvivl, så gør ingenting for den begivenhed. Svar kort på dansk efter værktøjskald.`;

export interface ReflectEvent {
  event_id: string; provider: 'google' | 'microsoft'; title: string;
  start: string; location?: string; attendees?: string[]; description?: string;
}

export function buildReflectPrompt(input: { events: ReflectEvent[]; nowIso?: string }): BuildMailTriagePromptResult {
  const system: ClaudeSystemBlock[] = [
    { type: 'text', text: REFLECT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const dateLine = input.nowIso
    ? `Dags dato: ${formatDanishDate(input.nowIso)} (tidszone Europe/Copenhagen).`
    : '';
  const lines = input.events.map((e) =>
    `- event_id=${e.event_id} | provider=${e.provider} | start=${e.start} | titel=${e.title}` +
    `${e.location ? ` | sted=${e.location}` : ''}` +
    `${e.attendees && e.attendees.length ? ` | deltagere=${e.attendees.join(', ')}` : ''}` +
    `${e.description ? ` | note=${e.description.slice(0, 200)}` : ''}`,
  );
  const body = [...(dateLine ? [dateLine, ''] : []), 'Kommende begivenheder:', '', ...lines].join('\n');
  return { system, messages: [{ role: 'user', content: body }] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test _shared/agent/prompt.test.ts --allow-env`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/prompt.test.ts
git commit -m "feat(agent): add REFLECT_TOOLS + buildReflectPrompt"
```

---

## Task 6: `reflect.search`/`mail.search` wiring in the runner sets + reflect strategy + `runReflect`

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`
- Test: `supabase/functions/_shared/agent/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `runner.test.ts` (uses the existing `makeDeps`). It drives a reflect run where the agent searches mail, reads a returned thread, and nudges:

```ts
import { runReflect, reflectStrategy } from './runner.ts';

Deno.test('runReflect: mail_get_body is allowed only on a thread mail_search returned', async () => {
  const { deps } = makeDeps();
  const events = [{ id: 10, kind: 'calendar.upcoming' as const, payload: { event_id: 'e1', provider: 'google', title: 'Møde', start: '2026-06-01T12:00:00Z' } }];
  let bodyReadThread: string | null = null;
  let nudged = false;
  let turn = 0;
  deps.callClaudeTurn = async () => {
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 's', name: 'mail_search', input: { query: 'anders@x.dk', provider: 'google' } }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' };
    if (turn === 2) return { content: [{ type: 'tool_use', id: 'b', name: 'mail_get_body', input: { thread_id: 't1', provider: 'google' } }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' };
    if (turn === 3) return { content: [{ type: 'tool_use', id: 'n', name: 'nudge_push', input: { action_kind: 'meeting_prep', target_id: 'e1', title: 'Møde om 2t', body: 'Anders sender tallene' } }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
  };
  deps.executeTool = async (action, payload) => {
    if (action === 'mail.search') return { mode: 'executed' as const, reversible: false, reverseToken: null, recordPayload: { hits: [{ thread_id: 't1', from: 'A', subject: 'S', snippet: 's', date: 'd' }] } };
    if (action === 'mail.get_body') { bodyReadThread = String(payload.thread_id); return { mode: 'executed' as const, reversible: false, reverseToken: null, recordPayload: { body_text: 'Anders sender tallene' } }; }
    return { mode: 'executed' as const, reversible: false, reverseToken: null, recordPayload: { ...payload } };
  };
  deps.fireNudge = async () => { nudged = true; return { sent: true }; };

  const result = await runReflect({ userId: 'u-1', events, deps });
  assertEquals(result.status, 'ok');
  assertEquals(bodyReadThread, 't1'); // allowed because mail_search returned t1
  assertEquals(nudged, true);
});

Deno.test('runReflect: mail_get_body on an un-searched thread is rejected by the guard', async () => {
  const { deps } = makeDeps();
  const events = [{ id: 11, kind: 'calendar.upcoming' as const, payload: { event_id: 'e1', provider: 'google', title: 'Møde', start: '2026-06-01T12:00:00Z' } }];
  let traceCaptured: Array<{ results?: Array<{ name: string | null; is_error: boolean; content: string }> }> | undefined;
  let turn = 0;
  deps.callClaudeTurn = async () => {
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 'b', name: 'mail_get_body', input: { thread_id: 't-evil', provider: 'google' } }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
  };
  deps.executeTool = async () => { throw new Error('should not execute'); };
  deps.finishRun = async (_r, _s, _u, _e, trace) => { traceCaptured = trace; };
  await runReflect({ userId: 'u-1', events, deps });
  const r = traceCaptured?.[0]?.results?.find((x) => x.name === 'mail_get_body');
  assertEquals(r?.is_error, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/runner.test.ts --allow-env`
Expected: FAIL — `runReflect` / `reflectStrategy` not exported.

- [ ] **Step 3: Implement**

In `runner.ts`:

Add `'mail.search'` to `SUPPORTED_ACTIONS`, `CONTEXT_ONLY_ACTIONS`, and `NON_THREAD_ACTIONS`.

Add `RunReflectInput` + the strategy + entry:

```ts
export interface RunReflectInput {
  userId: string;
  events: ClaimedEvent[]; // already-claimed calendar.upcoming rows
  deps: RunnerDeps;
}

export const reflectStrategy: AgentStrategy = {
  async buildContext(_userId, events, _deps) {
    const reflectEvents = events.map((e) => ({
      event_id: String(e.payload.event_id ?? ''),
      provider: (e.payload.provider === 'microsoft' ? 'microsoft' : 'google') as 'google' | 'microsoft',
      title: String(e.payload.title ?? ''),
      start: String(e.payload.start ?? ''),
      location: typeof e.payload.location === 'string' ? e.payload.location : undefined,
      attendees: Array.isArray(e.payload.attendees) ? (e.payload.attendees as unknown[]).filter((a): a is string => typeof a === 'string') : undefined,
      description: typeof e.payload.description === 'string' ? e.payload.description : undefined,
    }));
    const { system, messages } = buildReflectPrompt({ events: reflectEvents, nowIso: new Date().toISOString() });
    return { system, messages, tools: REFLECT_TOOLS };
  },
  seedAllowlist: () => new Set<string>(),
  extendAllowlist: (action, recordPayload) => {
    if (action !== 'mail.search') return [];
    const hits = Array.isArray(recordPayload.hits) ? recordPayload.hits : [];
    return hits.map((h) => (h && typeof h === 'object' ? String((h as { thread_id?: unknown }).thread_id ?? '') : '')).filter(Boolean);
  },
};

export async function runReflect(input: RunReflectInput): Promise<RunResult> {
  const { userId, events, deps } = input;
  const budget = await deps.checkBudget(userId);
  if (budget.exceeded) return { runId: null, processed: 0, status: 'budget_exceeded' };
  if (events.length === 0) return { runId: null, processed: 0, status: 'ok' };
  return executeRun(userId, 'reflect.sweep', events, deps, reflectStrategy);
}
```

> `import { REFLECT_TOOLS, buildReflectPrompt } from './prompt.ts';` — add to the existing prompt import line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test _shared/agent/runner.test.ts --allow-env`
Expected: PASS (new reflect tests + existing green)

- [ ] **Step 5: Run full suite**

Run: `deno test _shared/agent/ --allow-env`
Expected: PASS — all green (was 179, plus the new tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): add reflect strategy + runReflect with discovered-thread allowlist"
```

---

## Task 7: Pure upcoming-event filter

**Files:**
- Create: `supabase/functions/_shared/agent/reflect-events.ts`
- Test: `supabase/functions/_shared/agent/reflect-events.test.ts`

- [ ] **Step 1: Write the failing test**

`reflect-events.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { filterUpcomingEvents, type RawCalEvent } from './reflect-events.ts';

const now = new Date('2026-06-01T10:00:00Z');
const base: RawCalEvent = {
  event_id: 'e', provider: 'google', title: 'Møde', start: '2026-06-01T11:00:00Z', end: '2026-06-01T12:00:00Z',
  all_day: false, attendee_count: 2, response_status: 'accepted',
};

Deno.test('keeps an event starting within the 2h window', () => {
  assertEquals(filterUpcomingEvents([base], now, 120).length, 1);
});
Deno.test('drops an event starting after the window', () => {
  assertEquals(filterUpcomingEvents([{ ...base, start: '2026-06-01T13:00:00Z' }], now, 120).length, 0);
});
Deno.test('drops an event already started', () => {
  assertEquals(filterUpcomingEvents([{ ...base, start: '2026-06-01T09:00:00Z' }], now, 120).length, 0);
});
Deno.test('drops all-day events', () => {
  assertEquals(filterUpcomingEvents([{ ...base, all_day: true }], now, 120).length, 0);
});
Deno.test('drops solo events (no other attendees)', () => {
  assertEquals(filterUpcomingEvents([{ ...base, attendee_count: 1 }], now, 120).length, 0);
});
Deno.test('drops declined events', () => {
  assertEquals(filterUpcomingEvents([{ ...base, response_status: 'declined' }], now, 120).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test _shared/agent/reflect-events.test.ts --allow-env`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`reflect-events.ts`:

```ts
// supabase/functions/_shared/agent/reflect-events.ts
//
// Pure selection of which upcoming calendar events warrant a reflect run.
// Provider readers normalise into RawCalEvent; this module decides what stays.
export interface RawCalEvent {
  event_id: string;
  provider: 'google' | 'microsoft';
  title: string;
  start: string; // ISO-8601
  end: string;   // ISO-8601
  all_day: boolean;
  attendee_count: number;
  response_status: 'accepted' | 'tentative' | 'declined' | 'needsAction' | 'none';
  location?: string;
  description?: string;
}

export function filterUpcomingEvents(events: RawCalEvent[], now: Date, leadMinutes: number): RawCalEvent[] {
  const horizon = now.getTime() + leadMinutes * 60_000;
  return events.filter((e) => {
    if (e.all_day) return false;
    if (e.attendee_count < 2) return false;            // solo / focus block
    if (e.response_status === 'declined') return false;
    const start = new Date(e.start).getTime();
    if (Number.isNaN(start)) return false;
    return start > now.getTime() && start <= horizon;  // strictly upcoming, within window
  });
}

export function toUpcomingPayload(e: RawCalEvent, day: string, now: Date): Record<string, unknown> {
  return {
    event_id: e.event_id, provider: e.provider, title: e.title, start: e.start,
    location: e.location, attendees: undefined, description: e.description,
    minutes_until: Math.round((new Date(e.start).getTime() - now.getTime()) / 60_000),
    day,
  };
}
```

> `attendees` is left out of the payload here because the count-only filter does not carry the list; the provider reader populates `attendees` when it builds `RawCalEvent` → extend `RawCalEvent` with `attendees?: string[]` and set `attendees: e.attendees` in `toUpcomingPayload` if the reader provides them. Keep it optional.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test _shared/agent/reflect-events.test.ts --allow-env`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/reflect-events.ts supabase/functions/_shared/agent/reflect-events.test.ts
git commit -m "feat(agent): pure upcoming-event filter for reflect"
```

---

## Task 8: `calendar.upcoming` dedup index (migration)

**Files:**
- Create: `supabase/migrations/<timestamp>_calendar_upcoming_dedup.sql`

- [ ] **Step 1: Write the migration**

Use a timestamp after the latest existing migration. Content:

```sql
-- One un-acted calendar.upcoming event per (user, event_id, day). The reflect
-- sweep INSERTs ON CONFLICT DO NOTHING; this index makes the insert idempotent
-- across overlapping sweeps so an event is processed at most once per day.
create unique index if not exists agent_events_calendar_upcoming_dedup
  on public.agent_events (user_id, (payload->>'event_id'), (payload->>'day'))
  where kind = 'calendar.upcoming';
```

- [ ] **Step 2: Apply to prod**

Apply via Supabase MCP `apply_migration` (this repo's migration history is MCP-stamped — do NOT `db push`). Name: `calendar_upcoming_dedup`.

- [ ] **Step 3: Verify**

Query: `select indexname from pg_indexes where indexname = 'agent_events_calendar_upcoming_dedup';`
Expected: one row.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/<timestamp>_calendar_upcoming_dedup.sql
git commit -m "feat(agent): dedup index for calendar.upcoming events"
```

---

## Task 9: `agent-reflect` edge function

**Files:**
- Create: `supabase/functions/agent-reflect/index.ts`

Reuse references: `agent-tick/index.ts` for `buildDeps`, `selectEligibleUserIds`, `loadGmailAccessToken`/`loadOutlookAccessToken`, the cron-secret gate, and the per-user loop. Calendar reading reuses `googleListEvents`/`outlookListEvents` from `_shared/agent/tools/calendar.ts` (they return events for a window; map them to `RawCalEvent`).

- [ ] **Step 1: Implement the function**

```ts
// supabase/functions/agent-reflect/index.ts
//
// Reflect sweep (~every 30 min). Per eligible user: read calendars, pick events
// starting within the lead window, emit deduped calendar.upcoming rows, and run
// the reflect strategy on the freshly-inserted rows. No qualifying event → no run.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { runReflect, type ClaimedEvent } from '../_shared/agent/runner.ts';
import { buildDeps, selectEligibleUserIds, loadGmailAccessToken, loadOutlookAccessToken } from '../agent-tick/index.ts';
import { googleListEvents, outlookListEvents } from '../_shared/agent/tools/calendar.ts';
import { filterUpcomingEvents, toUpcomingPayload, type RawCalEvent } from '../_shared/agent/reflect-events.ts';

const LEAD_MINUTES = 120;
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

function copenhagenDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function readUpcoming(client: SupabaseClient, userId: string, now: Date): Promise<RawCalEvent[]> {
  const startIso = now.toISOString();
  const endIso = new Date(now.getTime() + LEAD_MINUTES * 60_000).toISOString();
  const out: RawCalEvent[] = [];
  const gTok = await loadGmailAccessToken(client, userId).catch(() => null);
  if (gTok) {
    const evs = await googleListEvents({ fetch: fetch as never, accessToken: gTok, startIso, endIso }).catch(() => []);
    for (const e of evs) out.push(mapGoogle(e));
  }
  const oTok = await loadOutlookAccessToken(client, userId).catch(() => null);
  if (oTok) {
    const evs = await outlookListEvents({ fetch: fetch as never, accessToken: oTok, startIso, endIso }).catch(() => []);
    for (const e of evs) out.push(mapOutlook(e));
  }
  return out;
}
```

> **Reader gap (verified against `calendar.ts`):** `CalEvent` today exposes `{ id, title, start, end, attendees: string[], location }` — enough for `attendee_count` (= `attendees.length`), but NOT `all_day` or `response_status`.
> - `all_day`: derive without touching the reader — Google/Outlook all-day events have a **date-only** `start` (`length === 10`, no `T`). `mapGoogle`/`mapOutlook` set `all_day = !e.start.includes('T')`.
> - `response_status`: NOT available — the Google reader fetches `attendees(email,self)` only, not `responseStatus`. **Choose one:** (a) extend `googleListEvents`/`outlookListEvents` to surface the self-attendee's response status (add `responseStatus` to the Google `fields`/type and the Outlook `$select`, map the `self` attendee's status; add a `calendar.test.ts` case) — preferred; or (b) drop the declined filter for v1 and set `response_status: 'none'` in the mappers, leaving the declined-skip to the agent's own judgement. Pick (a) if extending the reader is quick, else (b). Either way `RawCalEvent.response_status` stays in the type.
>
> `mapGoogle`/`mapOutlook` therefore build `RawCalEvent` as: `{ event_id: e.id, provider, title: e.title, start: e.start, end: e.end, all_day: !e.start.includes('T'), attendee_count: e.attendees.length, response_status: <per above>, location: e.location, attendees: e.attendees, description: <if reader exposes it, else omit> }`.

```ts
Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = new Date();
  const day = copenhagenDay(now);
  const userIds = await selectEligibleUserIds(client);
  const results: Array<{ userId: string; ran: boolean; error?: string }> = [];
  for (const uid of userIds) {
    try {
      const raw = await readUpcoming(client, uid, now);
      const picked = filterUpcomingEvents(raw, now, LEAD_MINUTES);
      if (picked.length === 0) { results.push({ userId: uid, ran: false }); continue; }
      // INSERT ... ON CONFLICT DO NOTHING; only newly-inserted rows come back.
      const rows = picked.map((e) => ({ user_id: uid, kind: 'calendar.upcoming', payload: toUpcomingPayload(e, day, now) }));
      const { data: inserted, error } = await client
        .from('agent_events')
        .upsert(rows, { onConflict: 'user_id,(payload->>event_id),(payload->>day)', ignoreDuplicates: true })
        .select('id, kind, payload');
      if (error) throw error;
      const events = (inserted ?? []) as ClaimedEvent[];
      if (events.length === 0) { results.push({ userId: uid, ran: false }); continue; }
      const deps = buildDeps(client, uid);
      await runReflect({ userId: uid, events, deps });
      // mark the rows processed so they leave the queue tail
      await client.from('agent_events').update({ processed_at: new Date().toISOString() }).in('id', events.map((e) => e.id));
      results.push({ userId: uid, ran: true });
    } catch (e) {
      results.push({ userId: uid, ran: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
});
```

> If `buildDeps`, `selectEligibleUserIds`, `loadGmailAccessToken`, `loadOutlookAccessToken` are not currently `export`ed from `agent-tick/index.ts`, export them (no behaviour change). Verify `ClaimedEvent` is exported from `runner.ts` (it is).
>
> `ignoreDuplicates: true` requires the conflict target to match the partial unique index. supabase-js may not accept the expression form in `onConflict`; if it rejects, fall back to a raw `client.rpc` or insert-per-row catching `23505`. Validate against the real client during execution.

- [ ] **Step 2: Typecheck**

Run: `deno check agent-reflect/index.ts`
Expected: clean.

- [ ] **Step 3: Deploy**

```bash
supabase functions deploy agent-reflect --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

- [ ] **Step 4: Smoke-test with the cron secret**

```bash
curl -s -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/agent-reflect" -H "x-cron-secret: $CRON_SECRET" | jq .
```
Expected: `{ "results": [ ... ] }` — `ran:false` for users with nothing upcoming. With a test event in the next 2h on the primary test account, expect a `nudge.push` to fire and an `agent_runs` row `trigger='reflect.sweep'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/agent-reflect/index.ts supabase/functions/agent-tick/index.ts
git commit -m "feat(agent): agent-reflect sweep emits calendar.upcoming and runs reflect"
```

---

## Task 10: Cron schedule (manual apply)

**Files:**
- Create: `supabase/schedule-agent-reflect.sql.template`

Reuse reference: `supabase/schedule-agent-tick.sql.template`.

- [ ] **Step 1: Write the template**

```sql
-- agent-reflect sweep — every 30 minutes. Manual apply (pg_cron templates are
-- NOT auto-applied). Replace PASTE_CRON_SECRET / PASTE_SERVICE_ROLE_KEY with the
-- real values (service role = sb_secret_… ; see project memory) before running.
select cron.schedule(
  'agent-reflect-sweep',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/agent-reflect',
    headers := jsonb_build_object('x-cron-secret', 'PASTE_CRON_SECRET', 'Authorization', 'Bearer PASTE_SERVICE_ROLE_KEY'),
    body := '{}'::jsonb
  );
  $$
);
```

- [ ] **Step 2: Apply + verify**

Apply the resolved SQL via Supabase MCP / dashboard SQL editor. Then:
`select jobname, schedule from cron.job where jobname = 'agent-reflect-sweep';`
Expected: one row, `*/30 * * * *`.

- [ ] **Step 3: Commit**

```bash
git add supabase/schedule-agent-reflect.sql.template
git commit -m "chore(agent): cron template for agent-reflect sweep"
```

---

## Task 11: Full-suite gate + memory

- [ ] **Step 1: Run everything**

Run: `deno test _shared/agent/ --allow-env`
Expected: all green.

- [ ] **Step 2: code-reviewer pass**

Dispatch the `feature-dev:code-reviewer` agent over the diff (exclude the unrelated `drive.file` working-tree changes). Address high-confidence findings TDD-style.

- [ ] **Step 3: Update project memory**

Add a memory note: agent-reflect calendar-prep shipped — what's live, the `executeRun`/strategy split, the `mail_search` + discovered-allowlist model, `LEAD_MINUTES=120`, and that quiet-hours gating (#2) is the next item with the prep-nudge-during-quiet-hours decision still open.

---

## Self-Review

**Spec coverage:**
- §3 shared core + strategies → Tasks 4, 6. ✓
- §4 agent-reflect + sweep + filter + dedup → Tasks 7, 8, 9, 10. ✓
- §5 reflect run + discovered-thread safety → Tasks 5, 6. ✓
- §6 mail_search tool → Tasks 1, 2, 3, 5, 6. ✓
- §7 quiet-hours handoff → noted, deferred to #2 (Task 11 memory). ✓
- §8 error/budget/observability → inherited via executeRun (Task 4); budget guard in runReflect (Task 6). ✓
- §9 testing → every task is TDD; mail-triage regression gate in Task 4 Step 5 + Task 6 Step 5. ✓
- §10 rollout (server-first, migration, cron, no client) → Tasks 8, 9, 10. ✓

**Known prerequisite flagged inline (not silently assumed):** `googleListEvents`/`outlookListEvents` may need extending to surface `attendees` / `all_day` / `response_status` for `RawCalEvent` (Task 9 Step 1 note). If so, that is a TDD sub-step in `calendar.test.ts` before Task 9.

**Placeholder scan:** `<timestamp>` in Task 8 is a real instruction (pick the next migration timestamp), not a placeholder gap. No TODO/TBD content steps.

**Type consistency:** `AgentStrategy` (buildContext/seedAllowlist/extendAllowlist) is defined in Task 4 and consumed identically in Task 6. `RawCalEvent` defined in Task 7, consumed in Task 9. `MailSearchHit` (Task 2) → `hits` payload (Task 3) → `extendAllowlist` reads `hits[].thread_id` (Task 6). Consistent.
