# Autonomous Agent — Phase 3 (Proposals + Draft Replies) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the `proposed_actions` flow on top of Phase 2's mail-triage. Add `mail.draft_reply` (auto, creates a real provider draft) and `mail.send_reply` (propose). Wire push notifications on proposal writes, a Today-feed pending section, a per-action policy picker in Settings, and a 72-hour expiration sweep. Adds Outlook (Microsoft Graph) drafts + send alongside Gmail; Outlook triage (archive/label/flag) stays deferred.

**Architecture:** Reuse Phase 2 runner mechanics; add a policy-resolution branch so `mode='propose'` writes to `proposed_actions` instead of executing. A new `agent-approve` JWT-authed edge function executes proposals on user approval. A pg_cron template sweeps stale pending proposals. The client gains `useProposedActions`, a `<ProposedActionCard>` with Send / Edit / Skip CTAs, a Settings policy picker, and a deep-linkable push handler. Outlook tools mirror the Gmail tools file already shipped in Phase 2.

**Tech Stack:** Supabase Postgres + RLS, Deno edge functions, raw `fetch` to Gmail v1 + Microsoft Graph + Anthropic Messages API, Expo Push, Expo + React Native + Supabase realtime, Jest (client), Deno test (edge functions).

**Spec:** `docs/superpowers/specs/2026-05-11-autonomous-background-actions-design.md` (esp. §5.1 action catalog rows for draft_reply/send_reply, §6.2 feed sections, §6.3 push trigger, §6.4 Settings, §8.1 idem keys, §10 Phase 3 row).

**Phase 2 foundations being reused:** runner.ts (Claude+tool loop), tools/{gmail,dispatch}.ts (extended), claude.ts, prompt.ts, verify.ts, idem.ts, agent-tick/index.ts, AgentActionCard.tsx, TodayAgentFeed.tsx, useAgentActions hook, agent-undo edge fn.

---

## Scope (in vs. out)

**In Phase 3:**
- New action types: `mail.draft_reply` (auto, both providers) + `mail.send_reply` (propose, both providers).
- `poll-mail` extends event emission to **microsoft** watchers (required for Outlook drafts to fire).
- `proposed_actions` write path in runner; policy resolver consulted per action.
- New `agent-approve` edge function executes a proposal on user tap.
- 72-hour `expires_at` set on every proposal; cron sweep marks expired ones.
- Push notification on proposal write **only when** `now() - last_active_at > 60s` (foreground check).
- `<ProposedActionCard>` with Send / Edit / Skip CTAs; counter header in Today feed; tab badge for pending count.
- Settings — per-action policy picker (Auto / Spørg / Fra).
- Outlook tool implementations (`createDraft`, `sendDraft`) added in a new `tools/outlook.ts`.
- Gmail tool extensions (`gmailCreateDraft`, `gmailSendDraft`) added to existing `tools/gmail.ts`.

**Out (deferred):**
- **Outlook triage** (archive/label/flag) → 3.1. The dispatcher rejects these for `provider='microsoft'` with a clear tool-result error; system prompt steers Claude away.
- **Auto-send** (`mail.send_reply` running as `mode=auto`) → 3.1. Recipient-pattern allowlist requires a `provider_to` column on `mail_events` which doesn't exist yet.
- **`mail.send_new`** (originate new mail) → Phase 4.
- **Trust-escalation prompt** (spec §5.3 "Zolva noticed you always approve replies to your mom") → Phase 4.
- **Calendar actions** → Phase 4.
- **Reflection sweeps** (`agent-reflect` cron) → Phase 4.

---

## File structure

### Created
- `supabase/schedule-agent-expire-proposals.sql.template` — pg_cron every 5 min: `UPDATE proposed_actions SET status='expired' WHERE status='pending' AND expires_at < now()`. Manual apply.
- `supabase/functions/_shared/agent/tools/outlook.ts` — Microsoft Graph: `outlookCreateDraft`, `outlookSendDraft`, `outlookDeleteDraft` + reverse-token shape `OutlookReverseToken`.
- `supabase/functions/_shared/agent/tools/outlook.test.ts`
- `supabase/functions/_shared/agent/push.ts` — pure helper: `shouldPushForProposal(presenceLastActiveAt: Date | null, now: Date): boolean` (true if > 60s idle OR null).
- `supabase/functions/_shared/agent/push.test.ts`
- `supabase/functions/_shared/agent/expo-push.ts` — Expo Push API caller mirroring `reminders-fire`/`chat-run` shape; takes `tokens[] + title + body + data`, returns void (fire-and-forget). Injectable `fetch`.
- `supabase/functions/_shared/agent/expo-push.test.ts`
- `supabase/functions/agent-approve/index.ts` — JWT-authed POST `{ action_id, edited_body?: string }`. Reads the proposal row, executes the action via dispatch, writes `agent_actions`, transitions proposal to `executed`.
- `supabase/functions/agent-approve/deno.json`
- `supabase/functions/agent-approve/index.test.ts`
- `src/lib/agent-proposals.ts` — `useProposedActions(userId)` hook (realtime), `approveProposedAction(id, editedBody?)`, `dismissProposedAction(id)`, `usePendingProposalCount(userId)` hook.
- `src/lib/__tests__/agent-proposals.test.ts`
- `src/components/ProposedActionCard.tsx` — pending-card with Send / Rediger / Spring over.
- `src/components/AgentActionPolicySection.tsx` — Settings per-action policy picker.

### Modified
- `supabase/functions/poll-mail/emit.ts` — `buildMailNewEventRows` accepts `microsoft` as well as `google`; emits with `provider: 'microsoft'` in payload.
- `supabase/functions/poll-mail/emit.test.ts` — new test cases for microsoft emission.
- `supabase/functions/_shared/agent/types.ts` — `DEFAULT_POLICY` unchanged (already correct), but document that `mail.draft_reply` is auto and `mail.send_reply` is propose.
- `supabase/functions/_shared/agent/idem.ts` — add `mail.draft_reply` and `mail.send_reply` cases.
- `supabase/functions/_shared/agent/idem.test.ts` — add coverage.
- `supabase/functions/_shared/agent/prompt.ts` — extend `MAIL_TRIAGE_TOOLS` to include `mail.draft_reply` + `mail.send_reply`; extend system prompt with conservative-draft criteria + Outlook scope note.
- `supabase/functions/_shared/agent/prompt.test.ts` — assert new tool catalog count and key prompt anchors.
- `supabase/functions/_shared/agent/tools/gmail.ts` — add `gmailCreateDraft`, `gmailSendDraft`, `gmailDeleteDraft` + `GmailDraftReverseToken`.
- `supabase/functions/_shared/agent/tools/gmail.test.ts` — extend.
- `supabase/functions/_shared/agent/tools/dispatch.ts` — accept `payload.provider`, route to Gmail or Outlook draft/send. Reject Outlook triage (archive/label/flag) with explicit error. Add `propose` path that returns `{mode:'propose'}` instead of executing.
- `supabase/functions/_shared/agent/tools/dispatch.test.ts` — extend.
- `supabase/functions/_shared/agent/runner.ts` — call `resolvePolicy` per action; on `mode='propose'` write to `proposed_actions` (via new dep) instead of executing; record per-tool result `'proposed'` to Claude; on success of execute path stay unchanged.
- `supabase/functions/_shared/agent/runner.test.ts` — add propose-path tests, push-on-proposal test.
- `supabase/functions/agent-tick/index.ts` — extend `buildDeps`: `loadOutlookAccessToken`, `loadUserPolicy`, `writeProposedAction`, `loadUserPresence`, `dispatchProposalPush`. Wire to new helpers.
- `src/lib/agent-feed.ts` — leave the executed-actions hook alone; nothing changes here.
- `src/screens/TodayScreen.tsx` — render `<ProposedActionCard>` list above the existing `<TodayAgentFeed>` (which shows executed actions). Add a "venter / udført" counter header.
- `src/screens/SettingsScreen.tsx` — render `<AgentActionPolicySection>` below the existing `<ZolvaHandlingerSection>` toggle.
- `src/lib/push-handler.ts` (or wherever push-data deep-links live — find it during Task 19) — handle `data.type === 'agent_proposal'`, deep-link to Today tab.
- `src/components/TabBar.tsx` (or main navigator config — confirm path during Task 20) — pending-proposal count drives a red badge on the Today tab icon.

---

## Task 1: Cron template — proposal expiration

**Files:**
- Create: `supabase/schedule-agent-expire-proposals.sql.template`

Per repo convention (`project_cron_template_apply.md`), `.sql.template` files are manually applied via the Supabase Dashboard SQL editor.

- [ ] **Step 1: Write the template**

```sql
-- supabase/schedule-agent-expire-proposals.sql.template
--
-- Paste this whole file into the Supabase Dashboard SQL editor.
-- Replace PASTE_SB_SECRET_KEY with your sb_secret_… key from
-- Project Settings -> API. Do NOT keep the angle brackets.
--
-- Sweeps proposed_actions whose pending TTL has elapsed. Runs every 5
-- minutes. Lightweight — touches only pending rows that are past
-- expires_at, sets them to 'expired'.

select cron.schedule(
  'agent-expire-proposals',
  '*/5 * * * *',
  $cmd$update public.proposed_actions
     set status = 'expired',
         decided_at = now()
   where status = 'pending'
     and expires_at is not null
     and expires_at < now();$cmd$
);
```

- [ ] **Step 2: Commit**

```bash
git add supabase/schedule-agent-expire-proposals.sql.template
git commit -m "feat(agent): cron template for proposal expiration sweep (manual apply)"
```

---

## Task 2: Extend `poll-mail/emit.ts` for microsoft watchers

