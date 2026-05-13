# Autonomous Agent — Phase 3.1 Carry-overs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five carry-overs from Phase 3 so the autonomous-agent feature is feature-complete before we start on Phase 4 sub-features (trust escalation, calendar, reflection).

**Architecture:** Five focused changes against the existing Phase 3 substrate (`supabase/functions/_shared/agent/*`, `supabase/functions/agent-approve/`, client `mail_events` write path). No new tables — `mail_events` gets one new column added via Supabase dashboard SQL. Recipient allowlist is a query against the existing `mail_events` table, not a new persisted set. Trust-escalation prompt and history are explicitly out of scope (Phase 4a).

**Tech Stack:** Deno 1.x edge functions, Supabase Postgres, Microsoft Graph v1.0, React Native (Expo) client. Tests use `Deno.test` with injected `fetch`.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-11-autonomous-background-actions-design.md` (§5.3, §6.4, §8.4 are load-bearing)
- Phase 3 plan (for style): `docs/superpowers/plans/2026-05-12-autonomous-agent-phase-3-proposals-drafts.md`
- Carry-over inventory (memory): `project_autonomous_agent_phase3.md`

---

## File structure

### Edge function modules (Deno)

| File | Responsibility | Change |
|---|---|---|
| `supabase/functions/_shared/agent/tools/outlook.ts` | Microsoft Graph write operations | **modify** — add `outlookMoveMessage`, `outlookSetFlag`, `outlookAddCategory` |
| `supabase/functions/_shared/agent/tools/outlook.test.ts` | Outlook tool unit tests | **modify** — three new test groups |
| `supabase/functions/_shared/agent/tools/dispatch.ts` | action_type → tool fan-out | **modify** — Outlook triage branches, `policy` + `safety` params, `to` on send_reply |
| `supabase/functions/_shared/agent/allowlist.ts` | Recipient-allowlist query helper | **create** |
| `supabase/functions/_shared/agent/allowlist.test.ts` | Allowlist helper unit tests | **create** |
| `supabase/functions/_shared/agent/types.ts` | Action enum + default-mode map | **modify** — export `ACTION_DEFAULT_MODE` |
| `supabase/functions/_shared/agent/runner.ts` | Per-turn execution loop | **modify** — deferred-execute branch + safety-rail context |
| `supabase/functions/_shared/agent/runner.test.ts` | Runner unit tests | **modify** — three new test groups |
| `supabase/functions/agent-approve/index.ts` | User-tap-Send executor | **modify** — generalize dispatch beyond drafts |
| `supabase/functions/agent-tick/index.ts` | Cron-driven turn entry point | **modify** — wire safety context to runner deps |

### Client modules (TS / React Native)

| File | Responsibility | Change |
|---|---|---|
| `src/lib/types.ts` | Shared client types | **modify** — `MailEvent.providerTo: string \| null` |
| `src/lib/profile-store.ts` | DB persistence layer | **modify** — write & read `provider_to` |
| `src/lib/mail-events.ts` | `recordMailEvent` facade | **modify** — accept `providerTo` |
| `src/screens/InboxDetailScreen.tsx` | Mail detail UI | **modify** — pass `providerTo` to `recordMailEvent` |

### Dashboard-only SQL (manual paste)

| File | Purpose | Apply via |
|---|---|---|
| `supabase/dashboard-only/2026-05-13-mail-events-provider-to.sql` | Add `provider_to text` column + index | Pasted by user OR applied via `mcp__plugin_supabase_supabase__execute_sql` |

`mail_events` is dashboard-only (memory `project_memory_schema_dashboard_only.md`) — no repo migration. We still commit the SQL under `supabase/dashboard-only/` for reproducibility.

---

## Test commands

- Deno tests, single file:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/tools/outlook.test.ts
  ```
- Deno tests, agent suite:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/
  ```
- TypeScript check (client):
  ```bash
  npx tsc --noEmit
  ```

---

## Task 1 — Outlook triage tools (move / flag / categorize)

**Why first:** Self-contained — no dependency on schema changes, allowlist, or runner refactor. Smallest useful unit.

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/outlook.ts`
- Modify: `supabase/functions/_shared/agent/tools/outlook.test.ts`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts:40-56,58-113` (remove rejection set + add 3 Outlook branches)

### Step 1.1 — Write failing test: `outlookMoveMessage`

- [ ] Append to `outlook.test.ts`:

```ts
Deno.test('outlookMoveMessage: POST /me/messages/{id}/move with destinationId', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-1/move',
      status: 201,
      body: { id: 'm-1-moved', parentFolderId: 'archive' },
    },
  ]);
  const result = await outlookMoveMessage({
    fetch,
    accessToken: 'tok',
    messageId: 'm-1',
    destinationFolderId: 'archive',
  });
  assertEquals(result.newMessageId, 'm-1-moved');
  assertEquals(result.reverseToken, {
    kind: 'graph.move',
    new_message_id: 'm-1-moved',
    original_folder_id: null,
  });
  assertEquals(calls[0].method, 'POST');
  assertEquals(JSON.parse(calls[0].body!), { destinationId: 'archive' });
});
```

### Step 1.2 — Run test, confirm fail

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/tools/outlook.test.ts
  ```
  Expected: FAIL — `outlookMoveMessage is not exported`.

### Step 1.3 — Implement `outlookMoveMessage`

- [ ] Append to `outlook.ts`:

