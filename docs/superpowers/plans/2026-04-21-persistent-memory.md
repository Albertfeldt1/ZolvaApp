# Persistent User Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the persistent user memory feature from `docs/superpowers/specs/2026-04-21-persistent-memory-design.md` — live event-driven fact extraction, chat + mail-event sync to Supabase, a Danish profile preamble injected into every Claude call via prompt caching, a three-tab Memory hub, and a consent-gated opt-in flow with kill-switch.

**Architecture:** One new client module (`src/lib/profile.ts`) builds the preamble and is the single read-side entry point. One new store module (`src/lib/profile-store.ts`) owns all Supabase CRUD for `facts` / `chat_messages` / `mail_events`. Extraction runs as a fire-and-forget module (`src/lib/profile-extractor.ts`) triggered from existing chat / draft / mail-decision code paths. `src/lib/claude.ts` becomes the single choke point that prepends the preamble to every outbound Claude call. The Supabase schema is already applied; only the edge function needs a small change to accept `system` as a structured array so we can attach `cache_control`.

**Tech Stack:** Expo (SDK 54), React Native 0.81, TypeScript, `@supabase/supabase-js`, AsyncStorage, existing `claude-proxy` Supabase Edge Function. No new dependencies.

## Testing note

This project has **no unit test framework** and its conventions reject introducing one in feature plans (see `2026-04-19-notifications-foundation.md`). TDD-style failing-test-first is replaced with:

1. **Typecheck gate:** every task runs `npm run typecheck` and must pass.
2. **Manual verification steps** on a physical device with a dev build (Expo Go is insufficient for push, native APIs, and Supabase auth on ES256 per project memory).
3. **Frequent commits** — one per task.

Do not add Jest, Vitest, or any test runner as part of this plan.

## Prerequisites

- Supabase tables `facts`, `chat_messages`, `mail_events` and their RLS policies are already applied to project `sjkhfkatmeqtsrysixop`. Verify with `supabase db pull` or the Dashboard → Table Editor before starting Task 1.
- `claude-proxy` is already deployed with `--no-verify-jwt` (done earlier this session).
- A dev build is needed for Task 13's verification (chat sync requires Supabase auth and push test requires a real device).

## File map

**Create:**
- `src/lib/profile-store.ts` — Supabase CRUD for facts/chat_messages/mail_events. Subscribe/cache pattern mirroring `memory-store.ts`.
- `src/lib/profile.ts` — `buildProfilePreamble(userId)` + memoization + factsSignature hash.
- `src/lib/profile-extractor.ts` — `runExtractor({trigger, payload})`, debounce map, JSON schema, dedup via `normalized_text`.
- `src/lib/chat-sync.ts` — `syncChatMessage(row)` + one-shot local→Supabase migration on opt-in.
- `src/lib/mail-events.ts` — `recordMailEvent(event)` thin wrapper around the Supabase insert.
- `src/lib/profile-demo.ts` — static Danish profile preamble for demo users.
- `src/components/MemoryConsentModal.tsx` — one-time Danish consent dialog.
- `src/components/FactRow.tsx` — a compact row used in Fakta tab (edit/delete).

**Modify:**
- `src/lib/types.ts` — new exported types.
- `src/lib/claude.ts` — `CompleteOptions.system` becomes `string | ClaudeSystemBlock[]`; new `attachProfile?: boolean` option; preamble prepend logic in `completeRaw`.
- `src/lib/hooks.ts` — extend `PrivacyFlagId` with `'memory-enabled'`; new hooks (`useFacts`, `usePendingFacts`, `useChatHistoryRows`); wire extractor trigger calls in `useChat` and `generateDraft`; swap chat persistence gate from `local-only` to "local always + server-if-memory-enabled".
- `src/lib/demo.ts` — import and re-export `DEMO_PROFILE_PREAMBLE` from `profile-demo.ts` for consistency with other demo exports.
- `src/screens/MemoryScreen.tsx` — three-tab structure; add Fakta tab; add Samtalehistorik tab; wire delete buttons; add kill-switch toggle.
- `src/screens/TodayScreen.tsx` — pending-fact row variant inside "Hvad jeg har bemærket" with *Ja, husk det* / *Nej* actions.
- `src/screens/InboxDetailScreen.tsx` and/or `src/screens/InboxScreen.tsx` — call `recordMailEvent` on defer/dismiss/drafted_reply actions.
- `supabase/functions/claude-proxy/index.ts` — forward `system` as either string or typed array; validate shape.
- `App.tsx` — show `MemoryConsentModal` on first launch after feature flag enabled.

**Deploy:**
- `supabase functions deploy claude-proxy --no-verify-jwt` after Task 1.