**Files:**
- Modify: `supabase/functions/poll-mail/emit.ts`
- Modify: `supabase/functions/poll-mail/emit.test.ts`

TDD.

- [ ] **Step 1: Add failing test cases**

Append to `supabase/functions/poll-mail/emit.test.ts`:

```ts
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
```

Also REPLACE the existing test "buildMailNewEventRows: returns empty for microsoft (phase 2 scope)" — that scope is closing in Phase 3. Delete that test.

- [ ] **Step 2: Run tests, watch the new ones fail**

Run: `deno test supabase/functions/poll-mail/emit.test.ts --allow-env --allow-net`
Expected: the two new tests FAIL because `buildMailNewEventRows` short-circuits microsoft to `[]`.

- [ ] **Step 3: Update `emit.ts`**

In `supabase/functions/poll-mail/emit.ts`, replace the function body and `MailNewEventRow` type so microsoft is emitted:

```ts
export interface MailNewEventRow {
  user_id: string;
  kind: 'mail.new';
  payload: {
    provider: 'google' | 'microsoft';
    message_id: string;
    thread_id: string | null;
    from: string;
    subject: string;
    idem_key: string;
  };
}

// Phase 3 emits for both google and microsoft. iCloud follows when its
// tool implementations land (Phase 3.2+).
export function buildMailNewEventRows(
  input: BuildMailNewEventsInput,
): MailNewEventRow[] {
  if (input.provider !== 'google' && input.provider !== 'microsoft') return [];
  return input.messages.map((m) => ({
    user_id: input.userId,
    kind: 'mail.new',
    payload: {
      provider: input.provider,
      message_id: m.messageId,
      thread_id: m.threadId ?? null,
      from: m.from,
      subject: m.subject,
      idem_key: `${input.provider}:${m.messageId}`,
    },
  }));
}
```

- [ ] **Step 4: Tests pass**

Run: `deno test supabase/functions/poll-mail/emit.test.ts --allow-env --allow-net`
Expected: 4 tests passing (the original "one row per gmail message" + "handles missing threadId" + 2 new microsoft tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/poll-mail/emit.ts supabase/functions/poll-mail/emit.test.ts
git commit -m "feat(agent): poll-mail emits mail.new for microsoft watchers"
```

---

## Task 3: Idempotency keys for new action types

**Files:**
- Modify: `supabase/functions/_shared/agent/idem.ts`
- Modify: `supabase/functions/_shared/agent/idem.test.ts`

Per spec §8.1: `mail.send_reply` keys on `(thread_id, draft_hash)`. We extend that to `mail.draft_reply` keyed on `(thread_id, draft_hash)` so re-running the same prompt won't create a second draft.

- [ ] **Step 1: Add failing test cases**

Append to `supabase/functions/_shared/agent/idem.test.ts`:

```ts
Deno.test('mail.draft_reply idem key uses thread_id and draft_hash', () => {
  assertEquals(
    deriveIdemKey('mail.draft_reply', { thread_id: 't1', draft_hash: 'sha1-abc' }),
    'mail.draft_reply:t1:sha1-abc',
  );
});

Deno.test('mail.send_reply idem key uses thread_id and draft_hash', () => {
  assertEquals(
    deriveIdemKey('mail.send_reply', { thread_id: 't1', draft_hash: 'sha1-abc' }),
    'mail.send_reply:t1:sha1-abc',
  );
});

Deno.test('mail.draft_reply throws on missing draft_hash', () => {
  assertThrows(
    () => deriveIdemKey('mail.draft_reply', { thread_id: 't1' } as never),
    Error,
    'draft_hash',
  );
});
```

- [ ] **Step 2: Run and fail**

Run: `deno test supabase/functions/_shared/agent/idem.test.ts --allow-env --allow-net`
Expected: 3 new tests FAIL with `deriveIdemKey: unsupported action type mail.draft_reply` (or `mail.send_reply`).

- [ ] **Step 3: Extend `idem.ts`**

Inside the switch in `supabase/functions/_shared/agent/idem.ts`, add two new cases ABOVE the `default:` clause:

```ts
    case 'mail.draft_reply':
      return `mail.draft_reply:${req(payload, 'thread_id')}:${req(payload, 'draft_hash')}`;
    case 'mail.send_reply':
      return `mail.send_reply:${req(payload, 'thread_id')}:${req(payload, 'draft_hash')}`;
```

- [ ] **Step 4: Pass**

Run: `deno test supabase/functions/_shared/agent/idem.test.ts --allow-env --allow-net`
Expected: 8 tests passing (5 from Phase 2 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/idem.ts supabase/functions/_shared/agent/idem.test.ts
git commit -m "feat(agent): idem keys for mail.draft_reply and mail.send_reply"
```

---

## Task 4: Gmail draft + send tools

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/gmail.ts`
- Modify: `supabase/functions/_shared/agent/tools/gmail.test.ts`

TDD.

- [ ] **Step 1: Append failing tests**

Append to `supabase/functions/_shared/agent/tools/gmail.test.ts`:

```ts
import { gmailCreateDraft, gmailSendDraft, gmailDeleteDraft } from './gmail.ts';

Deno.test('gmailCreateDraft: posts to drafts endpoint with RFC822 body', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      status: 200,
      body: { id: 'draft-1', message: { id: 'm-1', threadId: 't1' } },
    },
  ]);
  const result = await gmailCreateDraft({
    fetch,
    accessToken: 'tok',
    threadId: 't1',
    to: 'recipient@x.com',
    subject: 'Re: Faktura',
    bodyText: 'Tak for fakturaen.',
    inReplyToMessageId: 'm-orig',
  });
  assertEquals(result.draftId, 'draft-1');
  assertEquals(result.messageId, 'm-1');
  assertEquals(result.reverseToken, {
    kind: 'gmail.draft',
    draft_id: 'draft-1',
  });
  assertEquals(calls.length, 1);
  const sent = JSON.parse(calls[0].body!);
  assertEquals(sent.message.threadId, 't1');
  // raw is base64url-encoded RFC822
  assertEquals(typeof sent.message.raw, 'string');
});

Deno.test('gmailSendDraft: POSTs to drafts/send and returns sent message id', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send',
      status: 200,
      body: { id: 'm-sent', threadId: 't1' },
    },
  ]);
  const result = await gmailSendDraft({
    fetch,
    accessToken: 'tok',
    draftId: 'draft-1',
  });
  assertEquals(result.messageId, 'm-sent');
  assertEquals(calls.length, 1);
  assertEquals(JSON.parse(calls[0].body!), { id: 'draft-1' });
});

Deno.test('gmailDeleteDraft: DELETEs the draft', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1',
      status: 204,
      body: {},
    },
  ]);
  await gmailDeleteDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls[0].method, 'DELETE');
});

Deno.test('gmailCreateDraft: 4xx surfaces error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      status: 403,
      body: { error: { message: 'insufficient scope' } },
    },
  ]);
  await assertRejects(
    () =>
      gmailCreateDraft({
        fetch,
        accessToken: 'tok',
        threadId: 't1',
        to: 'r@x.com',
        subject: 'S',
        bodyText: 'B',
        inReplyToMessageId: 'm',
      }),
    Error,
    'gmail drafts.create 403',
  );
});
```

- [ ] **Step 2: Run and fail**

Run: `deno test supabase/functions/_shared/agent/tools/gmail.test.ts --allow-env --allow-net`
Expected: 4 new tests FAIL with `gmailCreateDraft is not a function` (or similar).

- [ ] **Step 3: Extend `gmail.ts`**

APPEND to `supabase/functions/_shared/agent/tools/gmail.ts` (do NOT modify the existing `gmailModifyThread` / `resolveLabelId`):

```ts
export interface GmailDraftReverseToken {
  kind: 'gmail.draft';
  draft_id: string;
}

export interface CreateDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId: string;
}

export interface CreateDraftResult {
  draftId: string;
  messageId: string;
  reverseToken: GmailDraftReverseToken;
}