```ts
export interface OutlookMoveReverseToken {
  kind: 'graph.move';
  new_message_id: string;
  original_folder_id: string | null;
}

export interface OutlookMoveMessageInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  destinationFolderId: string;
  originalFolderId?: string | null;
}

export interface OutlookMoveMessageResult {
  newMessageId: string;
  reverseToken: OutlookMoveReverseToken;
}

export async function outlookMoveMessage(
  input: OutlookMoveMessageInput,
): Promise<OutlookMoveMessageResult> {
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}/move`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationId: input.destinationFolderId }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.move ${res.status}: ${detail.slice(0, 200)}`);
  }
  const moved = (await res.json()) as { id: string };
  return {
    newMessageId: moved.id,
    reverseToken: {
      kind: 'graph.move',
      new_message_id: moved.id,
      original_folder_id: input.originalFolderId ?? null,
    },
  };
}
```

### Step 1.4 — Run, confirm pass

- [ ] Same command. Expected: PASS.

### Step 1.5 — Test + implement `outlookSetFlag`

- [ ] Test:

```ts
Deno.test('outlookSetFlag: PATCH /me/messages/{id} flag.flagStatus', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-2',
      status: 200,
      body: { id: 'm-2', flag: { flagStatus: 'flagged' } },
    },
  ]);
  const result = await outlookSetFlag({
    fetch,
    accessToken: 'tok',
    messageId: 'm-2',
    flagged: true,
  });
  assertEquals(result.reverseToken, {
    kind: 'graph.flag',
    message_id: 'm-2',
    previous: 'notFlagged',
  });
  assertEquals(JSON.parse(calls[0].body!), {
    flag: { flagStatus: 'flagged' },
  });
});
```

- [ ] Run — expect FAIL.
- [ ] Implement:

```ts
export interface OutlookFlagReverseToken {
  kind: 'graph.flag';
  message_id: string;
  previous: 'flagged' | 'notFlagged';
}

export interface OutlookSetFlagInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  flagged: boolean;
}

export async function outlookSetFlag(
  input: OutlookSetFlagInput,
): Promise<{ reverseToken: OutlookFlagReverseToken }> {
  const status = input.flagged ? 'flagged' : 'notFlagged';
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ flag: { flagStatus: status } }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.flag ${res.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'graph.flag',
      message_id: input.messageId,
      previous: input.flagged ? 'notFlagged' : 'flagged',
    },
  };
}
```

- [ ] Run — expect PASS.

### Step 1.6 — Test + implement `outlookAddCategory`

- [ ] Test:

```ts
Deno.test('outlookAddCategory: PATCH /me/messages/{id} adds category preserving existing', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-3?$select=categories',
      status: 200,
      body: { id: 'm-3', categories: ['Existing'] },
    },
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-3',
      status: 200,
      body: { id: 'm-3', categories: ['Existing', 'Zolva'] },
    },
  ]);
  const result = await outlookAddCategory({
    fetch,
    accessToken: 'tok',
    messageId: 'm-3',
    category: 'Zolva',
  });
  assertEquals(result.reverseToken, {
    kind: 'graph.category',
    message_id: 'm-3',
    category: 'Zolva',
    previous_categories: ['Existing'],
  });
  assertEquals(JSON.parse(calls[1].body!), { categories: ['Existing', 'Zolva'] });
});
```

- [ ] Run — expect FAIL.
- [ ] Implement (uses two-step GET-then-PATCH to preserve existing categories):

```ts
export interface OutlookCategoryReverseToken {
  kind: 'graph.category';
  message_id: string;
  category: string;
  previous_categories: string[];
}

export interface OutlookAddCategoryInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  category: string;
}

export async function outlookAddCategory(
  input: OutlookAddCategoryInput,
): Promise<{ reverseToken: OutlookCategoryReverseToken }> {
  const getRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}?$select=categories`,
    { method: 'GET', headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!getRes.ok) {
    const detail = await getRes.text().catch(() => '');
    throw new Error(`graph messages.get ${getRes.status}: ${detail.slice(0, 200)}`);
  }
  const existing = ((await getRes.json()) as { categories?: string[] }).categories ?? [];
  if (existing.includes(input.category)) {
    return {
      reverseToken: {
        kind: 'graph.category',
        message_id: input.messageId,
        category: input.category,
        previous_categories: existing,
      },
    };
  }
  const next = [...existing, input.category];
  const patchRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ categories: next }),
    },
  );
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`graph messages.category ${patchRes.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'graph.category',
      message_id: input.messageId,
      category: input.category,
      previous_categories: existing,
    },
  };
}
```

- [ ] Run — expect PASS.

### Step 1.7 — Wire dispatcher to call the new Outlook tools

- [ ] In `dispatch.ts:40-56`, delete the `OUTLOOK_REJECTED_TRIAGE` block entirely (the import section at the top also needs `outlookMoveMessage`, `outlookSetFlag`, `outlookAddCategory`, and their reverse-token types added to the imports from `./outlook.ts`).

- [ ] Extend the `mail.archive` case (currently Gmail-only) to branch on provider:

```ts
case 'mail.archive': {
  const threadId = mustString(payload, 'thread_id');
  const provider = mustProvider(payload);
  if (provider === 'google') {
    const { reverseToken } = await gmailModifyThread({
      fetch: ctx.fetch,
      accessToken: ctx.gmail.accessToken,
      threadId,
      addLabelIds: [],
      removeLabelIds: ['INBOX'],
    });
    return {
      mode: 'executed',
      reversible: true,
      reverseToken,
      recordPayload: { provider, thread_id: threadId },
    };
  }
  // Outlook: payload.thread_id IS the messageId for outlook (Graph
  // doesn't expose threads the same way). Caller passes archive-folder id.
  if (!ctx.outlook) throw new Error('outlook archive requested but outlook context missing');
  const archiveFolderId = mustString(payload, 'archive_folder_id');
  const { reverseToken } = await outlookMoveMessage({
    fetch: ctx.fetch,
    accessToken: ctx.outlook.accessToken,
    messageId: threadId,
    destinationFolderId: archiveFolderId,
  });
  return {
    mode: 'executed',
    reversible: true,
    reverseToken,
    recordPayload: { provider, thread_id: threadId, archive_folder_id: archiveFolderId },
  };
}
```