**Env var:**
- Add `EXPO_PUBLIC_PROFILE_MEMORY=1` to `.env` once ready to test locally (Task 12's manual verification).

---

## Task 1: Accept `system` as a structured block array in `claude-proxy`

**Why first:** All subsequent client changes that want prompt caching depend on the proxy forwarding `system` blocks (with `cache_control`) instead of treating it as a string.

**Files:**
- Modify: `supabase/functions/claude-proxy/index.ts`

- [ ] **Step 1: Update request typing and forwarding**

Edit `supabase/functions/claude-proxy/index.ts`. Locate the `type ProxyRequest` (lines 27–34) and replace:

```ts
type ClaudeSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type ProxyRequest = {
  messages: Message[];
  model?: string;
  max_tokens?: number;
  system?: string | ClaudeSystemBlock[];
  temperature?: number;
  tools?: unknown[];
};
```

Locate the block that builds `anthropicBody` (lines 84–92) and replace the `system` handling so an array passes through unchanged and a string becomes a single-element array for consistency on Anthropic's side:

```ts
if (body.system != null) {
  anthropicBody.system = Array.isArray(body.system)
    ? body.system
    : [{ type: 'text', text: body.system }];
}
```

- [ ] **Step 2: Redeploy**

Run: `supabase functions deploy claude-proxy --no-verify-jwt`

Expected: `Deployed Functions on project sjkhfkatmeqtsrysixop: claude-proxy`.

- [ ] **Step 3: Smoke test**

In the running app, open the chat tab and send a short message. Verify in Supabase Dashboard → Functions → claude-proxy → Logs that a new invocation appears with `status=200`. This confirms the proxy still accepts string-form `system` from existing callers.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/claude-proxy/index.ts
git commit -m "feat(claude-proxy): accept system as string or block array for prompt caching"
```

---

## Task 2: Add types for profile data model

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Append new types**

Append at the end of `src/lib/types.ts`:

```ts
export type FactCategory =
  | 'relationship'
  | 'role'
  | 'preference'
  | 'project'
  | 'commitment'
  | 'other';

export type FactStatus = 'pending' | 'confirmed' | 'rejected';

export type Fact = {
  id: string;
  userId: string;
  text: string;
  normalizedText: string;
  category: FactCategory;
  status: FactStatus;
  source: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  rejectionTtl: Date | null;
};

export type MailEventType =
  | 'read'
  | 'deferred'
  | 'dismissed'
  | 'drafted_reply'
  | 'replied';

export type MailEvent = {
  id: string;
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerSubject: string | null;
  occurredAt: Date;
};

export type ChatMessageRow = {
  id: string;
  userId: string;
  clientId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: Date;
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add Fact, MailEvent, ChatMessageRow types"
```

---

## Task 3: Add `memory-enabled` privacy flag

**Why:** Everything in this feature is gated by this flag. Adding it early means later tasks can just read it synchronously via `getPrivacyFlag('memory-enabled')`.

**Files:**
- Modify: `src/lib/hooks.ts:1055-1067`

- [ ] **Step 1: Extend the flag union and defaults**

In `src/lib/hooks.ts`, replace the block at lines 1055–1067 with:

```ts
export type PrivacyFlagId =
  | 'training-opt-in'
  | 'local-only'
  | 'anon-reports'
  | 'memory-enabled';

const PRIVACY_DEFAULTS: Record<PrivacyFlagId, boolean> = {
  'training-opt-in': false,
  'local-only': true,
  'anon-reports': true,
  'memory-enabled': false,
};

const DEFAULT_PRIVACY_TOGGLES: PrivacyToggle[] = [
  { id: 'training-opt-in', label: 'Brug mine data til at forbedre Zolva', enabled: PRIVACY_DEFAULTS['training-opt-in'] },
  { id: 'local-only', label: 'Gem samtaler lokalt', enabled: PRIVACY_DEFAULTS['local-only'] },
  { id: 'anon-reports', label: 'Del fejlrapporter anonymt', enabled: PRIVACY_DEFAULTS['anon-reports'] },
  { id: 'memory-enabled', label: 'Lad Zolva lære dig at kende', enabled: PRIVACY_DEFAULTS['memory-enabled'] },
];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no errors. The `PrivacyToggle` type at the top of `hooks.ts` is structural and accepts any `PrivacyFlagId`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(privacy): add memory-enabled flag (default off)"
```

---

## Task 4: Supabase CRUD store (`src/lib/profile-store.ts`)

**Files:**
- Create: `src/lib/profile-store.ts`

- [ ] **Step 1: Write the store**

Create `src/lib/profile-store.ts`:

```ts
import { supabase } from './supabase';
import type {
  ChatMessageRow,
  Fact,
  FactCategory,
  FactStatus,
  MailEvent,
  MailEventType,
} from './types';

export function normalizeFactText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToFact(r: Record<string, unknown>): Fact {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    text: r.text as string,
    normalizedText: r.normalized_text as string,
    category: r.category as FactCategory,
    status: r.status as FactStatus,
    source: (r.source as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at as string) : null,
    rejectedAt: r.rejected_at ? new Date(r.rejected_at as string) : null,
    rejectionTtl: r.rejection_ttl ? new Date(r.rejection_ttl as string) : null,
  };
}

function rowToMailEvent(r: Record<string, unknown>): MailEvent {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    eventType: r.event_type as MailEventType,
    providerThreadId: r.provider_thread_id as string,
    providerFrom: (r.provider_from as string | null) ?? null,
    providerSubject: (r.provider_subject as string | null) ?? null,
    occurredAt: new Date(r.occurred_at as string),
  };
}

function rowToChatMessage(r: Record<string, unknown>): ChatMessageRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    clientId: r.client_id as string,
    role: r.role as 'user' | 'assistant' | 'tool',
    content: r.content as string,
    createdAt: new Date(r.created_at as string),
  };
}

export async function listFacts(userId: string, status?: FactStatus): Promise<Fact[]> {
  let q = supabase.from('facts').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(rowToFact);
}

export async function findDuplicateFact(
  userId: string,
  normalizedText: string,
): Promise<Fact | null> {
  const { data, error } = await supabase
    .from('facts')
    .select('*')
    .eq('user_id', userId)
    .eq('normalized_text', normalizedText)
    .or('status.eq.confirmed,and(status.eq.rejected,rejection_ttl.gt.' + new Date().toISOString() + ')')
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? rowToFact(row) : null;
}