// Build a minimal RFC822 message and base64url-encode it for the Gmail API.
function buildRfc822(input: CreateDraftInput): string {
  const lines = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `In-Reply-To: ${input.inReplyToMessageId}`,
    `References: ${input.inReplyToMessageId}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.bodyText,
  ];
  const raw = lines.join('\r\n');
  // base64url-encode (Gmail requires url-safe alphabet, no padding)
  const b64 = btoa(unescape(encodeURIComponent(raw)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailCreateDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
  const raw = buildRfc822(input);
  const res = await input.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: { threadId: input.threadId, raw } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id: string; message: { id: string } };
  return {
    draftId: j.id,
    messageId: j.message.id,
    reverseToken: { kind: 'gmail.draft', draft_id: j.id },
  };
}

export interface SendDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  draftId: string;
}

export interface SendDraftResult {
  messageId: string;
}

export async function gmailSendDraft(input: SendDraftInput): Promise<SendDraftResult> {
  const res = await input.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: input.draftId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.send ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id: string };
  return { messageId: j.id };
}

export interface DeleteDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  draftId: string;
}

export async function gmailDeleteDraft(input: DeleteDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${input.draftId}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 204) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Pass**

Run: `deno test supabase/functions/_shared/agent/tools/gmail.test.ts --allow-env --allow-net`
Expected: 9 tests passing (5 from Phase 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/gmail.ts supabase/functions/_shared/agent/tools/gmail.test.ts
git commit -m "feat(agent): gmail drafts.create/send/delete with reverse token"
```

---

## Task 5: Outlook draft + send tools

**Files:**
- Create: `supabase/functions/_shared/agent/tools/outlook.ts`
- Create: `supabase/functions/_shared/agent/tools/outlook.test.ts`

TDD.

- [ ] **Step 1: Write failing tests**

Create `supabase/functions/_shared/agent/tools/outlook.test.ts`:

```ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  outlookCreateDraft,
  outlookSendDraft,
  outlookDeleteDraft,
  type OutlookFetch,
} from './outlook.ts';

function makeFetch(
  responses: Array<{ url: string; status: number; body: unknown }>,
): { fetch: OutlookFetch; calls: Array<{ url: string; method: string; body: string | null }> } {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const r = responses[i++];
      if (r.url !== url) {
        throw new Error(`unexpected url at step ${i}: got ${url}, want ${r.url}`);
      }
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  };
}

Deno.test('outlookCreateDraft: creates a reply draft via /me/messages/{id}/createReply', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-orig/createReply',
      status: 201,
      body: { id: 'draft-1', conversationId: 't1' },
    },
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1',
      status: 200,
      body: { id: 'draft-1' },
    },
  ]);
  const result = await outlookCreateDraft({
    fetch,
    accessToken: 'tok',
    inReplyToMessageId: 'm-orig',
    bodyText: 'Tak for invitationen.',
  });
  assertEquals(result.draftId, 'draft-1');
  assertEquals(result.reverseToken, { kind: 'graph.draft', draft_id: 'draft-1' });
  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[1].method, 'PATCH');
  const patch = JSON.parse(calls[1].body!);
  assertEquals(patch.body.contentType, 'Text');
  assertEquals(patch.body.content, 'Tak for invitationen.');
});

Deno.test('outlookSendDraft: POSTs /me/messages/{id}/send', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1/send',
      status: 202,
      body: {},
    },
  ]);
  await outlookSendDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, 'POST');
});

Deno.test('outlookDeleteDraft: DELETEs the draft message', async () => {
  const { fetch, calls } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/draft-1',
      status: 204,
      body: {},
    },
  ]);
  await outlookDeleteDraft({ fetch, accessToken: 'tok', draftId: 'draft-1' });
  assertEquals(calls[0].method, 'DELETE');
});

Deno.test('outlookCreateDraft: 4xx surfaces error', async () => {
  const { fetch } = makeFetch([
    {
      url: 'https://graph.microsoft.com/v1.0/me/messages/m-orig/createReply',
      status: 403,
      body: { error: { message: 'insufficient_scope' } },
    },
  ]);
  await assertRejects(
    () =>
      outlookCreateDraft({
        fetch,
        accessToken: 'tok',
        inReplyToMessageId: 'm-orig',
        bodyText: 'b',
      }),
    Error,
    'graph createReply 403',
  );
});
```

- [ ] **Step 2: Run and fail**

Run: `deno test supabase/functions/_shared/agent/tools/outlook.test.ts --allow-env --allow-net`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/agent/tools/outlook.ts`:

```ts
// supabase/functions/_shared/agent/tools/outlook.ts
//
// Microsoft Graph write operations used by phase-3 mail-draft/send tools.
// The `fetch` parameter is injectable so unit tests can stub the network
// without monkey-patching globalThis.

export type OutlookFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface OutlookDraftReverseToken {
  kind: 'graph.draft';
  draft_id: string;
}

export interface OutlookCreateDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  inReplyToMessageId: string;
  bodyText: string;
}

export interface OutlookCreateDraftResult {
  draftId: string;
  reverseToken: OutlookDraftReverseToken;
}

export async function outlookCreateDraft(
  input: OutlookCreateDraftInput,
): Promise<OutlookCreateDraftResult> {
  // Step 1: createReply pre-fills To/Subject and threads the message.
  const replyRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.inReplyToMessageId}/createReply`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!replyRes.ok) {
    const detail = await replyRes.text().catch(() => '');
    throw new Error(`graph createReply ${replyRes.status}: ${detail.slice(0, 200)}`);
  }
  const draft = (await replyRes.json()) as { id: string };

  // Step 2: PATCH the body with the agent-written content.
  const patchRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${draft.id}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        body: { contentType: 'Text', content: input.bodyText },
      }),
    },
  );
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`graph messages.patch ${patchRes.status}: ${detail.slice(0, 200)}`);
  }
  return {
    draftId: draft.id,
    reverseToken: { kind: 'graph.draft', draft_id: draft.id },
  };
}

export interface OutlookSendDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  draftId: string;
}

export async function outlookSendDraft(input: OutlookSendDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.draftId}/send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 202) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.send ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export interface OutlookDeleteDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  draftId: string;
}

export async function outlookDeleteDraft(input: OutlookDeleteDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.draftId}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 204) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Pass**

Run: `deno test supabase/functions/_shared/agent/tools/outlook.test.ts --allow-env --allow-net`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/tools/outlook.ts supabase/functions/_shared/agent/tools/outlook.test.ts
git commit -m "feat(agent): outlook draft create/send/delete via microsoft graph"
```

---

## Task 6: Extend dispatcher for drafts, send-proposals, provider routing

**Files:**
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts`
- Modify: `supabase/functions/_shared/agent/tools/dispatch.test.ts`

The dispatcher now routes by `payload.provider` and emits a new `mode: 'propose'` outcome for `mail.send_reply`. Outlook triage actions are explicitly rejected.

- [ ] **Step 1: Append failing tests**

Append to `supabase/functions/_shared/agent/tools/dispatch.test.ts`:

```ts
Deno.test('executeTool: mail.draft_reply with provider=google calls gmail draft', async () => {
  let captured: string | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = url;
      return new Response(
        JSON.stringify({ id: 'draft-1', message: { id: 'm-1', threadId: 't1' } }),
        { status: 200 },
      );
    },
  });
  const result = await executeTool(
    'mail.draft_reply',
    {
      provider: 'google',
      thread_id: 't1',
      in_reply_to_message_id: 'm-orig',
      to: 'r@x.com',
      subject: 'Re: Faktura',
      body: 'Tak.',
    },
    ctx,
  );
  assertEquals(captured!.endsWith('/users/me/drafts'), true);
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(result.reverseToken?.kind, 'gmail.draft');
  assertEquals(result.recordPayload.draft_id, 'draft-1');
  assertEquals(result.recordPayload.draft_hash, undefined); // dispatcher does NOT compute draft_hash
});

Deno.test('executeTool: mail.draft_reply with provider=microsoft hits graph createReply', async () => {
  let urls: string[] = [];
  const ctx = makeCtx({
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.draft_reply',
    {
      provider: 'microsoft',
      thread_id: 't1',
      in_reply_to_message_id: 'm-orig',
      to: 'r@x.com',
      subject: 'Re: Hej',
      body: 'Tak.',
    },
    ctx,
  );
  assertEquals(urls[0].includes('createReply'), true);
  assertEquals(result.reverseToken?.kind, 'graph.draft');
});

Deno.test('executeTool: mail.send_reply returns mode=propose without calling provider', async () => {
  let fetchCalls = 0;
  const ctx = makeCtx({
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't1',
      draft_id: 'draft-1',
      draft_hash: 'sha1-abc',
      preview_text: 'Tak for invitationen.',
    },
    ctx,
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.mode, 'propose');
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.draft_id, 'draft-1');
  assertEquals(result.recordPayload.draft_hash, 'sha1-abc');
  assertEquals(result.recordPayload.preview_text, 'Tak for invitationen.');
});

Deno.test('executeTool: mail.archive with provider=microsoft is rejected (phase 3 scope)', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () => executeTool('mail.archive', { provider: 'microsoft', thread_id: 't1' }, ctx),
    Error,
    'outlook triage',
  );
});
```

Also, IMPORTANT: the existing Phase 2 tests assert `result.reversible` etc. directly. Update them to also assert `result.mode === 'executed'` (introduce the `mode` field). Replace the 4 existing Phase 2 tests so each asserts `assertEquals(result.mode, 'executed')`. Keep the rest of their assertions unchanged.

- [ ] **Step 2: Run and fail**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts --allow-env --allow-net`
Expected: All 4 new tests fail; the 4 existing tests fail their new `mode === 'executed'` assertion.

- [ ] **Step 3: Update `dispatch.ts`**

Replace the file `supabase/functions/_shared/agent/tools/dispatch.ts`:

```ts
// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionType } from '../types.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  gmailCreateDraft,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
  type GmailModifyReverseToken,
  type GmailDraftReverseToken,
} from './gmail.ts';
import {
  outlookCreateDraft,
  type OutlookFetch,
  type OutlookDraftReverseToken,
} from './outlook.ts';

export interface ExecuteContext {
  fetch: GmailFetch & OutlookFetch;
  gmail: { accessToken: string; resolveLabelId: (name: string) => Promise<string> };
  // Outlook is optional — only loaded if the user has a microsoft watcher.
  outlook?: { accessToken: string };
}

export type ExecuteReverseToken =
  | GmailModifyReverseToken
  | GmailDraftReverseToken
  | OutlookDraftReverseToken
  | null;

export type ExecuteMode = 'executed' | 'propose';

export interface ExecuteResult {
  mode: ExecuteMode;
  reversible: boolean;
  reverseToken: ExecuteReverseToken;
  recordPayload: Record<string, unknown>;
}

const OUTLOOK_REJECTED_TRIAGE: ReadonlySet<ActionType> = new Set([
  'mail.label',
  'mail.archive',
  'mail.flag_important',
]);

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const provider = mustProvider(payload);

  // Outlook triage is not supported in Phase 3 — surface a clear error.
  if (provider === 'microsoft' && OUTLOOK_REJECTED_TRIAGE.has(action)) {
    throw new Error(`outlook triage not supported in phase 3 (${action})`);
  }

  switch (action) {
    case 'mail.archive': {
      const threadId = mustString(payload, 'thread_id');
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
    case 'mail.label': {
      const threadId = mustString(payload, 'thread_id');
      const label = mustString(payload, 'label');
      const op = mustString(payload, 'op');
      if (op !== 'add' && op !== 'remove') {
        throw new Error(`mail.label op must be add|remove, got ${op}`);
      }
      const labelId = await ctx.gmail.resolveLabelId(label);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.gmail.accessToken,
        threadId,
        addLabelIds: op === 'add' ? [labelId] : [],
        removeLabelIds: op === 'remove' ? [labelId] : [],
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken,
        recordPayload: { provider, thread_id: threadId, label, op },
      };
    }
    case 'mail.flag_important': {
      const threadId = mustString(payload, 'thread_id');
      const labelId = await ctx.gmail.resolveLabelId(ZOLVA_FLAGGED_LABEL);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.gmail.accessToken,
        threadId,
        addLabelIds: [labelId],
        removeLabelIds: [],
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken,
        recordPayload: { provider, thread_id: threadId },
      };
    }
    case 'mail.summarize': {
      const threadId = mustString(payload, 'thread_id');
      const summary = mustString(payload, 'summary');
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: { provider, thread_id: threadId, summary },
      };
    }
    case 'mail.draft_reply': {
      const threadId = mustString(payload, 'thread_id');
      const inReplyTo = mustString(payload, 'in_reply_to_message_id');
      const bodyText = mustString(payload, 'body');
      if (provider === 'google') {
        const to = mustString(payload, 'to');
        const subject = mustString(payload, 'subject');
        const out = await gmailCreateDraft({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
          to,
          subject,
          bodyText,
          inReplyToMessageId: inReplyTo,
        });
        return {
          mode: 'executed',
          reversible: true,
          reverseToken: out.reverseToken,
          recordPayload: {
            provider,
            thread_id: threadId,
            draft_id: out.draftId,
            message_id: out.messageId,
            body_preview: bodyText.slice(0, 200),
          },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook draft requested but outlook context missing');
      }
      const out = await outlookCreateDraft({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        inReplyToMessageId: inReplyTo,
        bodyText,
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken: out.reverseToken,
        recordPayload: {
          provider,
          thread_id: threadId,
          draft_id: out.draftId,
          body_preview: bodyText.slice(0, 200),
        },
      };
    }
    case 'mail.send_reply': {
      // Proposal path: dispatcher does NOT execute the send. Runner writes
      // a proposed_actions row with this payload; agent-approve executes
      // later when the user taps Send.
      const threadId = mustString(payload, 'thread_id');
      const draftId = mustString(payload, 'draft_id');
      const draftHash = mustString(payload, 'draft_hash');
      const previewText = mustString(payload, 'preview_text');
      return {
        mode: 'propose',
        reversible: false,
        reverseToken: null,
        recordPayload: {
          provider,
          thread_id: threadId,
          draft_id: draftId,
          draft_hash: draftHash,
          preview_text: previewText,
        },
      };
    }
    default:
      throw new Error(`executeTool: unsupported action type ${action}`);
  }
}

function mustString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`tool payload missing required string field ${key}`);
  }
  return v;
}

function mustProvider(payload: Record<string, unknown>): 'google' | 'microsoft' {
  const v = payload.provider;
  if (v === 'google' || v === 'microsoft') return v;
  throw new Error(`tool payload missing or invalid provider (got ${String(v)})`);
}
```

- [ ] **Step 4: Update old test assertions**

In the existing Phase 2 dispatch tests, add `provider: 'google'` to each payload (now required) and assert `result.mode === 'executed'`. For example, the `mail.archive` test's payload becomes `{ provider: 'google', thread_id: 't1' }` and a new line `assertEquals(result.mode, 'executed')` is added.

- [ ] **Step 5: Pass**

Run: `deno test supabase/functions/_shared/agent/tools/dispatch.test.ts --allow-env --allow-net`
Expected: 8 tests passing (4 existing-but-updated + 4 new).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/agent/tools/dispatch.ts supabase/functions/_shared/agent/tools/dispatch.test.ts
git commit -m "feat(agent): dispatcher routes by provider + propose mode for send_reply"
```

---

## Task 7: Extend prompt + tool catalog with draft/send

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts`
- Modify: `supabase/functions/_shared/agent/prompt.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `supabase/functions/_shared/agent/prompt.test.ts`:

```ts
Deno.test('MAIL_TRIAGE_TOOLS exposes six tools after phase 3', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name).sort();
  assertEquals(names, [
    'mail.archive',
    'mail.draft_reply',
    'mail.flag_important',
    'mail.label',
    'mail.send_reply',
    'mail.summarize',
  ]);
});

Deno.test('buildMailTriagePrompt: system prompt mentions outlook scope and conservative drafting', () => {
  const { system } = buildMailTriagePrompt({ threads: [] });
  const txt = system[0].text.toLowerCase();
  // We just check anchors; full prose lives in prompt.ts.
  assertEquals(txt.includes('outlook'), true);
  assertEquals(txt.includes('draft'), true);
});
```

Also: update the existing "exposes exactly four mail actions" test — rename it to "exposes six mail actions" with the new array (the original test will now fail because we add two tools).

- [ ] **Step 2: Run and fail**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts --allow-env --allow-net`
Expected: tests fail because `MAIL_TRIAGE_TOOLS` is still length 4 and the system prompt has no Outlook text.

- [ ] **Step 3: Extend `prompt.ts`**

In `supabase/functions/_shared/agent/prompt.ts`, APPEND to the `MAIL_TRIAGE_TOOLS` array (before the closing `]`):

```ts
  {
    name: 'mail.draft_reply',
    description:
      'Create a draft reply (visible in the user\'s Drafts folder, NOT sent). Use only for direct messages from a human where a reply is clearly expected — never for newsletters, automated mail, or threads where you cannot tell what to say. Keep replies short and conservative; the user will edit before sending. Both providers supported.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        in_reply_to_message_id: { type: 'string' },
        to: { type: 'string', description: 'recipient address (Gmail only; Outlook draft is pre-filled by createReply)' },
        subject: { type: 'string', description: 'Gmail only' },
        body: { type: 'string', description: 'Danish, ≤ 600 chars' },
      },
      required: ['thread_id', 'in_reply_to_message_id', 'body'],
    },
  },
  {
    name: 'mail.send_reply',
    description:
      'Propose to send the draft you just created. Always requires user approval — this writes a pending proposal, not an actual send. Use right after mail.draft_reply for the same thread when the reply is unambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        draft_id: { type: 'string', description: 'returned by mail.draft_reply (or known existing draft)' },
        draft_hash: { type: 'string', description: 'sha1 of the body — used for idempotency' },
        preview_text: { type: 'string', description: 'one-line preview for the proposal card, ≤ 120 chars' },
      },
      required: ['thread_id', 'draft_id', 'draft_hash', 'preview_text'],
    },
  },
```

And REPLACE the `SYSTEM_PROMPT` constant:

```ts
const SYSTEM_PROMPT = `Du er Zolva — en personlig assistent der triage'r brugerens indbakke i baggrunden. Du kan udføre handlinger på både Gmail og Outlook (Microsoft).

Tilladte handlinger:
1. arkivere åbenlyst færdige tråde (kvitteringer, nyhedsbreve, automatiserede beskeder) — KUN Gmail. Spring over for Outlook-tråde.
2. tilføje en kort kategori-label — KUN Gmail. Spring over for Outlook-tråde.
3. markere en tråd som vigtig — KUN Gmail. Spring over for Outlook-tråde.
4. skrive en kort dansk opsummering (max 200 tegn) hvis emnet alene ikke siger hvad brugeren skal gøre.
5. udkast et reply (mail.draft_reply) — KUN når afsenderen er et menneske (ikke noreply@/notifications@/etc.), brevet stiller et tydeligt spørgsmål eller forventer et svar, og du kan skrive et kort dansk svar uden at gætte. Hold dig forsigtig; brugeren retter inden afsendelse.
6. foreslå at sende udkastet (mail.send_reply) umiddelbart efter mail.draft_reply, hvis svaret er entydigt. Send kræver altid brugerens godkendelse.

Regler:
- Brug kun thread_id'er fra listen i brugerens besked. Opfind ALDRIG ID'er.
- Hver tråd har en provider ('google' eller 'microsoft'). Du SKAL inkludere provider i payload til alle handlinger.
- For Outlook-tråde: kun mail.summarize, mail.draft_reply og mail.send_reply er tilgængelige. Forsøg ikke at arkivere/labelle/flagge Outlook-tråde — disse handlinger vil fejle.
- Vær konservativ: hvis du er i tvivl, gør ingenting.
- Du kan kalde flere værktøjer i samme tur. Stop når listen er triageret.
- Svar på dansk i den korte tekstkommentar efter værktøjskald.`;
```

- [ ] **Step 4: Pass**

Run: `deno test supabase/functions/_shared/agent/prompt.test.ts --allow-env --allow-net`
Expected: 4 tests passing (3 originals updated + new tool-catalog + Outlook anchor test).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/prompt.ts supabase/functions/_shared/agent/prompt.test.ts
git commit -m "feat(agent): prompt catalog adds draft_reply + send_reply, outlook scope notes"
```

---

## Task 8: Pure push-eligibility helper

**Files:**
- Create: `supabase/functions/_shared/agent/push.ts`
- Create: `supabase/functions/_shared/agent/push.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// supabase/functions/_shared/agent/push.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { shouldPushForProposal } from './push.ts';

const NOW = new Date('2026-05-13T10:00:00Z');

Deno.test('shouldPushForProposal: true when last_active_at is null (never pinged)', () => {
  assertEquals(shouldPushForProposal(null, NOW), true);
});