- [ ] Extend `mail.label` similarly — Gmail uses `resolveLabelId`, Outlook uses `outlookAddCategory`. Only `op === 'add'` for Outlook in this phase; document with an inline `if (op !== 'add') throw new Error('outlook label remove not supported in phase 3.1')`.

- [ ] Extend `mail.flag_important` — Gmail unchanged; Outlook uses `outlookSetFlag` with `flagged: true`.

### Step 1.8 — Add dispatcher tests for Outlook triage branches

- [ ] Create new tests at `supabase/functions/_shared/agent/tools/dispatch.test.ts` (no existing file) — test each Outlook triage branch with a stub `OutlookFetch`. Skip if pattern doesn't fit; otherwise:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { executeTool } from './dispatch.ts';

Deno.test('mail.archive (outlook): moves message to archive folder', async () => {
  let url = '';
  const fakeFetch = async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ id: 'moved-1' }), { status: 201 });
  };
  const result = await executeTool(
    'mail.archive',
    { provider: 'microsoft', thread_id: 'm-x', archive_folder_id: 'archive' },
    {
      fetch: fakeFetch as never,
      gmail: { accessToken: '', resolveLabelId: async () => '' },
      outlook: { accessToken: 'mtok' },
    },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(url, 'https://graph.microsoft.com/v1.0/me/messages/m-x/move');
});
```

### Step 1.9 — Run full Outlook + dispatcher suite

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/tools/
  ```
  Expected: all pass.

### Step 1.10 — Commit

- [ ] Stage and commit (per memory `project_commit_convention.md` — Conventional Commits, scope `agent`, bullet body):

```bash
git add supabase/functions/_shared/agent/tools/outlook.ts \
        supabase/functions/_shared/agent/tools/outlook.test.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts \
        supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): outlook triage tools — move, flag, categorize

- outlookMoveMessage wraps POST /me/messages/{id}/move
- outlookSetFlag wraps PATCH /me/messages/{id} with flag.flagStatus
- outlookAddCategory two-steps GET-then-PATCH to preserve existing categories
- dispatcher branches mail.archive / mail.label / mail.flag_important on provider
- removes OUTLOOK_REJECTED_TRIAGE — Phase 3 rejection no longer needed
EOF
)"
```

---

## Task 2 — `provider_to` column on `mail_events` (schema + client write path)

**Why next:** Allowlist helper (Task 3) reads `provider_to`. Need the column populated before the helper has anything to match against. Acceptable that historical rows are NULL — allowlist gracefully handles missing data.

**Files:**
- Create: `supabase/dashboard-only/2026-05-13-mail-events-provider-to.sql`
- Modify: `src/lib/types.ts:277-292`
- Modify: `src/lib/profile-store.ts:55-65,280-292`
- Modify: `src/lib/mail-events.ts:6-12,14-30`
- Modify: `src/screens/InboxDetailScreen.tsx:89-95,111-117`

### Step 2.1 — Write the dashboard SQL

- [ ] Create `supabase/dashboard-only/2026-05-13-mail-events-provider-to.sql`:

```sql
-- 2026-05-13 — Add provider_to to mail_events for recipient-allowlist matching.
--
-- mail_events lives in dashboard-only schema (no repo migration; see memory
-- project_memory_schema_dashboard_only.md). Paste this whole file into the
-- Supabase Dashboard SQL editor and run.

alter table public.mail_events
  add column if not exists provider_to text;

-- Index for the allowlist hot path: hasRecipientHistory(user_id, addr, 60d).
create index if not exists mail_events_user_to_occurred_idx
  on public.mail_events (user_id, provider_to, occurred_at desc)
  where provider_to is not null;
```

### Step 2.2 — Apply via Supabase MCP

- [ ] Use `mcp__plugin_supabase_supabase__execute_sql` against project `sjkhfkatmeqtsrysixop` with the file contents. Verify:

```sql
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'mail_events';
```

Expected: row for `provider_to` present.

### Step 2.3 — Update `MailEvent` type

- [ ] In `src/lib/types.ts`, change the type definition (currently lines 284-292):

```ts
export type MailEvent = {
  id: string;
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerTo: string | null;
  providerSubject: string | null;
  occurredAt: Date;
};
```

### Step 2.4 — Update `profile-store.ts` reader

- [ ] In `src/lib/profile-store.ts`, modify `rowToMailEvent` (currently lines 55-65) to read `provider_to`:

```ts
function rowToMailEvent(r: Record<string, unknown>): MailEvent {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    eventType: r.event_type as MailEventType,
    providerThreadId: r.provider_thread_id as string,
    providerFrom: (r.provider_from as string | null) ?? null,
    providerTo: (r.provider_to as string | null) ?? null,
    providerSubject: (r.provider_subject as string | null) ?? null,
    occurredAt: new Date(r.occurred_at as string),
  };
}
```

### Step 2.5 — Update `profile-store.ts` writer

- [ ] Modify `insertMailEvent` (currently lines 280-292):