export async function insertPendingFact(
  userId: string,
  input: { text: string; category: FactCategory; source: string | null },
): Promise<Fact> {
  const normalized = normalizeFactText(input.text);
  const { data, error } = await supabase
    .from('facts')
    .insert({
      user_id: userId,
      text: input.text,
      normalized_text: normalized,
      category: input.category,
      status: 'pending',
      source: input.source,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToFact(data as Record<string, unknown>);
}

export async function confirmFact(factId: string): Promise<void> {
  const { error } = await supabase
    .from('facts')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', factId);
  if (error) throw error;
}

export async function rejectFact(factId: string): Promise<void> {
  const ttl = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('facts')
    .update({ status: 'rejected', rejected_at: new Date().toISOString(), rejection_ttl: ttl })
    .eq('id', factId);
  if (error) throw error;
}

export async function deleteFact(factId: string): Promise<void> {
  const { error } = await supabase.from('facts').delete().eq('id', factId);
  if (error) throw error;
}

export async function deleteAllFacts(userId: string): Promise<void> {
  const { error } = await supabase.from('facts').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function listRecentMailEvents(userId: string, limit = 5): Promise<MailEvent[]> {
  const { data, error } = await supabase
    .from('mail_events')
    .select('*')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToMailEvent);
}

export async function insertMailEvent(
  userId: string,
  ev: Omit<MailEvent, 'id' | 'userId' | 'occurredAt'>,
): Promise<void> {
  const { error } = await supabase.from('mail_events').insert({
    user_id: userId,
    event_type: ev.eventType,
    provider_thread_id: ev.providerThreadId,
    provider_from: ev.providerFrom,
    provider_subject: ev.providerSubject,
  });
  if (error) throw error;
}

export async function upsertChatMessage(
  userId: string,
  row: Pick<ChatMessageRow, 'clientId' | 'role' | 'content'>,
): Promise<void> {
  const { error } = await supabase.from('chat_messages').upsert(
    {
      user_id: userId,
      client_id: row.clientId,
      role: row.role,
      content: row.content,
    },
    { onConflict: 'user_id,client_id' },
  );
  if (error) throw error;
}

export async function listRecentChatMessages(
  userId: string,
  limit = 3,
): Promise<ChatMessageRow[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToChatMessage).reverse();
}

export async function deleteAllChatHistory(userId: string): Promise<void> {
  const { error } = await supabase.from('chat_messages').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function deleteAllMailEvents(userId: string): Promise<void> {
  const { error } = await supabase.from('mail_events').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function getFactsSignature(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('facts')
    .select('id, created_at, confirmed_at, rejected_at')
    .eq('user_id', userId);
  if (error) throw error;
  const rows = data ?? [];
  const latest = rows.reduce((acc, r) => {
    const t = Math.max(
      Date.parse((r.created_at as string) ?? '0'),
      Date.parse((r.confirmed_at as string) ?? '0'),
      Date.parse((r.rejected_at as string) ?? '0'),
    );
    return Math.max(acc, t);
  }, 0);
  return `${rows.length}:${latest}`;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/profile-store.ts
git commit -m "feat(profile-store): Supabase CRUD for facts, chat_messages, mail_events"
```

---

## Task 5: Build the profile preamble (`src/lib/profile.ts`)

**Files:**
- Create: `src/lib/profile.ts`
- Create: `src/lib/profile-demo.ts`
- Modify: `src/lib/demo.ts`

- [ ] **Step 1: Create the static demo preamble**

Create `src/lib/profile-demo.ts`:

```ts
export const DEMO_PROFILE_PREAMBLE = [
  'Om brugeren:',
  '• Du arbejder som seniorkonsulent hos Lundgreen & Partner.',
  '• Du foretrækker korte, venlige mails og ingen lange hilsner.',
  '',
  'Relationer:',
  '• Maria Bergmann – din leder.',
  '• Mikkel Holm – bedste ven, arbejder hos Nordea.',
  '• Signe – din ægtefælle.',
  '',
  'Igangværende:',
  '• Nordea-pitch – deadline 28. april.',
  '• Onboarding af Louise (ny praktikant).',
  '',
  'Seneste kontekst:',
  '• Du aftalte med Maria at sende førsteudkast torsdag.',
  '• Du afviste Mikkels forslag om fredagsfrokost (travl uge).',
].join('\n');
```

- [ ] **Step 2: Export from `demo.ts` for consistency**

Append to `src/lib/demo.ts`:

```ts
export { DEMO_PROFILE_PREAMBLE } from './profile-demo';
```

- [ ] **Step 3: Create the preamble builder**

Create `src/lib/profile.ts`:

```ts
import type { Fact, FactCategory, MailEvent, ChatMessageRow } from './types';
import {
  getFactsSignature,
  listFacts,
  listRecentChatMessages,
  listRecentMailEvents,
} from './profile-store';
import { DEMO_PROFILE_PREAMBLE } from './profile-demo';
import { isDemoUser } from './auth';

const PREAMBLE_TOKEN_CAP = 800;
const CONTEXT_LINE_CHAR_CAP = 120;

// Rough char -> token ratio. Anthropic tokenizer averages ~4 chars/token for Danish text.
function approxTokenCount(s: string): number {
  return Math.ceil(s.length / 4);
}

function factsHeading(cat: FactCategory): string | null {
  switch (cat) {
    case 'role':
    case 'preference':
    case 'other':
      return 'Om brugeren';
    case 'relationship':
      return 'Relationer';
    case 'project':
      return 'Igangværende';
    case 'commitment':
      return 'Løfter og aftaler';
    default:
      return null;
  }
}

function groupFactsBySection(facts: Fact[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of facts) {
    const heading = factsHeading(f.category);
    if (!heading) continue;
    const arr = groups.get(heading) ?? [];
    arr.push(`• ${f.text.trim()}`);
    groups.set(heading, arr);
  }
  return groups;
}

function renderChatContext(rows: ChatMessageRow[]): string[] {
  return rows.map((r) => {
    const prefix = r.role === 'user' ? 'Bruger' : 'Zolva';
    const text = r.content.replace(/\s+/g, ' ').trim();
    const truncated = text.length > CONTEXT_LINE_CHAR_CAP
      ? text.slice(0, CONTEXT_LINE_CHAR_CAP - 1) + '…'
      : text;
    return `• ${prefix}: ${truncated}`;
  });
}

function renderMailEventContext(rows: MailEvent[]): string[] {
  return rows.map((r) => {
    const from = r.providerFrom ?? 'ukendt afsender';
    const subject = r.providerSubject ?? '(intet emne)';
    const verb: Record<MailEvent['eventType'], string> = {
      read: 'læst',
      deferred: 'udskudt',
      dismissed: 'ignoreret',
      drafted_reply: 'udkast lavet',
      replied: 'besvaret',
    };
    return `• ${from}: "${subject}" — ${verb[r.eventType]} ${timeAgo(r.occurredAt)}`;
  });
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m siden`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}t siden`;
  const days = Math.floor(hours / 24);
  return `${days}d siden`;
}

export async function buildProfilePreambleFromData(data: {
  facts: Fact[];
  chat: ChatMessageRow[];
  mail: MailEvent[];
}): Promise<string> {
  const sections: string[] = [];
  const grouped = groupFactsBySection(data.facts.filter((f) => f.status === 'confirmed'));

  for (const heading of ['Om brugeren', 'Relationer', 'Igangværende', 'Løfter og aftaler']) {
    const bullets = grouped.get(heading);
    if (!bullets || bullets.length === 0) continue;
    sections.push(`${heading}:\n${bullets.join('\n')}`);
  }

  const chatLines = renderChatContext(data.chat);
  const mailLines = renderMailEventContext(data.mail);
  if (chatLines.length || mailLines.length) {
    sections.push(
      `Seneste kontekst:\n${[...chatLines, ...mailLines].join('\n')}`,
    );
  }

  if (sections.length === 0) return '';

  // Budget: drop trailing context lines until under PREAMBLE_TOKEN_CAP.
  // We only trim the Seneste kontekst section because facts are load-bearing.
  let text = sections.join('\n\n');
  const contextSectionIndex = sections.length - 1;
  let contextLines = [...chatLines, ...mailLines];
  while (approxTokenCount(text) > PREAMBLE_TOKEN_CAP && contextLines.length > 0) {
    contextLines = contextLines.slice(0, -1);
    sections[contextSectionIndex] =
      contextLines.length > 0
        ? `Seneste kontekst:\n${contextLines.join('\n')}`
        : '';
    text = sections.filter(Boolean).join('\n\n');
  }
  return text;
}

type CachedPreamble = { signature: string; value: string };
const preambleCache = new Map<string, CachedPreamble>();

export function invalidatePreamble(userId: string): void {
  preambleCache.delete(userId);
}

export async function buildProfilePreamble(
  userId: string,
  opts?: { user?: { id: string; isDemo?: boolean } },
): Promise<string> {
  // Demo users get a pre-baked preamble; never touches Supabase.
  if (opts?.user && isDemoUser(opts.user as never)) return DEMO_PROFILE_PREAMBLE;

  try {
    const signature = await getFactsSignature(userId);
    const cached = preambleCache.get(userId);
    if (cached && cached.signature === signature) return cached.value;
    const [facts, chat, mail] = await Promise.all([
      listFacts(userId, 'confirmed'),
      listRecentChatMessages(userId, 3),
      listRecentMailEvents(userId, 5),
    ]);
    const value = await buildProfilePreambleFromData({ facts, chat, mail });
    preambleCache.set(userId, { signature, value });
    return value;
  } catch (err) {
    if (__DEV__) console.warn('[profile] buildProfilePreamble failed:', err);
    return '';
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/profile.ts src/lib/profile-demo.ts src/lib/demo.ts
git commit -m "feat(profile): preamble builder with memoization and demo fallback"
```

---

## Task 6: Wire preamble into `claude.ts` with `attachProfile` option

**Files:**
- Modify: `src/lib/claude.ts`

- [ ] **Step 1: Update types**

In `src/lib/claude.ts`, locate `CompleteOptions` (lines 44–52) and extend:

```ts
export type ClaudeSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type CompleteOptions = {
  system?: string | ClaudeSystemBlock[];
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: ClaudeToolSchema[];
  metadata?: { user_id?: string };
  attachProfile?: boolean; // default true
};
```

- [ ] **Step 2: Prepend preamble in `completeRaw`**

Replace the body of `completeRaw` (starting line 72) with:

```ts
export async function completeRaw(opts: CompleteOptions): Promise<ClaudeCompletion> {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new ClaudeConfigError('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  const userId = sessionData.session?.user?.id;
  if (!accessToken) {
    throw new ClaudeConfigError('Du skal være logget ind for at bruge Claude.');
  }

  const attach = opts.attachProfile !== false && userId;
  let systemBlocks: ClaudeSystemBlock[] = [];
  if (attach && getPrivacyFlag('memory-enabled')) {
    const preamble = await buildProfilePreamble(userId, { user: sessionData.session!.user });
    if (preamble) {
      systemBlocks.push({ type: 'text', text: preamble, cache_control: { type: 'ephemeral' } });
    }
  }
  if (opts.system != null) {
    if (typeof opts.system === 'string') {
      systemBlocks.push({ type: 'text', text: opts.system });
    } else {
      systemBlocks.push(...opts.system);
    }
  }

  const payload: Record<string, unknown> = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    messages: opts.messages,
  };
  if (systemBlocks.length > 0) payload.system = systemBlocks;
  if (opts.tools != null) payload.tools = opts.tools;

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude proxy ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as AnthropicResponse;
  if (!Array.isArray(json.content)) {
    throw new Error('Claude proxy returned malformed response');
  }

  const text = json.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  const toolUses = json.content.flatMap((block): ClaudeToolUse[] =>
    block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
  return { text, toolUses, stopReason: json.stop_reason, rawContent: json.content };
}
```

- [ ] **Step 3: Add the imports**

At the top of `src/lib/claude.ts` (after the existing `import { supabase } from './supabase';` line):

```ts
import { buildProfilePreamble } from './profile';
import { getPrivacyFlag } from './hooks';
```

Note: `claude.ts` importing from `hooks.ts` is fine here because `getPrivacyFlag` is a plain exported function, not a hook. If you hit a circular import at runtime, move `getPrivacyFlag` + the privacy cache into a new `src/lib/privacy-flags.ts` and re-export from `hooks.ts` — but only do that if you actually hit the issue.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Smoke test**

Run the app, send a chat message. Verify in Supabase Functions logs that `usage.input_tokens` bumps as expected. With `memory-enabled=false` (default), no preamble should attach; token counts should match pre-feature baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat(claude): prepend profile preamble with ephemeral cache_control"
```

---

## Task 7: Fact extractor (`src/lib/profile-extractor.ts`)

**Files:**
- Create: `src/lib/profile-extractor.ts`

- [ ] **Step 1: Write the extractor**

Create `src/lib/profile-extractor.ts`:

```ts
import { completeJson } from './claude';
import { findDuplicateFact, insertPendingFact, normalizeFactText } from './profile-store';
import type { FactCategory } from './types';
import { getPrivacyFlag } from './hooks';
import { invalidatePreamble } from './profile';

type Trigger = 'chat_turn' | 'mail_draft' | 'mail_decision' | 'mail_reply';

type ExtractionPayload = {
  trigger: Trigger;
  userId: string;
  // Short free-text input the extractor reads. For chat this is the user's last turn + assistant's short reply. For mail it's the event-type + subject + from.
  text: string;
  source: string | null;
};

type Candidate = {
  text: string;
  category: FactCategory;
  confidence: number;
};

const EXTRACTOR_SYSTEM =
  'Du læser et kort uddrag af samtale eller mailbeslutning og vurderer om der er én ny, ' +
  'varig oplysning om brugeren værd at huske (relation, rolle, præference, igangværende projekt, eller løfte). ' +
  'Svar altid på dansk. Tag kun fakta frem der vil være relevante om en uge eller mere. ' +
  'Ignorér flygtige ting (humør, hvad brugeren spiser til frokost). Returnér højst ét kandidat-faktum.';

const EXTRACTOR_SCHEMA =
  '{"candidate": {"text": string, "category": "relationship" | "role" | "preference" | "project" | "commitment" | "other", "confidence": number (0 til 1)} | null}\n' +
  '- text: en kort sætning på dansk, fx "Maria er din leder".\n' +
  '- category: den bedst passende kategori.\n' +
  '- confidence: 0.6 eller mere hvis du er rimelig sikker; lavere hvis du gætter.';

const CONFIDENCE_THRESHOLD = 0.6;
const DEBOUNCE_MS = 2000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<string>();

export function runExtractor(payload: ExtractionPayload): void {
  if (!getPrivacyFlag('memory-enabled')) return;
  const key = `${payload.userId}:${payload.trigger}`;
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    if (inflight.has(key)) return;
    inflight.add(key);
    void runNow(payload).finally(() => {
      inflight.delete(key);
    });
  }, DEBOUNCE_MS);
  debounceTimers.set(key, timer);
}

async function runNow(payload: ExtractionPayload): Promise<void> {
  try {
    const result = await completeJson<{ candidate: Candidate | null }>({
      system: EXTRACTOR_SYSTEM,
      schemaHint: EXTRACTOR_SCHEMA,
      messages: [{ role: 'user', content: payload.text }],
      maxTokens: 200,
      temperature: 0.2,
      attachProfile: false,
    });
    const c = result.candidate;
    if (!c || c.confidence < CONFIDENCE_THRESHOLD) return;
    const normalized = normalizeFactText(c.text);
    if (!normalized) return;
    const duplicate = await findDuplicateFact(payload.userId, normalized);
    if (duplicate) return;
    await insertPendingFact(payload.userId, {
      text: c.text.trim(),
      category: c.category,
      source: payload.source,
    });
    invalidatePreamble(payload.userId);
  } catch (err) {
    if (__DEV__) console.warn('[profile-extractor] run failed:', err);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/profile-extractor.ts
git commit -m "feat(profile-extractor): fire-and-forget fact extraction with debounce and dedup"
```

---

## Task 8: Chat-sync module (`src/lib/chat-sync.ts`)

**Files:**
- Create: `src/lib/chat-sync.ts`
- Modify: `src/lib/hooks.ts` — call sync on chat persist

- [ ] **Step 1: Write the chat-sync module**

Create `src/lib/chat-sync.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { upsertChatMessage } from './profile-store';
import type { ChatMessage } from './types';
import { getPrivacyFlag } from './hooks';

const migrationFlagKey = (uid: string) => `zolva.${uid}.chat.synced`;
const chatHistoryKey = (uid: string) => `zolva.${uid}.chat.history`;

// Writes a single chat turn to Supabase. Fire-and-forget; errors are swallowed
// so failures never block the UI. Local AsyncStorage persistence continues
// unchanged.
export function syncChatMessage(userId: string, msg: ChatMessage): void {
  if (!getPrivacyFlag('memory-enabled')) return;
  const role = msg.from === 'user' ? 'user' : 'assistant';
  void upsertChatMessage(userId, { clientId: msg.id, role, content: msg.text }).catch((err) => {
    if (__DEV__) console.warn('[chat-sync] upsert failed:', err);
  });
}

// One-shot migration of existing AsyncStorage chat history to Supabase.
// Called on first toggle-on of memory-enabled. Idempotent via the synced flag.
export async function migrateLocalChatIfNeeded(userId: string): Promise<void> {
  if (!getPrivacyFlag('memory-enabled')) return;
  try {
    const flag = await AsyncStorage.getItem(migrationFlagKey(userId));
    if (flag === '1') return;
    const raw = await AsyncStorage.getItem(chatHistoryKey(userId));
    if (!raw) {
      await AsyncStorage.setItem(migrationFlagKey(userId), '1');
      return;
    }
    const saved = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(saved)) return;
    for (const m of saved) {
      const role = m.from === 'user' ? 'user' : 'assistant';
      await upsertChatMessage(userId, { clientId: m.id, role, content: m.text });
    }
    await AsyncStorage.setItem(migrationFlagKey(userId), '1');
  } catch (err) {
    if (__DEV__) console.warn('[chat-sync] migrate failed:', err);
  }
}
```

- [ ] **Step 2: Hook the sync into `useChat`**

In `src/lib/hooks.ts`, find the two `setMessages(...)` calls inside `useChat`'s `send` function (the assistant response append in the `.then(...)` handler around line 1572–1581, and the user-message append at line 1523). After each, call `syncChatMessage(userId, <newMessage>)`.

Concretely, modify the user-message block (around lines 1522–1525):

```ts
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        from: 'user',
        text: trimmed,
      };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setTyping(true);
      if (userId) syncChatMessage(userId, userMsg);
```

And the assistant-response block (around lines 1574–1581):

```ts
        .then((answer) => {
          const assistantMsg: ChatMessage = {
            id: `a-${Date.now()}`,
            from: 'zolva',
            text: answer.length > 0 ? answer : CHAT_ERROR_TEXT,
          };
          setMessages((cur) => [...cur, assistantMsg]);
          if (userId) syncChatMessage(userId, assistantMsg);
        })
```

Add the import at the top of `src/lib/hooks.ts` near the other `./` imports:

```ts
import { syncChatMessage } from './chat-sync';
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/chat-sync.ts src/lib/hooks.ts
git commit -m "feat(chat-sync): fire-and-forget per-message sync to chat_messages"
```

---

## Task 9: Mail-event recorder and call sites

**Files:**
- Create: `src/lib/mail-events.ts`
- Modify: `src/screens/InboxDetailScreen.tsx` (and/or `src/screens/InboxScreen.tsx`) — call-site wiring

- [ ] **Step 1: Write the recorder**

Create `src/lib/mail-events.ts`:

```ts
import { insertMailEvent } from './profile-store';
import type { MailEventType } from './types';
import { getPrivacyFlag } from './hooks';

type RecordInput = {
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerSubject: string | null;
};

export function recordMailEvent(input: RecordInput): void {
  if (!getPrivacyFlag('memory-enabled')) return;
  void insertMailEvent(input.userId, {
    eventType: input.eventType,
    providerThreadId: input.providerThreadId,
    providerFrom: input.providerFrom,
    providerSubject: input.providerSubject,
  }).catch((err) => {
    if (__DEV__) console.warn('[mail-events] insert failed:', err);
  });
}
```

- [ ] **Step 2: Identify call sites**

Run: `grep -nE "onDefer|onDismiss|onDraft|dismiss|defer|draft" src/screens/InboxDetailScreen.tsx src/screens/InboxScreen.tsx | head -30`

Record the handlers that correspond to: user defers a mail, user dismisses a mail, user saves a draft reply. For each handler, after the existing logic completes successfully, call `recordMailEvent(...)` with the appropriate `eventType`.

- [ ] **Step 3: Wire each handler**

For each identified handler, the call looks like:

```ts
import { recordMailEvent } from '../lib/mail-events';
import { useAuth } from '../lib/auth';

// inside the component
const { user } = useAuth();

// inside the handler (example for defer)
if (user?.id && mail) {
  recordMailEvent({
    userId: user.id,
    eventType: 'deferred',
    providerThreadId: mail.threadId,
    providerFrom: mail.from ?? null,
    providerSubject: mail.subject ?? null,
  });
}
```

Adapt the field names to match whatever the mail model actually exposes (`mail.threadId`, `mail.from`, `mail.subject`). Read `src/lib/types.ts` for `NormalizedMail` and adjust if names differ.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-events.ts src/screens/InboxDetailScreen.tsx src/screens/InboxScreen.tsx
git commit -m "feat(mail-events): record deferred/dismissed/drafted_reply events"
```

---

## Task 10: Hook extractor triggers into existing flows

**Files:**
- Modify: `src/lib/hooks.ts` — call `runExtractor` at trigger points
- Modify: mail action handlers from Task 9

- [ ] **Step 1: Chat turn trigger**

In `src/lib/hooks.ts`, inside `useChat.send`'s assistant-response `.then((answer) => {...})` block (just after `syncChatMessage`), add:

```ts
if (userId) {
  runExtractor({
    trigger: 'chat_turn',
    userId,
    text: `Bruger: ${trimmed}\nZolva: ${assistantMsg.text}`,
    source: `chat:${assistantMsg.id}`,
  });
}
```

Add the import:

```ts
import { runExtractor } from './profile-extractor';
```

- [ ] **Step 2: Draft-saved trigger**

Find `generateDraft` (around line 568). After a successful draft generation, in the caller (where the draft is persisted — look for `generateDraft(...)` usages via `grep -nE "generateDraft" src/lib/hooks.ts src/screens/`), add after a successful resolve:

```ts
runExtractor({
  trigger: 'mail_draft',
  userId,
  text: `Brugeren besvarede en mail fra ${m.from} om "${m.subject}" — tone: ${tone}`,
  source: `mail:${m.threadId}`,
});
```

- [ ] **Step 3: Mail decision triggers**

Inside each of the defer / dismiss handlers (from Task 9), after `recordMailEvent`, also call:

```ts
runExtractor({
  trigger: 'mail_decision',
  userId: user.id,
  text: `Brugeren ${eventType === 'deferred' ? 'udskød' : 'ignorerede'} mail fra ${mail.from} med emnet "${mail.subject}"`,
  source: `mail:${mail.threadId}`,
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks.ts src/screens/InboxDetailScreen.tsx src/screens/InboxScreen.tsx
git commit -m "feat(extractor-triggers): run extractor after chat turn, draft, and mail decision"
```

---

## Task 11: Pending-fact row in Today observations

**Files:**
- Modify: `src/screens/TodayScreen.tsx`
- Modify: `src/lib/hooks.ts` — `usePendingFacts` hook

- [ ] **Step 1: Add `usePendingFacts` hook**

Append to `src/lib/hooks.ts` near the other fact-related hooks (or end of file):

```ts
export function usePendingFacts(): Result<Fact[]> & {
  accept: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
} {
  const { user } = useAuth();
  const userId = user?.id;
  const [state, setState] = useState<Result<Fact[]>>({ data: [], loading: false, error: null });
  const memoryEnabled = useMemoryEnabled();

  const refresh = useCallback(async () => {
    if (!userId || !memoryEnabled) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const rows = await listFacts(userId, 'pending');
      setState({ data: rows, loading: false, error: null });
    } catch (err) {
      setState({ data: [], loading: false, error: err as Error });
    }
  }, [userId, memoryEnabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const accept = useCallback(async (id: string) => {
    await confirmFact(id);
    if (userId) invalidatePreamble(userId);
    void refresh();
  }, [refresh, userId]);

  const reject = useCallback(async (id: string) => {
    await rejectFact(id);
    if (userId) invalidatePreamble(userId);
    void refresh();
  }, [refresh, userId]);

  return { ...state, accept, reject };
}

function useMemoryEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => getPrivacyFlag('memory-enabled'));
  useEffect(() => {
    let cancelled = false;
    void hydratePrivacyCache().then(() => {
      if (!cancelled) setEnabled(getPrivacyFlag('memory-enabled'));
    });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}
```

Add the necessary imports at the top of `hooks.ts` (or alongside existing `./` imports):

```ts
import type { Fact } from './types';
import { confirmFact, listFacts, rejectFact } from './profile-store';
import { invalidatePreamble } from './profile';
```

- [ ] **Step 2: Render pending-fact rows in TodayScreen**

In `src/screens/TodayScreen.tsx`, near the existing observations-fetch line (around line 61):

```ts
const { data: pendingFacts, accept: acceptFact, reject: rejectFact } = usePendingFacts();
```

Merge pending facts into the visible observation list. The cleanest approach: render pending facts as the first items in the dark "Hvad jeg har bemærket" section, then observations below. Inside the `<View style={{ gap: 14 }}>` block that maps `feedObservations`, prepend a mapping over pending facts:

```tsx
{pendingFacts.map((f) => (
  <PendingFactRow
    key={f.id}
    fact={f}
    onAccept={() => acceptFact(f.id)}
    onReject={() => rejectFact(f.id)}
  />
))}
```

- [ ] **Step 3: Add the `PendingFactRow` component in the same file**

Below `NoticedRow` in `src/screens/TodayScreen.tsx`, add:

```tsx
function PendingFactRow({
  fact,
  onAccept,
  onReject,
}: {
  fact: Fact;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <View style={styles.noticedRow}>
      <Stone mood="thinking" size={36} />
      <View style={{ flex: 1 }}>
        <Text style={styles.noticedText}>Skal jeg huske at {fact.text}?</Text>
        <View style={styles.noticedActions}>
          <Pressable onPress={onAccept}>
            <Text style={styles.noticedCta}>Ja, husk det</Text>
          </Pressable>
          <Pressable onPress={onReject}>
            <Text style={styles.noticedDismiss}>Nej</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
```

Add the `Fact` import and `usePendingFacts` import near the top of the file.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks.ts src/screens/TodayScreen.tsx
git commit -m "feat(today): render pending-fact proposals inside Hvad jeg har bemærket"
```

---

## Task 12: Consent modal + App.tsx integration

**Files:**
- Create: `src/components/MemoryConsentModal.tsx`
- Modify: `App.tsx` — render modal once after sign-in
- Modify: `src/lib/hooks.ts` — helper `shouldShowMemoryConsent()` / `markMemoryConsentShown()`

- [ ] **Step 1: Add helper in hooks.ts**

Append to `src/lib/hooks.ts`:

```ts
const memoryConsentKey = (uid: string) => `zolva.${uid}.memory.consent-shown-at`;

export async function shouldShowMemoryConsent(uid: string): Promise<boolean> {
  if (getPrivacyFlag('memory-enabled')) return false;
  try {
    const raw = await AsyncStorage.getItem(memoryConsentKey(uid));
    if (!raw) return true;
    const shownAt = parseInt(raw, 10);
    if (Number.isNaN(shownAt)) return true;
    const daysSince = (Date.now() - shownAt) / (1000 * 60 * 60 * 24);
    // Re-prompt once after 14 days if still off.
    return daysSince >= 14 && daysSince < 28;
  } catch {
    return true;
  }
}

export async function markMemoryConsentShown(uid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(memoryConsentKey(uid), Date.now().toString());
  } catch {}
}
```

- [ ] **Step 2: Build the modal component**

Create `src/components/MemoryConsentModal.tsx`:

```tsx
import React from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { setPrivacyFlag } from '../lib/hooks';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';

type Props = {
  visible: boolean;
  userId: string;
  onClose: () => void;
};

export function MemoryConsentModal({ visible, userId, onClose }: Props) {
  const enable = async () => {
    await setPrivacyFlag('memory-enabled', true);
    void migrateLocalChatIfNeeded(userId);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <Text style={styles.eyebrow}>Nyt</Text>
          <Text style={styles.title}>Zolva kan nu lære dig at kende</Text>
          <Text style={styles.p}>Med din tilladelse begynder Zolva at huske:</Text>
          <Text style={styles.bullet}>• Dine samtaler med Zolva.</Text>
          <Text style={styles.bullet}>• Hvem du mailer med (kun afsender og emnelinje, ikke indhold).</Text>
          <Text style={styles.bullet}>• Fakta du bekræfter, fx "Maria er min leder".</Text>
          <Text style={styles.p}>Det lever i din Zolva-konto — aldrig selve mail-indholdet.</Text>
          <Text style={styles.p}>Du kan altid slå det fra eller slette alt under Indstillinger → Hukommelse.</Text>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable style={styles.secondary} onPress={onClose}><Text style={styles.secondaryText}>Ikke nu</Text></Pressable>
          <Pressable style={styles.primary} onPress={enable}><Text style={styles.primaryText}>Aktivér hukommelse</Text></Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  body: { padding: 24, gap: 12 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88, textTransform: 'uppercase', color: colors.sageDeep },
  title: { fontFamily: fonts.displayItalic, fontSize: 28, letterSpacing: -0.36, color: colors.ink },
  p: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.fg2 },
  bullet: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 22, color: colors.fg2 },
  footer: { flexDirection: 'row', gap: 12, padding: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  primary: { flex: 2, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.ink },
  primaryText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.paper },
  secondary: { flex: 1, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.mist },
  secondaryText: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.fg2 },
});
```

- [ ] **Step 3: Add `setPrivacyFlag` helper if missing**

Check `src/lib/hooks.ts` for an existing `setPrivacyFlag` export. If absent, add:

```ts
export async function setPrivacyFlag(id: PrivacyFlagId, value: boolean): Promise<void> {
  ensurePrivacyUserSubscription();
  await hydratePrivacyCache();
  privacyCache = { ...privacyCache, [id]: value };
  const uid = privacyUid;
  if (uid) {
    try {
      await AsyncStorage.setItem(privacyTogglesKey(uid), JSON.stringify(privacyCache));
    } catch {}
  }
}
```

- [ ] **Step 4: Show the modal from App.tsx**

Edit `App.tsx` inside whatever component holds the authenticated shell. Add state and effect:

```tsx
const [memoryConsentOpen, setMemoryConsentOpen] = useState(false);

useEffect(() => {
  if (!user?.id) return;
  let cancelled = false;
  void shouldShowMemoryConsent(user.id).then((show) => {
    if (cancelled || !show) return;
    setMemoryConsentOpen(true);
  });
  return () => { cancelled = true; };
}, [user?.id]);
```

And in the JSX tree:

```tsx
{user?.id && (
  <MemoryConsentModal
    visible={memoryConsentOpen}
    userId={user.id}
    onClose={() => {
      setMemoryConsentOpen(false);
      void markMemoryConsentShown(user.id);
    }}
  />
)}
```

Add the needed imports.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/MemoryConsentModal.tsx src/lib/hooks.ts App.tsx
git commit -m "feat(memory): one-time consent modal gates memory feature opt-in"
```

---

## Task 13: MemoryScreen 3-tab restructure + kill-switch

**Files:**
- Modify: `src/screens/MemoryScreen.tsx`
- Create: `src/components/FactRow.tsx`

- [ ] **Step 1: Add the fact row component**

Create `src/components/FactRow.tsx`:

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { colors, fonts } from '../theme';
import type { Fact, FactCategory } from '../lib/types';

const CATEGORY_LABEL: Record<FactCategory, string> = {
  relationship: 'Relation',
  role: 'Rolle',
  preference: 'Præference',
  project: 'Projekt',
  commitment: 'Løfte',
  other: 'Andet',
};

export function FactRow({ fact, onDelete }: { fact: Fact; onDelete: () => void }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{CATEGORY_LABEL[fact.category]}</Text>
        <Text style={styles.text}>{fact.text}</Text>
      </View>
      <Pressable onPress={onDelete} hitSlop={12}>
        <Trash2 size={18} color={colors.fg3} strokeWidth={1.75} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  label: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.fg3 },
  text: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.ink, marginTop: 2 },
});
```

- [ ] **Step 2: Extend MemoryScreen with tabs**

Replace `src/screens/MemoryScreen.tsx`'s top-level JSX with a three-tab structure. Pattern (partial — adapt names/indent to existing file):

```tsx
type Tab = 'fakta' | 'noter' | 'samtaler';
const [tab, setTab] = useState<Tab>('fakta');
```

Render a simple horizontal segmented tab row above the existing content. For the `fakta` tab:

```tsx
<View style={{ padding: 20 }}>
  <Pressable style={styles.killRow} onPress={toggleMemory}>
    <Text style={styles.killRowLabel}>Hukommelse {memoryEnabled ? 'tændt' : 'slukket'}</Text>
    <Text style={styles.killRowAction}>{memoryEnabled ? 'Slå fra' : 'Slå til'}</Text>
  </Pressable>
  {facts.length === 0 ? (
    <EmptyState mood="thinking" title="Jeg kender dig ikke endnu" body="Efterhånden som vi snakker, foreslår jeg fakta du kan bekræfte." />
  ) : (
    facts.map((f) => <FactRow key={f.id} fact={f} onDelete={() => deleteFactAndRefresh(f.id)} />)
  )}
  {facts.length > 0 && (
    <>
      <Pressable style={styles.dangerRow} onPress={confirmWipeFacts}>
        <Text style={styles.dangerText}>Slet hele profilen</Text>
      </Pressable>
      <Pressable style={styles.dangerRow} onPress={confirmWipeChat}>
        <Text style={styles.dangerText}>Slet samtalehistorik</Text>
      </Pressable>
    </>
  )}
</View>
```

For the `samtaler` tab, render a scrollable list of `ChatMessageRow` from `listRecentChatMessages(userId, 100)` (treat 100 as the Memory-screen view cap). For each row display `role`, `content`, `createdAt`.

Gate all this behind `memoryEnabled`. When false, the Fakta tab shows:

```tsx
<EmptyState mood="calm" title="Hukommelse er slået fra" body="Slå til for at lade Zolva lære dig at kende." ctaLabel="Slå til" onCta={toggleMemory} />
```

Use `Alert.alert('Sikker på at du vil slette alle fakta?', ..., [...])` for `confirmWipeFacts` and `confirmWipeChat`; on confirm call `deleteAllFacts(userId)` or `deleteAllChatHistory(userId)` + `deleteAllMailEvents(userId)`, then refresh.

- [ ] **Step 3: Toggle hook wiring**

In `MemoryScreen.tsx`:

```ts
const { user } = useAuth();
const userId = user?.id ?? '';
const memoryEnabled = useMemoryEnabled();
const [facts, setFacts] = useState<Fact[]>([]);
useEffect(() => {
  if (!memoryEnabled || !userId) { setFacts([]); return; }
  void listFacts(userId, 'confirmed').then(setFacts);
}, [memoryEnabled, userId]);

const toggleMemory = async () => {
  const next = !memoryEnabled;
  await setPrivacyFlag('memory-enabled', next);
  if (next) void migrateLocalChatIfNeeded(userId);
};
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/FactRow.tsx src/screens/MemoryScreen.tsx
git commit -m "feat(memory-screen): 3-tab hub with kill-switch and delete actions"
```

---

## Task 14: Feature flag gate + final integration

**Files:**
- Modify: `App.tsx` — wrap consent modal trigger in feature-flag check
- Modify: `src/lib/hooks.ts` — respect feature flag in `getPrivacyFlag('memory-enabled')`

- [ ] **Step 1: Add feature-flag constant**

In `App.tsx` near other env reads:

```ts
const PROFILE_MEMORY_FLAG = process.env.EXPO_PUBLIC_PROFILE_MEMORY === '1';
```

Gate the consent-modal `useEffect` so it only fires when `PROFILE_MEMORY_FLAG` is `true`.

- [ ] **Step 2: Harden `getPrivacyFlag`**

In `src/lib/hooks.ts`, wrap `getPrivacyFlag` so `memory-enabled` is always false when the env flag is off:

```ts
const PROFILE_MEMORY_FLAG = process.env.EXPO_PUBLIC_PROFILE_MEMORY === '1';

export function getPrivacyFlag(id: PrivacyFlagId): boolean {
  if (id === 'memory-enabled' && !PROFILE_MEMORY_FLAG) return false;
  const cached = privacyCache[id];
  return cached === undefined ? PRIVACY_DEFAULTS[id] : cached;
}
```

- [ ] **Step 3: Document**

Add a comment block at the top of `src/lib/profile.ts`:

```ts
// Persistent memory feature (spec: docs/superpowers/specs/2026-04-21-persistent-memory-design.md).
// Gated by EXPO_PUBLIC_PROFILE_MEMORY=1 + user toggle memory-enabled.
// Without either, no preamble is built, no extractor fires, no chat sync, no mail events recorded.
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks.ts src/lib/profile.ts App.tsx
git commit -m "feat(memory): EXPO_PUBLIC_PROFILE_MEMORY feature flag as kill switch"
```

---

## Task 15: Manual end-to-end verification on device

**Prerequisites:** Dev build on a physical device. Set `EXPO_PUBLIC_PROFILE_MEMORY=1` in `.env`. Rebuild the dev client (`npm run ios` on the connected device).

- [ ] **Step 1: Clean-slate consent flow**

1. Sign out, sign back in as a fresh test user.
2. Consent modal should appear within ~1 second.
3. Tap *Ikke nu*. Verify in Supabase Dashboard → Table Editor → `chat_messages` that no row was inserted for this user.
4. Send a chat message. Verify no row appears — `memory-enabled` is off.

- [ ] **Step 2: Opt in and chat**

1. Open Indstillinger (or MemoryScreen) → toggle *memory-enabled* to on.
2. Send a chat message: *"Min leder hedder Maria"*.
3. Within 2–3 seconds, open Supabase → `chat_messages`: rows for user turn + assistant turn should exist.
4. Open Today screen. Within ~5 seconds you should see a pending-fact row: *"Skal jeg huske at Maria er din leder?"*. Tap *Ja, husk det*.
5. Refresh MemoryScreen → Fakta tab. Verify the fact appears.

- [ ] **Step 3: Preamble injection**

1. Send a follow-up chat: *"Hvem er min leder?"*.
2. The reply should correctly name Maria. If it doesn't, check Supabase Functions → claude-proxy logs for `usage.input_tokens` — it should be ≥200 higher than pre-profile baseline on first call, then cached (lower) on subsequent calls within 5 min.

- [ ] **Step 4: Mail decisions**

1. Open Inbox, defer a mail.
2. Verify `mail_events` table has a new `deferred` row.
3. Verify the pending-fact row may or may not propose something about the mail — acceptable outcomes: a proposal, or silence.

- [ ] **Step 5: Kill switch**

1. MemoryScreen → toggle off.
2. Tap *Slet profil* and confirm. Verify `facts` table is empty for the user.
3. Send another chat. Verify no new `chat_messages` rows.

- [ ] **Step 6: Final commit (if any remaining edits)**

```bash
git add -A
git commit -m "chore(memory): verification pass — manual e2e on device"
```

---

## Out-of-scope reminders (do not add to this plan)

- Embedding / pgvector retrieval — v2.
- Full mail body storage — v2.
- Supabase Realtime subscription for cross-device fact sync — v2.
- Outbound-reply detection via `poll-mail` — v2. The spec mentions a `replied` mail event, but v1 only records `deferred`, `dismissed`, and `drafted_reply`. The `replied` event type stays in the enum and table for a future task that modifies `poll-mail/index.ts` to detect user outbounds.
- Daily-brief feature — has its own spec and plan (`2026-04-21-daily-brief-design.md`).
- Jest or any test runner — not in this plan.