Deno.test('shouldPushForProposal: true when idle >= 60s', () => {
  const sixtyOneSecondsAgo = new Date(NOW.getTime() - 61_000);
  assertEquals(shouldPushForProposal(sixtyOneSecondsAgo, NOW), true);
});

Deno.test('shouldPushForProposal: false when user is foreground (< 60s)', () => {
  const tenSecondsAgo = new Date(NOW.getTime() - 10_000);
  assertEquals(shouldPushForProposal(tenSecondsAgo, NOW), false);
});

Deno.test('shouldPushForProposal: false at exactly 30s (boundary)', () => {
  const thirty = new Date(NOW.getTime() - 30_000);
  assertEquals(shouldPushForProposal(thirty, NOW), false);
});
```

- [ ] **Step 2: Run, fail, implement**

Create `supabase/functions/_shared/agent/push.ts`:

```ts
// supabase/functions/_shared/agent/push.ts
//
// Pure helper: "is the user idle enough to push a notification?"
// Spec §6.3: push only when proposed_actions is written AND
// userIsForeground = false. We use last_active_at > 60s ago as the
// foreground proxy.

const IDLE_THRESHOLD_MS = 60 * 1000;

export function shouldPushForProposal(
  lastActiveAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (lastActiveAt === null) return true;
  return now.getTime() - lastActiveAt.getTime() > IDLE_THRESHOLD_MS;
}
```

- [ ] **Step 3: Pass**

Run: `deno test supabase/functions/_shared/agent/push.test.ts --allow-env --allow-net`
Expected: 4 tests passing.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/agent/push.ts supabase/functions/_shared/agent/push.test.ts
git commit -m "feat(agent): pure shouldPushForProposal eligibility helper"
```

---

## Task 9: Expo Push API caller

**Files:**
- Create: `supabase/functions/_shared/agent/expo-push.ts`
- Create: `supabase/functions/_shared/agent/expo-push.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// supabase/functions/_shared/agent/expo-push.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { dispatchExpoPush, type PushFetch } from './expo-push.ts';

function makeFetch(): { fetch: PushFetch; last: { url: string; body: string } } {
  const last = { url: '', body: '' };
  return {
    last,
    fetch: async (url, init) => {
      last.url = url;
      last.body = String(init?.body ?? '');
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
    },
  };
}

Deno.test('dispatchExpoPush: posts one message per token to expo push api', async () => {
  const { fetch, last } = makeFetch();
  await dispatchExpoPush({
    fetch,
    tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
    title: 'Zolva',
    body: 'Et udkast venter',
    data: { type: 'agent_proposal', action_id: 'p-1' },
  });
  assertEquals(last.url, 'https://exp.host/--/api/v2/push/send');
  const sent = JSON.parse(last.body) as Array<Record<string, unknown>>;
  assertEquals(sent.length, 2);
  assertEquals(sent[0].to, 'ExponentPushToken[a]');
  assertEquals(sent[0].title, 'Zolva');
  assertEquals(sent[0].data, { type: 'agent_proposal', action_id: 'p-1' });
});

Deno.test('dispatchExpoPush: empty token list is a noop', async () => {
  let calls = 0;
  const fetch: PushFetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  await dispatchExpoPush({
    fetch,
    tokens: [],
    title: 'Zolva',
    body: 'B',
    data: {},
  });
  assertEquals(calls, 0);
});
```

- [ ] **Step 2: Run, fail, implement**

Create `supabase/functions/_shared/agent/expo-push.ts`:

```ts
// supabase/functions/_shared/agent/expo-push.ts
//
// Expo Push API caller for agent proposals. Mirrors the pattern from
// reminders-fire (one message per token, single batched POST). Failures
// are swallowed by the caller; we don't retry pushes.

export type PushFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface DispatchExpoPushInput {
  fetch: PushFetch;
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export async function dispatchExpoPush(input: DispatchExpoPushInput): Promise<void> {
  if (input.tokens.length === 0) return;
  const messages = input.tokens.map((token) => ({
    to: token,
    title: input.title,
    body: input.body,
    sound: 'default',
    data: input.data,
  }));
  await input.fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messages),
  });
}
```

- [ ] **Step 3: Pass**

Run: `deno test supabase/functions/_shared/agent/expo-push.test.ts --allow-env --allow-net`
Expected: 2 tests passing.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/agent/expo-push.ts supabase/functions/_shared/agent/expo-push.test.ts
git commit -m "feat(agent): expo push api caller for agent proposals"
```

---

## Task 10: Runner — policy resolution + propose path + push trigger

**Files:**
- Modify: `supabase/functions/_shared/agent/runner.ts`
- Modify: `supabase/functions/_shared/agent/runner.test.ts`

The runner gains policy resolution, a propose branch that writes to `proposed_actions`, and a push dispatch when the user is idle.

- [ ] **Step 1: Append failing tests**

Append to `supabase/functions/_shared/agent/runner.test.ts`:

```ts
Deno.test('runAgent: propose path writes proposed_action and dispatches push when idle', async () => {
  let proposedRow: Record<string, unknown> | null = null;
  let pushDispatched = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.send_reply', mode: 'propose' },
  ];
  deps.loadUserPresence = async () => null; // never pinged → idle
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail.send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload) => ({
    mode: 'propose',
    reversible: false,
    reverseToken: null,
    recordPayload: { ...payload },
  });
  deps.writeProposedAction = async (row) => {
    proposedRow = row;
    return 'p-1';
  };
  deps.dispatchProposalPush = async () => {
    pushDispatched = true;
  };

  const result = await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(result.status, 'ok');
  assertEquals(proposedRow?.action_type, 'mail.send_reply');
  assertEquals(pushDispatched, true);
});