```ts
export async function insertMailEvent(
  userId: string,
  ev: Omit<MailEvent, 'id' | 'userId' | 'occurredAt'>,
): Promise<void> {
  const { error } = await supabase.from('mail_events').insert({
    user_id: userId,
    event_type: ev.eventType,
    provider_thread_id: ev.providerThreadId,
    provider_from: ev.providerFrom,
    provider_to: ev.providerTo,
    provider_subject: ev.providerSubject,
  });
  if (error) throw error;
}
```

### Step 2.6 — Update `mail-events.ts` `RecordInput`

- [ ] Modify the `RecordInput` type and `recordMailEvent` body in `src/lib/mail-events.ts`:

```ts
type RecordInput = {
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerTo: string | null;
  providerSubject: string | null;
};

export function recordMailEvent(input: RecordInput): void {
  if (!PROFILE_MEMORY_ENABLED) return;
  if (!getPrivacyFlag('memory-enabled')) return;
  void insertMailEvent(input.userId, {
    eventType: input.eventType,
    providerThreadId: input.providerThreadId,
    providerFrom: input.providerFrom,
    providerTo: input.providerTo,
    providerSubject: input.providerSubject,
  })
    .then(() => {
      invalidatePreamble(input.userId);
    })
    .catch((err) => {
      if (__DEV__) console.warn('[mail-events] insert failed:', err);
    });
}
```

### Step 2.7 — Update `InboxDetailScreen.tsx` call sites

- [ ] Pull the user's own email out of session and pass it as `providerTo` for `eventType: 'replied'` events. The user emails outbound to `mail.from` (the original sender), so:
  - `eventType: 'replied'` → `providerTo: mail.from` (we replied to them)
  - `eventType: 'dismissed' | 'deferred' | 'read'` → `providerTo: <user's email from auth session>` (they received it)

- [ ] At top of file (after existing hooks):

```ts
const userEmail = user?.email ?? null;
```

- [ ] Update the 'replied' call (currently line 89-95):

```ts
recordMailEvent({
  userId: user.id,
  eventType: 'replied',
  providerThreadId: replyContextThreadId(detail.replyContext),
  providerFrom: mail.from,
  providerTo: mail.from,
  providerSubject: mail.subject,
});
```

- [ ] Update the 'dismissed' call (currently line 111-117):

```ts
recordMailEvent({
  userId: user.id,
  eventType: 'dismissed',
  providerThreadId: detail ? replyContextThreadId(detail.replyContext) : mail.id,
  providerFrom: mail.from,
  providerTo: userEmail,
  providerSubject: mail.subject,
});
```

- [ ] Repeat for any other `recordMailEvent(...)` invocation in this file. Grep first:
  ```bash
  grep -n "recordMailEvent" src/screens/InboxDetailScreen.tsx
  ```
  Pass `providerTo: userEmail` for received-mail event types and `providerTo: mail.from` for outbound-mail event types.

### Step 2.8 — Typecheck

- [ ] Run:
  ```bash
  npx tsc --noEmit 2>&1 | grep -E "mail-events|profile-store|InboxDetailScreen|types\.ts:28" | head -10
  ```
  Expected: empty (no new errors). Pre-existing `hooks.ts:5037` TS2322 is fine (memory `project_preexisting_ts_error`).

### Step 2.9 — Commit

- [ ] Stage and commit:

```bash
git add supabase/dashboard-only/2026-05-13-mail-events-provider-to.sql \
        src/lib/types.ts src/lib/profile-store.ts src/lib/mail-events.ts \
        src/screens/InboxDetailScreen.tsx
git commit -m "$(cat <<'EOF'
feat(agent): provider_to column on mail_events

- Adds provider_to to MailEvent type and write/read path on the client
- Dashboard-only SQL committed under supabase/dashboard-only/ for repro
- Recipient address recorded on replied/dismissed events to power the
  allowlist query in Task 3
EOF
)"
```

---

## Task 3 — Recipient-pattern allowlist helper

**Why next:** Task 4 (auto-send safety rails) and the future Phase 4 trust-escalation prompt both need a "has the user corresponded with this recipient" predicate.

**Files:**
- Create: `supabase/functions/_shared/agent/allowlist.ts`
- Create: `supabase/functions/_shared/agent/allowlist.test.ts`

### Step 3.1 — Write failing test for `hasRecipientHistory`

- [ ] Create `allowlist.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { hasRecipientHistory } from './allowlist.ts';

interface FakeQuery {
  selectArg: string;
  filters: Array<{ col: string; op: string; val: unknown }>;
  resolveWith: { count: number | null; error: Error | null };
}

function makeClient(q: FakeQuery) {
  // Minimal SupabaseClient surface needed by the helper.
  return {
    from(_table: string) {
      return {
        select(arg: string, _opts?: unknown) {
          q.selectArg = arg;
          const self = this as unknown as {
            eq: (c: string, v: unknown) => unknown;
            gte: (c: string, v: unknown) => unknown;
            then: (cb: (r: unknown) => void) => Promise<void>;
          };
          self.eq = (c, v) => {
            q.filters.push({ col: c, op: 'eq', val: v });
            return self;
          };
          self.gte = (c, v) => {
            q.filters.push({ col: c, op: 'gte', val: v });
            return self;
          };
          self.then = (cb) => Promise.resolve(cb({ count: q.resolveWith.count, error: q.resolveWith.error }));
          return self;
        },
      };
    },
  };
}

Deno.test('hasRecipientHistory: returns true when count >= threshold', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 4, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'mor@example.dk',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, true);
  assertEquals(q.selectArg, 'id');
  assertEquals(q.filters.find((f) => f.col === 'user_id')?.val, 'u-1');
  assertEquals(q.filters.find((f) => f.col === 'provider_to')?.val, 'mor@example.dk');
});

Deno.test('hasRecipientHistory: returns false when count below threshold', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 2, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'stranger@example.com',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
});

Deno.test('hasRecipientHistory: returns false on db error (fail-safe)', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: null, error: new Error('boom') } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'x@example.com',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
});

Deno.test('hasRecipientHistory: case-insensitive address match', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 5, error: null } };
  const client = makeClient(q);
  await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'Mor@Example.DK',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(q.filters.find((f) => f.col === 'provider_to')?.val, 'mor@example.dk');
});
```