Deno.test('runAgent: propose path skips push when user is foreground (<60s idle)', async () => {
  let pushDispatched = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [];
  deps.loadUserPresence = async () => new Date(); // just now → foreground
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail.send_reply',
        input: {
          provider: 'google',
          thread_id: 't1',
          draft_id: 'draft-1',
          draft_hash: 'sha1-abc',
          preview_text: 'Tak.',
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async (_action, payload) => ({
    mode: 'propose',
    reversible: false,
    reverseToken: null,
    recordPayload: { ...payload },
  });
  deps.writeProposedAction = async () => 'p-1';
  deps.dispatchProposalPush = async () => { pushDispatched = true; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(pushDispatched, false);
});

Deno.test('runAgent: policy off causes the tool to be rejected without execution', async () => {
  let executed = false;
  let proposed = false;
  const { deps } = makeDeps();
  deps.claimEvents = async () => [
    { id: 1, kind: 'mail.new', payload: { thread_id: 't1', message_id: 'm1', provider: 'google' } },
  ];
  deps.loadThreadBriefs = async () => [
    { thread_id: 't1', from: 'a@x', subject: 'Hi', snippet: '' },
  ];
  deps.loadUserPolicy = async () => [
    { user_id: 'u-1', action_type: 'mail.archive', mode: 'off' },
  ];
  deps.callClaudeTurn = async () => ({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'mail.archive',
        input: { provider: 'google', thread_id: 't1' },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  deps.executeTool = async () => {
    executed = true;
    return { mode: 'executed', reversible: false, reverseToken: null, recordPayload: {} };
  };
  deps.writeProposedAction = async () => { proposed = true; return 'p'; };

  await runAgent({ userId: 'u-1', trigger: 'tick', deps });
  assertEquals(executed, false);
  assertEquals(proposed, false);
});
```

And UPDATE `makeDeps` with the new no-op deps:

```ts
      // Phase 3 additions
      loadUserPolicy: async () => [],
      loadUserPresence: async () => null,
      writeProposedAction: async () => 'p-stub',
      dispatchProposalPush: async () => {},
```

- [ ] **Step 2: Fail**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts --allow-env --allow-net`
Expected: the 3 new tests fail; existing tests may also fail due to `ExecuteResult.mode` field.

- [ ] **Step 3: Update `runner.ts`**

Modify `supabase/functions/_shared/agent/runner.ts`:

A. Extend `RunnerDeps` with the four new methods:

```ts
  // Phase 3 deps
  loadUserPolicy: (userId: string) => Promise<Array<{ user_id: string; action_type: string; mode: 'auto' | 'propose' | 'off' }>>;
  loadUserPresence: (userId: string) => Promise<Date | null>;
  writeProposedAction: (row: {
    user_id: string;
    run_id: string;
    action_type: ActionType;
    payload: Record<string, unknown>;
    preview: Record<string, unknown>;
    expires_at: string;
  }) => Promise<string>;
  dispatchProposalPush: (
    userId: string,
    preview: { title: string; body: string; actionId: string },
  ) => Promise<void>;
```

B. Update `executeTool`'s signature in `RunnerDeps`:

```ts
  executeTool: (
    action: ActionType,
    payload: Record<string, unknown>,
  ) => Promise<{
    mode: 'executed' | 'propose';
    reversible: boolean;
    reverseToken: ExecuteReverseToken;
    recordPayload: Record<string, unknown>;
  }>;
```

C. Add policy resolution + propose branch INSIDE the per-tool inner block. Modify the existing per-tool path so it looks like:

```ts
        // Phase 3: resolve policy. mode='off' rejects.
        // mode='propose' on a currently-auto action (e.g. mail.archive) is
        //   NOT honored as deferred-execute in Phase 3 — the runner still
        //   executes and we treat it as auto. Phase 3.1 will wire deferred
        //   execution via agent-approve dispatching any action. Until then,
        //   the policy slot exists in the UI but only `off` actually blocks
        //   currently-auto actions. For mail.send_reply, dispatcher returns
        //   mode='propose' intrinsically (no provider call), which IS honored.
        const policy = resolvePolicy(action, userPolicy);
        if (policy === 'off') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: `policy_off: user disabled ${action}`,
          });
          continue;
        }

        try {
          const exec = await deps.executeTool(action, input);
          if (exec.mode === 'propose') {
            const idemKey = deriveIdemKey(action, exec.recordPayload);
            const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
            const proposalId = await deps.writeProposedAction({
              user_id: userId,
              run_id: runId,
              action_type: action,
              payload: { ...exec.recordPayload, idem_key: idemKey },
              preview: buildProposalPreview(action, exec.recordPayload),
              expires_at: expiresAt,
            });
            // Push notification gated on idle check.
            const presence = await deps.loadUserPresence(userId);
            if (shouldPushForProposal(presence, new Date())) {
              const preview = buildProposalPreview(action, exec.recordPayload);
              await deps.dispatchProposalPush(userId, {
                title: typeof preview.title === 'string' ? preview.title : 'Zolva',
                body: typeof preview.body === 'string' ? preview.body : 'Et udkast venter',
                actionId: proposalId,
              });
            }
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: `proposed:${proposalId}`,
            });
            continue;
          }
          // Phase 2 execute path (unchanged below this point):
          const idemKey = deriveIdemKey(action, exec.recordPayload);
          const payloadWithKey = { ...exec.recordPayload, idem_key: idemKey };
          await deps.recordAction({
            user_id: userId,
            run_id: runId,
            action_type: action,
            payload: payloadWithKey,
            reversible: exec.reversible,
            reverse_token: exec.reverseToken,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'ok',
          });
        } catch (e) {
          // unchanged
        }
```

Also: BEFORE the tool loop, load `userPolicy` once via `await deps.loadUserPolicy(userId)`. Pass it into the per-tool branch.

D. Add helper at the bottom of `runner.ts`:

```ts
import { resolvePolicy } from './policy.ts';
import { shouldPushForProposal } from './push.ts';

function buildProposalPreview(
  action: ActionType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const previewText = typeof payload.preview_text === 'string' ? payload.preview_text : '';
  switch (action) {
    case 'mail.send_reply':
      return {
        title: 'Send svar?',
        body: previewText || 'Zolva har udkastet et svar — godkend for at sende.',
        thread_id: payload.thread_id,
        draft_id: payload.draft_id,
      };
    default:
      return { title: 'Zolva foreslår', body: previewText || `${action}` };
  }
}
```

E. Extend `PHASE_2_ACTIONS` to include the two new draft/send action types — rename to `SUPPORTED_ACTIONS`:

```ts
const SUPPORTED_ACTIONS = new Set<ActionType>([
  'mail.label',
  'mail.archive',
  'mail.flag_important',
  'mail.summarize',
  'mail.draft_reply',
  'mail.send_reply',
]);
```

Use `SUPPORTED_ACTIONS.has(action)` instead of `PHASE_2_ACTIONS.has(action)` in the gate.

- [ ] **Step 4: Pass**

Run: `deno test supabase/functions/_shared/agent/runner.test.ts --allow-env --allow-net`
Expected: 8 tests passing (5 existing updated to set `mode: 'executed'` in executeTool stubs + 3 new).

You may need to add `mode: 'executed'` to the executeTool returns in the EXISTING Phase 2 tests — do that as part of this task (it's the contract change from Task 6 propagating up).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/agent/runner.ts supabase/functions/_shared/agent/runner.test.ts
git commit -m "feat(agent): runner policy resolution + propose path + push trigger"
```

---

## Task 11: agent-tick wires the new deps

**Files:**
- Modify: `supabase/functions/agent-tick/index.ts`

The function already builds `RunnerDeps`. We add `loadOutlookAccessToken`, `loadUserPolicy`, `loadUserPresence`, `writeProposedAction`, `dispatchProposalPush`, and update `executeTool` to provide both Gmail and (optional) Outlook contexts.

- [ ] **Step 1: Add new helpers + extend buildDeps**

In `supabase/functions/agent-tick/index.ts`:

1. Add imports near the top:

```ts
import { dispatchExpoPush } from '../_shared/agent/expo-push.ts';
import type { ExecuteContext } from '../_shared/agent/tools/dispatch.ts';
```

2. Add the new helper (above `buildDeps`):

```ts
async function loadOutlookAccessToken(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const refresh = await loadRefreshToken(client, userId, 'microsoft');
  if (!refresh) return null;
  const { accessToken } = await refreshAccessToken(client, userId, 'microsoft', refresh);
  return accessToken;
}

async function loadPushTokens(
  client: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (error) {
    console.warn('[agent-tick] push_tokens read failed:', error.message);
    return [];
  }
  return (data ?? []).map((r: { token: string }) => r.token);
}
```

3. In `buildDeps`, extend the closure: in addition to `cachedAccessToken`, add `cachedOutlookToken: string | null = null` and an `outlookToken` async resolver.

4. Add the new deps to the returned object:

```ts
    async loadUserPolicy(uid) {
      const { data, error } = await client
        .from('user_agent_policy')
        .select('user_id, action_type, mode')
        .eq('user_id', uid);
      if (error) throw error;
      return (data ?? []) as Array<{ user_id: string; action_type: string; mode: 'auto' | 'propose' | 'off' }>;
    },
    async loadUserPresence(uid) {
      const { data, error } = await client
        .from('user_presence')
        .select('last_active_at')
        .eq('user_id', uid)
        .maybeSingle();
      if (error) {
        console.warn('[agent-tick] presence read failed:', error.message);
        return null;
      }
      if (!data?.last_active_at) return null;
      return new Date(data.last_active_at as string);
    },
    async writeProposedAction(row) {
      const { data, error } = await client
        .from('proposed_actions')
        .insert({
          user_id: row.user_id,
          run_id: row.run_id,
          action_type: row.action_type,
          payload: row.payload,
          preview: row.preview,
          status: 'pending',
          expires_at: row.expires_at,
        })
        .select('id').single();
      if (error) throw error;
      return data!.id as string;
    },
    async dispatchProposalPush(uid, preview) {
      const tokens = await loadPushTokens(client, uid);
      await dispatchExpoPush({
        fetch: fetch as never,
        tokens,
        title: preview.title,
        body: preview.body,
        data: { type: 'agent_proposal', action_id: preview.actionId },
      });
    },
```

5. Update `executeTool` in the deps:

```ts
    async executeTool(action: ActionType, payload) {
      const gmailTok = await accessToken(); // existing helper
      const outlookTok = await outlookToken(); // new helper
      const ctx: ExecuteContext = {
        fetch: fetch as never,
        gmail: {
          accessToken: gmailTok,
          resolveLabelId: (name) =>
            resolveLabelId({ fetch: fetch as never, accessToken: gmailTok, name }),
        },
        outlook: outlookTok ? { accessToken: outlookTok } : undefined,
      };
      return dispatchTool(action, payload, ctx);
    },
```

- [ ] **Step 2: Type-check**

Run: `deno check supabase/functions/agent-tick/index.ts`
Expected: no output.

- [ ] **Step 3: Run the existing agent-tick test**

Run: `deno test supabase/functions/agent-tick/index.test.ts --allow-env --allow-net`
Expected: 1 test still passes.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-tick/index.ts
git commit -m "feat(agent): agent-tick deps for outlook tokens, policy, presence, proposals, push"
```

---

## Task 12: `agent-approve` edge function

**Files:**
- Create: `supabase/functions/agent-approve/index.ts`
- Create: `supabase/functions/agent-approve/deno.json`

- [ ] **Step 1: Copy deno.json**

```bash
cp supabase/functions/agent-tick/deno.json supabase/functions/agent-approve/deno.json
```

- [ ] **Step 2: Write the function**

Create `supabase/functions/agent-approve/index.ts`:

```ts
// agent-approve - execute a pending proposed_action on user approval.
//
// JWT-authenticated only. Reads the proposed_actions row by id, verifies
// ownership + status='pending' + not expired, dispatches the action via
// the same tool catalog the runner uses, transitions the proposal row.
//
// Phase 3 only handles mail.send_reply (the sole propose action shipped).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { gmailSendDraft } from '../_shared/agent/tools/gmail.ts';
import { outlookSendDraft } from '../_shared/agent/tools/outlook.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function authenticatedUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length);
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supa.auth.getUser();
  if (error) return null;
  return data.user?.id ?? null;
}

async function loadGmailToken(client: SupabaseClient, userId: string): Promise<string> {
  const r = await loadRefreshToken(client, userId, 'google');
  if (!r) throw new Error('no google refresh token');
  const { accessToken } = await refreshAccessToken(client, userId, 'google', r);
  return accessToken;
}

async function loadOutlookToken(client: SupabaseClient, userId: string): Promise<string> {
  const r = await loadRefreshToken(client, userId, 'microsoft');
  if (!r) throw new Error('no microsoft refresh token');
  const { accessToken } = await refreshAccessToken(client, userId, 'microsoft', r);
  return accessToken;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const userId = await authenticatedUserId(req);
  if (!userId) return new Response('unauthorized', { status: 401 });

  let body: { action_id?: string; edited_body?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const actionId = body.action_id;
  if (!actionId) return new Response('action_id required', { status: 400 });

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Atomic transition: pending → approved, only if not expired and owned by caller.
  const { data: claimed, error: claimErr } = await client
    .from('proposed_actions')
    .update({ status: 'approved', decided_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('id, run_id, action_type, payload')
    .maybeSingle();
  if (claimErr) {
    console.error('[agent-approve] claim error', claimErr);
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), { status: 500 });
  }
  if (!claimed) {
    return new Response(JSON.stringify({ ok: false, reason: 'not_claimable' }), { status: 200 });
  }

  const payload = claimed.payload as Record<string, unknown>;
  const provider = payload.provider;
  const draftId = payload.draft_id as string | undefined;
  if (!draftId || (provider !== 'google' && provider !== 'microsoft')) {
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, reason: 'bad_payload' }), { status: 500 });
  }

  try {
    if (provider === 'google') {
      const tok = await loadGmailToken(client, userId);
      await gmailSendDraft({ fetch: fetch as never, accessToken: tok, draftId });
    } else {
      const tok = await loadOutlookToken(client, userId);
      await outlookSendDraft({ fetch: fetch as never, accessToken: tok, draftId });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[agent-approve] send error', msg);
    await client.from('proposed_actions').update({ status: 'failed' }).eq('id', actionId);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 502 });
  }

  // Mirror to agent_actions so the executed row appears in the Today feed.
  await client.from('agent_actions').insert({
    user_id: userId,
    run_id: claimed.run_id,
    proposal_id: actionId,
    action_type: claimed.action_type,
    payload,
    reversible: false,
    reverse_token: null,
  });
  await client
    .from('proposed_actions')
    .update({ status: 'executed', executed_at: new Date().toISOString() })
    .eq('id', actionId);

  return new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 });
});
```

- [ ] **Step 3: Type-check**

Run: `deno check supabase/functions/agent-approve/index.ts`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/agent-approve/
git commit -m "feat(agent): agent-approve edge function executes proposed sends"
```

---

## Task 13: `useProposedActions` hook + approve/dismiss client helpers

**Files:**
- Create: `src/lib/agent-proposals.ts`
- Create: `src/lib/__tests__/agent-proposals.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/__tests__/agent-proposals.test.ts`:

```ts
import { mergeProposedActions, type ProposedActionRow } from '../agent-proposals';

jest.mock('../supabase', () => ({ supabase: {} as never }));

const row = (id: string, created: string, status: ProposedActionRow['status'] = 'pending'): ProposedActionRow => ({
  id,
  action_type: 'mail.send_reply',
  payload: { thread_id: 't1', draft_id: 'draft-1' },
  preview: { title: 'Send svar?', body: 'Tak.' },
  status,
  created_at: created,
  expires_at: new Date(new Date(created).getTime() + 72 * 3600 * 1000).toISOString(),
});

describe('mergeProposedActions', () => {
  it('replaces row by id and re-sorts by created_at desc', () => {
    const before = [row('a', '2026-05-13T10:00:00Z'), row('b', '2026-05-13T11:00:00Z')];
    const merged = mergeProposedActions(before, row('b', '2026-05-13T11:00:00Z', 'executed'));
    expect(merged.find((r) => r.id === 'b')?.status).toBe('executed');
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('prepends new row', () => {
    const merged = mergeProposedActions([row('a', '2026-05-13T10:00:00Z')], row('b', '2026-05-13T12:00:00Z'));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 2: Run, fail, implement**

Create `src/lib/agent-proposals.ts`:

```ts
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface ProposedActionRow {
  id: string;
  action_type: 'mail.send_reply' | 'mail.draft_reply' | string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: 'pending' | 'approved' | 'dismissed' | 'expired' | 'executed' | 'failed';
  created_at: string;
  expires_at: string | null;
}

export function mergeProposedActions(
  existing: ProposedActionRow[],
  incoming: ProposedActionRow,
): ProposedActionRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return next;
}

export function useProposedActions(userId: string | null | undefined): {
  rows: ProposedActionRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<ProposedActionRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setLoading(false); return; }
    (async () => {
      const { data, error } = await supabase
        .from('proposed_actions')
        .select('id, action_type, payload, preview, status, created_at, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) console.warn('[agent-proposals] read failed:', error.message);
      setRows((data ?? []) as ProposedActionRow[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`proposed_actions:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'proposed_actions', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as ProposedActionRow;
          if (!next?.id) return;
          setRows((prev) => mergeProposedActions(prev, next));
        },
      )
      .subscribe();

    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [userId]);

  return { rows, loading };
}

export function usePendingProposalCount(userId: string | null | undefined): number {
  const { rows } = useProposedActions(userId);
  return rows.filter((r) => r.status === 'pending').length;
}

export async function approveProposedAction(actionId: string, editedBody?: string): Promise<{ ok: boolean; error?: string }> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'no session' };
  const baseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
  const res = await fetch(`${baseUrl}/functions/v1/agent-approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: actionId, edited_body: editedBody }),
  });
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const j = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error };
}

export async function dismissProposedAction(actionId: string): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from('proposed_actions')
    .update({ status: 'dismissed', decided_at: new Date().toISOString() })
    .eq('id', actionId)
    .eq('status', 'pending');
  return { ok: !error };
}
```

- [ ] **Step 3: Pass**

Run: `npm test -- agent-proposals`
Expected: 2 tests passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent-proposals.ts src/lib/__tests__/agent-proposals.test.ts
git commit -m "feat(agent): useProposedActions hook + approve/dismiss client helpers"
```

---

## Task 14: `<ProposedActionCard>` component

**Files:**
- Create: `src/components/ProposedActionCard.tsx`

- [ ] **Step 1: Build the card**

Create `src/components/ProposedActionCard.tsx`:

```tsx
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, ActivityIndicator } from 'react-native';
import {
  approveProposedAction,
  dismissProposedAction,
  type ProposedActionRow,
} from '../lib/agent-proposals';
import { colors } from '../theme';

function previewBody(row: ProposedActionRow): string {
  const b = row.preview.body;
  return typeof b === 'string' ? b : '';
}

function previewTitle(row: ProposedActionRow): string {
  const t = row.preview.title;
  return typeof t === 'string' ? t : 'Zolva foreslår';
}

export function ProposedActionCard({ row }: { row: ProposedActionRow }) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(previewBody(row));
  const [pending, setPending] = useState<'send' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSend() {
    setPending('send');
    setError(null);
    const r = await approveProposedAction(row.id, editing ? edited : undefined);
    setPending(null);
    if (!r.ok) setError(r.error ?? 'fejl');
  }
  async function onSkip() {
    setPending('skip');
    setError(null);
    await dismissProposedAction(row.id);
    setPending(null);
  }

  return (
    <View style={styles.card} accessibilityLabel={`proposed-${row.action_type}`}>
      <Text style={styles.title}>{previewTitle(row)}</Text>
      {editing ? (
        <TextInput
          value={edited}
          onChangeText={setEdited}
          multiline
          style={styles.input}
          accessibilityLabel="edit-body"
        />
      ) : (
        <Text style={styles.body}>{previewBody(row)}</Text>
      )}
      <View style={styles.actions}>
        <Pressable onPress={onSend} disabled={!!pending} style={styles.primary} accessibilityLabel="send">
          {pending === 'send' ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Send</Text>}
        </Pressable>
        <Pressable onPress={() => setEditing((v) => !v)} disabled={!!pending} accessibilityLabel="edit">
          <Text style={styles.secondary}>{editing ? 'Annullér' : 'Rediger'}</Text>
        </Pressable>
        <Pressable onPress={onSkip} disabled={!!pending} accessibilityLabel="skip">
          {pending === 'skip' ? <ActivityIndicator size="small" /> : <Text style={styles.secondary}>Spring over</Text>}
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.paperDeep,
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.ink + '22',
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  input: { color: colors.ink, fontSize: 14, lineHeight: 20, minHeight: 64, padding: 4, backgroundColor: '#fff', borderRadius: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  primary: { backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondary: { color: colors.ink, fontSize: 14, fontWeight: '500', textDecorationLine: 'underline' },
  error: { color: '#A24', fontSize: 12 },
});
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProposedActionCard.tsx
git commit -m "feat(agent): proposed-action card with send/edit/skip CTAs"
```

---

## Task 15: TodayScreen renders pending proposals above executed actions

**Files:**
- Modify: `src/screens/TodayScreen.tsx`
- Modify: `src/components/TodayAgentFeed.tsx` — extend to also render proposals

The simplest path: extend `TodayAgentFeed` to query both proposed_actions and agent_actions, render a single feed where pending proposals come first.

- [ ] **Step 1: Update `TodayAgentFeed`**

Replace the contents of `src/components/TodayAgentFeed.tsx`:

```tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAgentActions } from '../lib/agent-feed';
import { useProposedActions } from '../lib/agent-proposals';
import { useAuth } from '../lib/auth';
import { AgentActionCard } from './AgentActionCard';
import { ProposedActionCard } from './ProposedActionCard';
import { AgentEmptyState } from './AgentEmptyState';
import { colors } from '../theme';

export function TodayAgentFeed() {
  const { user } = useAuth();
  const { rows: actions, loading: actionsLoading } = useAgentActions(user?.id);
  const { rows: proposals, loading: proposalsLoading } = useProposedActions(user?.id);

  const pending = proposals.filter((p) => p.status === 'pending');
  const visibleActions = actions.filter((r) => !r.reversed_at);
  const loading = actionsLoading || proposalsLoading;

  if (loading || (pending.length === 0 && visibleActions.length === 0)) {
    return <AgentEmptyState />;
  }
  return (
    <View>
      <Text style={styles.header}>
        {pending.length} venter · {visibleActions.length} udført
      </Text>
      {pending.map((p) => (
        <ProposedActionCard key={p.id} row={p} />
      ))}
      {visibleActions.map((r) => (
        <AgentActionCard key={r.id} row={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
});
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/TodayAgentFeed.tsx
git commit -m "feat(agent): today feed merges pending proposals + executed actions"
```

`TodayScreen.tsx` already renders `<TodayAgentFeed />` from Phase 2 — no further changes there.

---

## Task 16: `<AgentActionPolicySection>` for Settings

**Files:**
- Create: `src/components/AgentActionPolicySection.tsx`

- [ ] **Step 1: Build the section**

Create `src/components/AgentActionPolicySection.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { colors } from '../theme';

type ActionType =
  | 'mail.archive'
  | 'mail.label'
  | 'mail.flag_important'
  | 'mail.summarize'
  | 'mail.draft_reply'
  | 'mail.send_reply';
type Mode = 'auto' | 'propose' | 'off';

const ROWS: Array<{ key: ActionType; label: string; defaultMode: Mode }> = [
  { key: 'mail.archive', label: 'Arkivering', defaultMode: 'auto' },
  { key: 'mail.label', label: 'Mærkning', defaultMode: 'auto' },
  { key: 'mail.flag_important', label: 'Markér som vigtig', defaultMode: 'auto' },
  { key: 'mail.summarize', label: 'Opsummering', defaultMode: 'auto' },
  { key: 'mail.draft_reply', label: 'Udkast til svar', defaultMode: 'auto' },
  { key: 'mail.send_reply', label: 'Send svar', defaultMode: 'propose' },
];

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'auto', label: 'Auto' },
  { key: 'propose', label: 'Spørg' },
  { key: 'off', label: 'Fra' },
];

export function AgentActionPolicySection() {
  const { user } = useAuth();
  const [policy, setPolicy] = useState<Record<ActionType, Mode>>({} as Record<ActionType, Mode>);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from('user_agent_policy')
        .select('action_type, mode')
        .eq('user_id', user.id);
      const next: Record<string, Mode> = {};
      for (const row of (data ?? []) as Array<{ action_type: string; mode: Mode }>) {
        next[row.action_type] = row.mode;
      }
      setPolicy(next as Record<ActionType, Mode>);
      setLoading(false);
    })();
  }, [user?.id]);

  const set = useCallback(async (actionType: ActionType, mode: Mode) => {
    if (!user) return;
    setPolicy((p) => ({ ...p, [actionType]: mode }));
    await supabase.from('user_agent_policy').upsert(
      { user_id: user.id, action_type: actionType, mode, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,action_type' },
    );
  }, [user?.id]);

  if (!user) return null;

  return (
    <View style={styles.section} accessibilityLabel="agent-action-policy">
      <Text style={styles.title}>Pr. handling</Text>
      <Text style={styles.body}>Vælg hvornår Zolva må handle på egen hånd.</Text>
      {ROWS.map((r) => {
        const mode = policy[r.key] ?? r.defaultMode;
        return (
          <View key={r.key} style={styles.row}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <View style={styles.modes}>
              {MODES.map((m) => (
                <Pressable
                  key={m.key}
                  onPress={() => set(r.key, m.key)}
                  disabled={loading}
                  style={[styles.modeBtn, mode === m.key && styles.modeBtnActive]}
                  accessibilityLabel={`${r.key}-${m.key}`}
                >
                  <Text style={[styles.modeText, mode === m.key && styles.modeTextActive]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingVertical: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 17, fontWeight: '600' },
  body: { color: colors.fg3, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8 },
  rowLabel: { color: colors.ink, fontSize: 15, flexShrink: 1 },
  modes: { flexDirection: 'row', gap: 6 },
  modeBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#0001' },
  modeBtnActive: { backgroundColor: colors.ink },
  modeText: { color: colors.ink, fontSize: 13 },
  modeTextActive: { color: '#fff' },
});
```

- [ ] **Step 2: Type-check + commit**

```bash
npm run typecheck
git add src/components/AgentActionPolicySection.tsx
git commit -m "feat(agent): settings per-action policy picker"
```

---

## Task 17: SettingsScreen renders the new policy section

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add import + render below the existing Zolva-handlinger toggle**

Find the `<ZolvaHandlingerSection />` JSX in `src/screens/SettingsScreen.tsx`. Immediately AFTER it (in the same parent container), add:

```tsx
<AgentActionPolicySection />
```

And add the import near the existing `ZolvaHandlingerSection` import:

```ts
import { AgentActionPolicySection } from '../components/AgentActionPolicySection';
```

- [ ] **Step 2: Type-check + commit**

```bash
npm run typecheck
git add src/screens/SettingsScreen.tsx
git commit -m "feat(agent): settings screen renders per-action policy picker"
```

---

## Task 18: Push-handler deep-link for `agent_proposal`

**Files:**
- Modify: wherever Expo push payloads are routed (find by grep — likely `src/lib/notifications.ts` or `App.tsx`).

- [ ] **Step 1: Locate the handler**

Run: `grep -rn "addNotificationResponseReceivedListener\|data.type\|Notifications.addNotification" src/ App.tsx 2>/dev/null | head -10`

Identify the file that already routes `data.type === 'reminder'` or similar to the right screen.

- [ ] **Step 2: Add the new route**

Inside the existing notification-response handler's switch on `data.type`, add a case:

```ts
case 'agent_proposal':
  // Deep-link to the Today tab. Use whatever navigation primitive
  // the existing handlers use (e.g. navigation.navigate('Today')).
  navigation.navigate('Today');
  break;
```

If the existing handler uses a different primitive (linking, deep-link URL, etc.), match that pattern.

- [ ] **Step 3: Commit**

```bash
git add <whatever-file>
git commit -m "feat(agent): deep-link agent_proposal push to Today tab"
```

---

## Task 19: Tab badge for pending proposals

**Files:**
- Modify: the tab-bar / navigator config that defines the Today tab (`src/navigation/TabBar.tsx` or similar — find via grep).

- [ ] **Step 1: Locate the tab bar config**

Run: `grep -rn "Today.*tab\|tabBarBadge\|createBottomTabNavigator" src/ 2>/dev/null | head -10`

- [ ] **Step 2: Wire the badge**

In the Today tab's screen-options block (or wherever badges are configured), use `usePendingProposalCount`:

```tsx
import { usePendingProposalCount } from '../lib/agent-proposals';
import { useAuth } from '../lib/auth';

function TodayTabBadge(): number | undefined {
  const { user } = useAuth();
  const count = usePendingProposalCount(user?.id);
  return count > 0 ? count : undefined;
}
```

Pass `TodayTabBadge()` to the `tabBarBadge` option (the exact syntax depends on the existing config — match the established pattern).

- [ ] **Step 3: Type-check + commit**

```bash
npm run typecheck
git add <whatever-file>
git commit -m "feat(agent): today tab badge shows pending proposal count"
```

---

## Task 20: Deploy + verify

- [ ] **Step 1: Push branch + merge to main**

```bash
git push -u origin feat/agent-phase-3-proposals-drafts
git checkout main
git merge --no-ff feat/agent-phase-3-proposals-drafts -m "feat(agent): phase 3 proposals + draft replies"
git push origin main
```

- [ ] **Step 2: Deploy edge functions**

```bash
supabase functions deploy agent-tick --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
supabase functions deploy agent-approve --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
supabase functions deploy poll-mail --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

(No new migration in Phase 3.)

- [ ] **Step 3: Apply the expire-proposals cron (manual paste)**

Open `supabase/schedule-agent-expire-proposals.sql.template`. Paste into Dashboard SQL editor for project `sjkhfkatmeqtsrysixop`, replacing `PASTE_SB_SECRET_KEY` with your `sb_secret_…`. Run.

Verify:
```bash
supabase db remote query "select jobname, schedule from cron.job where jobname = 'agent-expire-proposals';"
```
Expected: one row, schedule `*/5 * * * *`.

- [ ] **Step 4: Ship the OTA**

```bash
eas update --branch production --message "feat(agent): phase 3 proposals + draft replies"
```

- [ ] **Step 5: End-to-end verification**

Send yourself a real reply-able mail (from a recipient you've replied to before). Wait ~2 minutes. The Today tab should show:
1. A pending `<ProposedActionCard>` "Send svar?" — tap "Send" → check your Sent folder.
2. An executed `<AgentActionCard>` "Udkastet" — confirms the auto-draft.

Repeat on an Outlook account if available — confirm the proposal flow works with `provider='microsoft'`.

---

## Definition of done

- [ ] `poll-mail` emits `mail.new` events for both google AND microsoft watchers.
- [ ] `agent-tick` calls Claude with the 6-tool catalog; `mail.draft_reply` runs auto and creates real provider drafts; `mail.send_reply` writes to `proposed_actions`.
- [ ] Push notification fires on proposal write iff user is idle (≥ 60s since `last_active_at`).
- [ ] `agent-approve` deployed and executes a pending proposal end-to-end on Gmail and Outlook.
- [ ] `agent-expire-proposals` cron entry present and sweeping pending rows past `expires_at`.
- [ ] Today tab shows pending + executed feed with header counter; tap "Send" works; tap "Spring over" dismisses.
- [ ] Settings shows per-action policy picker; flipping a row to "Fra" blocks that action type on the next run.
- [ ] All new Deno + Jest tests pass.
- [ ] No regression in existing tests.

---

## What Phase 3.1 will add on top of this

- **Outlook triage** (archive/label/flag) using move-to-Archive-folder + Outlook categories + Outlook flagged-status. Closes the Outlook parity gap.
- **`mail.send_reply` auto-send** behind the recipient-pattern allowlist. Requires adding a `provider_to` column to `mail_events` first, then computing the "user has replied to X ≥ 3 times in last 60 days" allowlist in the runner.
- **Trust-escalation prompt** (spec §5.3) — after 3 approvals of the same `(action_type, recipient)` pair, prompt to flip the policy to `auto` for that recipient.

## What Phase 4 will add on top of this

- `cal.rsvp`, `cal.create_event`, `cal.update_event`, `cal.suggest_times`.
- `memory.followup_draft` driven by facts.
- `nudge.push` for proactive briefings.
- `agent-reflect` cron for scheduled big-picture turns (morning/midday/evening + 30-min sweep).
- Standing tasks (`user.intent`).