### Step 3.2 — Run, confirm fail

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/allowlist.test.ts
  ```
  Expected: FAIL — module not found.

### Step 3.3 — Implement `hasRecipientHistory`

- [ ] Create `supabase/functions/_shared/agent/allowlist.ts`:

```ts
// Recipient-pattern allowlist helper (spec §8.4).
//
// Auto-send is only permitted to recipients the user has personally
// corresponded with `threshold` times in the last `withinDays` days.
// Implemented as a cheap COUNT query against mail_events.provider_to.
//
// Fail-safe: any error (RLS, missing column, network) returns false so
// we fall back to the proposal path instead of auto-sending.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface HasRecipientHistoryArgs {
  userId: string;
  address: string;
  threshold: number;
  withinDays: number;
}

export async function hasRecipientHistory(
  client: SupabaseClient,
  args: HasRecipientHistoryArgs,
): Promise<boolean> {
  const normalized = args.address.trim().toLowerCase();
  if (!normalized) return false;
  const cutoff = new Date(Date.now() - args.withinDays * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = (await client
    .from('mail_events')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', args.userId)
    .eq('provider_to', normalized)
    .gte('occurred_at', cutoff)) as unknown as { count: number | null; error: Error | null };
  if (error || count == null) return false;
  return count >= args.threshold;
}
```

> Note: the fake client in the test approximates the chain but skips the `{ count: 'exact', head: true }` options arg. Implementation calls `.select('id', { count: 'exact', head: true })`. The test's `selectArg` only checks the first positional argument (`'id'`) — that matches.

### Step 3.4 — Run, confirm pass

- [ ] Run same `deno test`. Expected: all 4 tests PASS.

### Step 3.5 — Commit

- [ ] Stage and commit:

```bash
git add supabase/functions/_shared/agent/allowlist.ts \
        supabase/functions/_shared/agent/allowlist.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): recipient-pattern allowlist helper

- hasRecipientHistory counts mail_events.provider_to occurrences in window
- Case-insensitive address match
- Fail-safe: returns false on db errors so auto-send falls back to propose
EOF
)"
```

---

## Task 4 — `mail.send_reply` mode=auto safety-railed path

**Why next:** Allowlist (Task 3) and Outlook triage (Task 1) are prerequisites. We don't want to wire auto-send before the rails exist.

**Files:**
- Modify: `supabase/functions/_shared/agent/types.ts` — export `ACTION_DEFAULT_MODE`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts` — extend `executeTool` signature with `policy` + `safety` + extend `mail.send_reply` branch
- Modify: `supabase/functions/_shared/agent/runner.ts:170-260` — build & pass safety context
- Modify: `supabase/functions/agent-tick/index.ts` — supply real safety deps
- Modify: `supabase/functions/_shared/agent/runner.test.ts` — new test for auto path
- Modify: `supabase/functions/_shared/agent/tools/dispatch.test.ts` — new test for auto/propose split

### Step 4.1 — Export `ACTION_DEFAULT_MODE` from `types.ts`

- [ ] Open `supabase/functions/_shared/agent/types.ts`. Confirm the existing default-mode map (currently a const around line 69). Promote it to a named export and add a type alias:

```ts
export type ActionMode = 'auto' | 'propose';

export const ACTION_DEFAULT_MODE: Record<ActionType, ActionMode> = {
  'mail.label': 'auto',
  'mail.archive': 'auto',
  'mail.flag_important': 'auto',
  'mail.summarize': 'auto',
  'mail.draft_reply': 'auto',
  'mail.send_reply': 'propose',
  // ... other entries unchanged
};
```

If the constant already exists under a different name, rename and re-export rather than duplicating.

### Step 4.2 — Extend `executeTool` signature

- [ ] Open `dispatch.ts`. Add optional `policy` + `safety` params:

```ts
export interface ExecuteSafetyContext {
  userIsIdle: boolean;
  hasRecipientHistory: (address: string) => Promise<boolean>;
  hasPriorFailedIdem: (idemKey: string) => Promise<boolean>;
}

export interface ExecuteOptions {
  policy?: ActionMode;          // resolved user policy ('auto' | 'propose')
  safety?: ExecuteSafetyContext; // required for outbound auto actions
}

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  // ... existing body, with mail.send_reply branch modified below.
}
```

### Step 4.3 — Update `mail.send_reply` branch in `dispatch.ts`

- [ ] Replace the existing `case 'mail.send_reply':` block (currently lines 174-194):

```ts
case 'mail.send_reply': {
  const threadId = mustString(payload, 'thread_id');
  const draftId = mustString(payload, 'draft_id');
  const draftHash = mustString(payload, 'draft_hash');
  const previewText = mustString(payload, 'preview_text');
  const toAddr = mustString(payload, 'to'); // NEW required field
  const provider = mustProvider(payload);

  const baseRecord = {
    provider,
    thread_id: threadId,
    draft_id: draftId,
    draft_hash: draftHash,
    preview_text: previewText,
    to: toAddr,
  };

  // Default behavior (no opts, or policy='propose') — write a proposal.
  if (opts.policy !== 'auto') {
    return {
      mode: 'propose',
      reversible: false,
      reverseToken: null,
      recordPayload: baseRecord,
    };
  }

  // Auto-send path — all safety rails must hold.
  if (!opts.safety) {
    return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
  }
  const idemKey = `${threadId}::${draftHash}`;
  const [recipientOk, priorFail] = await Promise.all([
    opts.safety.hasRecipientHistory(toAddr),
    opts.safety.hasPriorFailedIdem(idemKey),
  ]);
  if (!opts.safety.userIsIdle || !recipientOk || priorFail) {
    return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
  }

  // All gates passed — actually send.
  if (provider === 'google') {
    await gmailSendDraft({ fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, draftId });
  } else {
    if (!ctx.outlook) throw new Error('outlook send requested but outlook context missing');
    await outlookSendDraft({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, draftId });
  }
  return {
    mode: 'executed',
    reversible: false,
    reverseToken: null,
    recordPayload: baseRecord,
  };
}
```

- [ ] Add `gmailSendDraft` and `outlookSendDraft` to the imports at top of `dispatch.ts`.

### Step 4.4 — Tests for the two auto-send paths

- [ ] Append to `dispatch.test.ts`:

```ts
Deno.test('mail.send_reply (policy=auto, all rails pass): executes via Gmail', async () => {
  let sentUrl = '';
  const fakeFetch = async (u: string) => {
    sentUrl = u;
    return new Response('{}', { status: 200 });
  };
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't-1',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'mor@example.dk',
    },
    {
      fetch: fakeFetch as never,
      gmail: { accessToken: 'g', resolveLabelId: async () => '' },
    },
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => false,
      },
    },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(sentUrl, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/d-1/send');
});

Deno.test('mail.send_reply (policy=auto, recipient not in allowlist): falls back to propose', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't-1',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'stranger@example.com',
    },
    {
      fetch: fakeFetch as never,
      gmail: { accessToken: 'g', resolveLabelId: async () => '' },
    },
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => false,
        hasPriorFailedIdem: async () => false,
      },
    },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
});

Deno.test('mail.send_reply (policy=auto, user not idle): falls back to propose', async () => {
  const result = await executeTool(
    'mail.send_reply',
    { provider: 'google', thread_id: 't', draft_id: 'd', draft_hash: 'h', preview_text: 'p', to: 'a@b.dk' },
    { fetch: (async () => new Response('{}', { status: 200 })) as never, gmail: { accessToken: '', resolveLabelId: async () => '' } },
    { policy: 'auto', safety: { userIsIdle: false, hasRecipientHistory: async () => true, hasPriorFailedIdem: async () => false } },
  );
  assertEquals(result.mode, 'propose');
});
```

### Step 4.5 — Run dispatcher tests

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/tools/dispatch.test.ts
  ```
  Expected: all pass.

### Step 4.6 — Wire safety context in `runner.ts`

- [ ] Extend `RunnerDeps` (find the interface — likely in `runner.ts` or `types.ts`) with two new dep slots:

```ts
loadUserPolicy: (userId: string) => Promise<UserPolicyRow[]>; // already exists
isUserIdle: (userId: string, now: Date) => Promise<boolean>;
recipientAllowlistCheck: (userId: string, addr: string) => Promise<boolean>;
agentActionsPriorFailedIdem: (userId: string, idemKey: string) => Promise<boolean>;
```

- [ ] In the per-tool-use loop (runner.ts:184-230), after `resolvePolicy(...)` and the `policy === 'off'` rejection, build the safety context and pass to `executeTool`:

```ts
const safety: ExecuteSafetyContext = {
  userIsIdle: await deps.isUserIdle(userId, new Date()),
  hasRecipientHistory: (addr) => deps.recipientAllowlistCheck(userId, addr),
  hasPriorFailedIdem: (idem) => deps.agentActionsPriorFailedIdem(userId, idem),
};
const exec = await deps.executeTool(action, input, { policy, safety });
// ... rest of branch unchanged
```

> The runner currently calls `deps.executeTool(action, input)` — that signature must be extended. Search for the `executeTool: ...` type in `RunnerDeps` and update accordingly.

### Step 4.7 — Wire deps in `agent-tick/index.ts`

- [ ] In `agent-tick/index.ts`, locate the existing `RunnerDeps` construction (after `loadUserPresence` is defined). Add three new dep implementations:

```ts
import { hasRecipientHistory } from '../_shared/agent/allowlist.ts';
// ...

const isUserIdle = async (uid: string, now: Date): Promise<boolean> => {
  const presence = await loadUserPresence(uid);
  if (!presence?.last_active_at) return true; // never seen → idle
  const ageMs = now.getTime() - new Date(presence.last_active_at).getTime();
  return ageMs >= 60_000;
};

const recipientAllowlistCheck = (uid: string, addr: string) =>
  hasRecipientHistory(client, { userId: uid, address: addr, threshold: 3, withinDays: 60 });

const agentActionsPriorFailedIdem = async (uid: string, idem: string): Promise<boolean> => {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await client
    .from('agent_actions')
    .select('id')
    .eq('user_id', uid)
    .eq('payload->>idem_key', idem)
    .eq('status', 'failed')
    .gte('created_at', cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
};
```

Pass them into the `RunnerDeps` literal.

### Step 4.8 — Update runner unit test

- [ ] Append to `runner.test.ts`:

```ts
Deno.test('runner: mail.send_reply executes when policy=auto and all rails pass', async () => {
  // Build minimal stub deps where executeTool returns mode=executed.
  // Assert: writeProposedAction is NOT called, recordAction IS called.
  // (Use existing test scaffolding pattern in the file.)
});
```

Fill in following the existing test scaffolding pattern. Two more tests: one for `recipientOk=false → propose`, one for `userIsIdle=false → propose`.

### Step 4.9 — Run full suite

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/
  ```
  Expected: all pass.

### Step 4.10 — Update system prompt to surface `to`

- [ ] Open `supabase/functions/_shared/agent/prompt.ts` (or wherever the Claude tool schema lives — grep for `mail.send_reply` JSON schema). Add `to` as a required field in the tool's input schema, and note in the description "must equal the `to` value used in the prior `mail.draft_reply` step".

### Step 4.11 — Commit

```bash
git add supabase/functions/_shared/agent/types.ts \
        supabase/functions/_shared/agent/tools/dispatch.ts \
        supabase/functions/_shared/agent/tools/dispatch.test.ts \
        supabase/functions/_shared/agent/runner.ts \
        supabase/functions/_shared/agent/runner.test.ts \
        supabase/functions/_shared/agent/allowlist.ts \
        supabase/functions/agent-tick/index.ts \
        supabase/functions/_shared/agent/prompt.ts
git commit -m "$(cat <<'EOF'
feat(agent): mail.send_reply auto-send with safety rails

- ACTION_DEFAULT_MODE exported as named enum from types
- executeTool now takes optional policy + safety context
- mail.send_reply auto path requires userIsIdle + recipient in allowlist
  + no prior failed idem in last hour; any miss falls back to propose
- 'to' required on mail.send_reply input; system prompt updated
EOF
)"
```

---

## Task 5 — Deferred-execute path in `agent-approve`

**Why last:** This is the trickiest because it touches the cross-cutting state machine. Doing it after auto-send means the dispatcher signature and runner deps are already settled.

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts` — write proposal when policy=propose on default-auto action
- Modify: `supabase/functions/agent-approve/index.ts` — dispatch via `executeTool` for any action_type
- Modify: `supabase/functions/_shared/agent/runner.test.ts` — new test for deferred-execute write
- Modify (test): existing agent-approve integration coverage if any

### Step 5.1 — Runner: write proposal when policy='propose' on default-auto action

- [ ] In `runner.ts`, after `policy === 'off'` rejection (line 200) and BEFORE calling `executeTool`, add:

```ts
const defaultMode = ACTION_DEFAULT_MODE[action];
if (policy === 'propose' && defaultMode === 'auto') {
  // Deferred execution — write a proposal with the raw Claude input so
  // agent-approve can execute it later when the user taps Send.
  const idemKey = deriveIdemKey(action, input);
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const preview = buildProposalPreview(action, input);
  const proposalId = await deps.writeProposedAction({
    user_id: userId,
    run_id: runId,
    action_type: action,
    payload: { ...input, idem_key: idemKey, deferred_execute: true },
    preview,
    expires_at: expiresAt,
  });
  const presence = await deps.loadUserPresence(userId);
  if (shouldPushForProposal(presence, new Date())) {
    await deps.dispatchProposalPush(userId, {
      title: typeof preview.title === 'string' ? preview.title : 'Zolva',
      body: typeof preview.body === 'string' ? preview.body : 'En handling venter',
      actionId: proposalId,
    });
  }
  toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `proposed:${proposalId}` });
  continue;
}
```

- [ ] Import `ACTION_DEFAULT_MODE` from `./types.ts` if not already.

### Step 5.2 — `agent-approve` — generalize to any action_type

- [ ] Replace lines 73-95 of `agent-approve/index.ts`. Currently it forces provider check and only sends drafts. Replace with a call to `executeTool` using the same dispatch path the runner uses. Build a minimal `ExecuteContext` from the claimed payload:

```ts
import { executeTool } from '../_shared/agent/tools/dispatch.ts';
// ...

const payload = claimed.payload as Record<string, unknown>;
const provider = payload.provider;
if (provider !== 'google' && provider !== 'microsoft') {
  await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
  return new Response(JSON.stringify({ ok: false, reason: 'bad_provider' }), { status: 500 });
}

// Apply edited_body for send_reply only (other actions don't carry a body).
const finalPayload = body.edited_body && claimed.action_type === 'mail.send_reply'
  ? { ...payload, edited_body: body.edited_body }
  : payload;

let exec;
try {
  const gmailTok = provider === 'google' ? await loadGmailToken(client, userId) : '';
  const outlookTok = provider === 'microsoft' ? await loadOutlookToken(client, userId) : '';
  exec = await executeTool(
    claimed.action_type as ActionType,
    finalPayload,
    {
      fetch: fetch as never,
      gmail: {
        accessToken: gmailTok,
        resolveLabelId: async (name) => {
          // Reuse resolveLabelId from gmail.ts directly.
          const { resolveLabelId } = await import('../_shared/agent/tools/gmail.ts');
          return resolveLabelId({ fetch: fetch as never, accessToken: gmailTok, name });
        },
      },
      outlook: provider === 'microsoft' ? { accessToken: outlookTok } : undefined,
    },
    { policy: 'auto' }, // user just tapped Send — treat as authorized auto
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[agent-approve] execute error', msg);
  await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
  return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
}

await client.from('agent_actions').insert({
  user_id: userId,
  run_id: claimed.run_id,
  proposal_id: actionId,
  action_type: claimed.action_type,
  payload: exec.recordPayload,
  reversible: exec.reversible,
  reverse_token: exec.reverseToken,
});
await client
  .from('proposed_actions')
  .update({ status: 'executed', executed_at: new Date().toISOString() })
  .eq('id', actionId);

return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
```

- [ ] Add `ActionType` to imports from `../_shared/agent/types.ts`.

### Step 5.3 — Runner test: deferred-execute writes a proposal

- [ ] In `runner.test.ts`, add:

```ts
Deno.test('runner: deferred-execute — policy=propose on mail.archive writes proposal instead of executing', async () => {
  let executeToolCalled = false;
  let proposalWritten: unknown = null;
  // Reuse existing makeDeps pattern, override executeTool/writeProposedAction.
  const deps = makeDeps({
    loadUserPolicy: async () => [{ action_type: 'mail.archive', mode: 'propose' }],
    executeTool: async () => { executeToolCalled = true; throw new Error('should not be called'); },
    writeProposedAction: async (row) => { proposalWritten = row; return 'prop-x'; },
  });
  // Drive a turn that emits a mail.archive tool_use ...
  // Assert: executeToolCalled === false, proposalWritten.action_type === 'mail.archive'.
});
```

Adapt to the file's actual test scaffolding.

### Step 5.4 — Run all tests + typecheck

- [ ] Run:
  ```bash
  deno test --allow-env supabase/functions/_shared/agent/ supabase/functions/agent-approve/ supabase/functions/agent-tick/
  npx tsc --noEmit
  ```
  Expected: all pass; only pre-existing TS errors remain.

### Step 5.5 — Commit

```bash
git add supabase/functions/_shared/agent/runner.ts \
        supabase/functions/_shared/agent/runner.test.ts \
        supabase/functions/agent-approve/index.ts
git commit -m "$(cat <<'EOF'
feat(agent): deferred-execute path for currently-auto actions

- Runner writes a proposed_actions row when user policy=propose on a
  default-auto action (mail.archive / mail.label / mail.flag_important)
- agent-approve generalized: dispatches via executeTool for any action
  type instead of the Phase 3 drafts-only fast path
- Edited body still applied for mail.send_reply only
EOF
)"
```

---

## Task 6 — Deploy + OTA + smoke

### Step 6.1 — Deploy edge functions

Server changes ship first (memory `project_client_server_pr_split.md`):

- [ ] Deploy:
  ```bash
  npx supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
  npx supabase functions deploy agent-approve --project-ref sjkhfkatmeqtsrysixop
  ```
  (`agent-tick` runs as service-role via cron, so `--no-verify-jwt`. `agent-approve` is user-auth — no flag.)

### Step 6.2 — Apply dashboard SQL

- [ ] If Task 2.2 was deferred (e.g. plan was paused mid-task), apply now via MCP `execute_sql`. Re-verify column exists.

### Step 6.3 — Push to main

- [ ] Push all five commits:
  ```bash
  git push origin main
  ```

### Step 6.4 — OTA update

- [ ] Publish:
  ```bash
  npx eas-cli update --channel production \
    --message "agent: phase 3.1 carry-overs — outlook triage, provider_to, allowlist, auto-send, deferred-execute" \
    --non-interactive
  ```

### Step 6.5 — Smoke checklist

On the dev build (Expo Go can't run native modules per memory `feedback_expo_go_limits`):

- [ ] Send yourself a mail from an address you've replied to ≥3 times in the last 60 days. Toggle `mail.send_reply` policy to `auto` in Settings. Wait for agent-tick (≤ 1 min). Verify the reply is sent automatically (Sent folder shows it, Today feed shows ✓ DONE card).
- [ ] Send yourself a mail from a stranger address. Same `mail.send_reply=auto` policy. Verify it lands as a pending proposal (NOT auto-sent).
- [ ] Set `mail.archive` policy to `propose`. Trigger an archive (a newsletter). Verify it shows as pending in Today feed instead of immediately executing.
- [ ] Tap Send on a proposed mail.archive. Verify the Gmail thread is archived and the card flips to ✓ DONE.
- [ ] For an Outlook account: trigger a mail.label proposal (or auto). Verify the message receives the category in Outlook.com.

### Step 6.6 — Update memory

- [ ] Update `/Users/albertfeldt/.claude/projects/-Users-albertfeldt-ZolvaApp/memory/project_autonomous_agent_phase3.md`:
  - Mark Phase 3.1 carry-overs as shipped with date 2026-05-13.
  - Remove the "Phase 3.1 carry-overs to close" section.
- [ ] Optionally: write a new file `project_autonomous_agent_phase31.md` for the shipped state and link from `MEMORY.md`.

---

## Self-review against the spec

| Spec § | Requirement | Task |
|---|---|---|
| §5.2 | Policy resolver honors `propose` on currently-auto | Task 5 (runner deferred-execute) |
| §5.2 | Auto-send requires `userIsIdle` | Task 4 (safety rails) |
| §8.4 | Recipient-pattern allowlist | Task 3 (helper) + Task 4 (wired) |
| §8.4 | No prior failed idem in last hour | Task 4 (`hasPriorFailedIdem`) |
| §8.4 | Hard floor — never auto-send to a recipient user never replied to | Implicit in allowlist (provider_to populated from 'replied'/'dismissed' events; only 'replied' is from user → match-bias is OK for v1) |
| §5.1 | Outlook triage tools available | Task 1 |
| §3 carry-over | provider_to column | Task 2 |
| §3 carry-over | mail.send_reply auto-send honored | Task 4 |

**Out of scope (Phase 4a):** Trust-escalation prompt (§5.3), Trust-escalation history Settings section (§6.4 line 178). Tracked separately.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-autonomous-agent-phase-3-1-carryovers.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
