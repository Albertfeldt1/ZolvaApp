# Server-Side Reminders + Voice Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Zolva reminders from device-local AsyncStorage to a server-backed `public.reminders` table so (1) voice can create reminders via Siri, (2) notifications fire reliably from a server cron instead of fragile `expo-notifications` scheduling, and (3) reminders sync across devices in the future.

**Architecture:** Reminders persist in `public.reminders` (already-existing schema, extended with `fired_at` for delivery tracking). Client uses supabase-js with the authenticated user's JWT — RLS policies enforce per-user isolation, no new edge endpoints needed for CRUD. A new `reminders-fire` cron-driven edge function checks every minute for due-but-unfired rows, sends Expo push notifications, and stamps `fired_at`. The voice path's existing `widget-action` Edge Function gets a second Claude tool, `create_reminder`, alongside the existing `create_calendar_event` — Claude picks based on the user's words. AsyncStorage reminders get a one-time migration on app boot, then the local code path is deleted.

**Tech Stack:** Supabase Postgres + Edge Functions (Deno), pg_cron, Expo SDK 54, React Native 0.81, TypeScript, Anthropic Messages API (Claude Haiku 4.5), expo-notifications (receive-side only — scheduling moves server-side).

---

## Held-back files / parallel-session context

The branch this plan executes on top of has recent commits from a parallel session that expanded Google OAuth scopes and added chat-tools (`b27e8a1 feat(google): expand OAuth scopes...`). Those touched `src/lib/chat-tools.ts`, `src/lib/hooks.ts`, `src/lib/auth.ts`, and added `src/lib/google-drive.ts`. None of those files are core to this plan, but the engineer should:

- Read the current `hooks.ts` `add_reminder` / `list_reminders` chat-tool blocks before editing — the existing tool definitions may have shifted line numbers
- Not assume `chat-tools.ts` matches HEAD~10 — it has been recently rewritten

---

## File structure

**Create:**
- `supabase/migrations/<ts>_reminders_fired_at.sql` — adds `fired_at` column + RLS policies + indexes
- `supabase/functions/reminders-fire/index.ts` — cron-invoked, selects due reminders + sends push
- `supabase/functions/reminders-fire/deno.json`
- `supabase/schedule-reminders-fire.sql.template` — pg_cron schedule (held back; user installs)
- `src/lib/reminders.ts` — server-backed CRUD + subscriptions (replaces memory-store reminder paths)
- `src/lib/__tests__/reminders.test.ts` — unit tests for the client module's filters/helpers

**Modify:**
- `src/lib/memory-store.ts` — strip reminder code (notes stay), keep only the reminder migration helper
- `src/lib/hooks.ts` — `useReminders`, `add_reminder` / `list_reminders` / `done_reminder` chat tools route through `reminders.ts`
- `src/lib/types.ts` — add `Reminder.fired_at` field, drop client-only fields
- `src/lib/notifications.ts` — `scheduleReminderNotification` becomes a no-op (server handles firing); push handler routes `type: 'reminder'` to existing tap deeplink
- `src/screens/MemoryScreen.tsx` — replace any `useReminders` mutation calls with the new shape if signatures changed
- `App.tsx` — boot-time AsyncStorage migration runs once, gated by a flag
- `supabase/functions/widget-action/claude.ts` — add `create_reminder` tool + system-prompt instruction to disambiguate
- `supabase/functions/widget-action/index.ts` — branch on Claude's chosen tool name (`create_calendar_event` vs `create_reminder`)
- `supabase/functions/widget-action/responses.ts` — happy-path snippet copy for reminder-created
- `docs/superpowers/plans/widget-v2-qa-checklist.md` — append voice-reminder cases

**Delete (Phase 6):**
- The reminder-shaped exports from `src/lib/memory-store.ts` once migration has shipped through 2 release cycles

---

## Phase 0 — Schema

### Task 1: Add `fired_at` column + RLS to `public.reminders`

**Files:**
- Create: `supabase/migrations/<ts>_reminders_fired_at.sql`

The existing schema is:
```
id uuid pk default gen_random_uuid()
user_id uuid not null references auth.users(id) on delete cascade
title text not null
due_at timestamptz not null
completed boolean default false
created_at timestamptz default now()
```

It has no RLS policies (table is empty in prod, never used). Adds `fired_at`, `scheduled_for_tz` (for displaying back the user's intended local time without re-deriving from due_at + their tz), and policies.

- [ ] **Step 1: Write the migration**

Use a fresh timestamp:
```bash
ts=$(date -u +"%Y%m%d%H%M%S")
echo "supabase/migrations/${ts}_reminders_fired_at.sql"
```

Create that file with:
```sql
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS fired_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_for_tz text;

CREATE INDEX IF NOT EXISTS reminders_due_unfired
  ON public.reminders (due_at)
  WHERE fired_at IS NULL AND completed = false;

CREATE INDEX IF NOT EXISTS reminders_user_pending
  ON public.reminders (user_id, due_at)
  WHERE completed = false;

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reminders_self_read"
  ON public.reminders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "reminders_self_insert"
  ON public.reminders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reminders_self_update"
  ON public.reminders FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reminders_self_delete"
  ON public.reminders FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON COLUMN public.reminders.fired_at IS
  'Timestamp the reminders-fire cron sent the push notification. NULL means not yet fired. Used to dedupe across cron ticks.';

COMMENT ON COLUMN public.reminders.scheduled_for_tz IS
  'IANA timezone the user intended at create-time (e.g. "Europe/Copenhagen"). Lets the client render due_at in the original tz even if the user has since moved. Optional — falls back to user_settings.timezone.';
```

- [ ] **Step 2: Apply via MCP `apply_migration`**

```bash
# Pseudo — use mcp__plugin_supabase_supabase__apply_migration
# name: reminders_fired_at
# query: <the SQL above>
```

- [ ] **Step 3: Verify schema**

Run via MCP `execute_sql`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reminders'
ORDER BY ordinal_position;

SELECT polname FROM pg_policy WHERE polrelid = 'public.reminders'::regclass;
```

Expected: 8 columns (id, user_id, title, due_at, completed, created_at, fired_at, scheduled_for_tz). 4 policies (reminders_self_*).

- [ ] **Step 4: Commit migration**

```bash
git add supabase/migrations/${ts}_reminders_fired_at.sql
git commit -m "feat(db): reminders.fired_at + RLS for server-side reminder store"
```

---

## Phase 1 — Client server-backed reminders module

### Task 2: Write the failing tests for `src/lib/reminders.ts`

**Files:**
- Create: `src/lib/__tests__/reminders.test.ts`

We test the pure helpers (`isPendingAndDueOrUpcoming`, `formatReminderForListTool`) — the network calls themselves go through supabase-js and are exercised in manual QA.

- [ ] **Step 1: Write the test file**

```ts
import { isPendingAndDueOrUpcoming, formatReminderForListTool } from '../reminders';
import type { Reminder } from '../types';

const baseReminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  text: 'pick up dry cleaning',
  dueAt: new Date('2026-05-01T16:00:00Z'),
  status: 'pending',
  createdAt: new Date('2026-04-30T10:00:00Z'),
  doneAt: null,
  firedAt: null,
  ...over,
});

describe('isPendingAndDueOrUpcoming', () => {
  const NOW = new Date('2026-05-01T15:00:00Z');

  it('keeps future-due pending reminders', () => {
    expect(isPendingAndDueOrUpcoming(baseReminder(), NOW)).toBe(true);
  });

  it('keeps no-time pending reminders', () => {
    expect(isPendingAndDueOrUpcoming(baseReminder({ dueAt: null }), NOW)).toBe(true);
  });

  it('keeps recently-past pending reminders inside grace window', () => {
    const r = baseReminder({ dueAt: new Date('2026-05-01T14:58:00Z') });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(true);
  });

  it('drops reminders past the 5-min grace window', () => {
    const r = baseReminder({ dueAt: new Date('2026-05-01T14:50:00Z') });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(false);
  });

  it('drops completed reminders regardless of due time', () => {
    const r = baseReminder({ status: 'done', doneAt: NOW });
    expect(isPendingAndDueOrUpcoming(r, NOW)).toBe(false);
  });
});

describe('formatReminderForListTool', () => {
  it('renders id, status, due, text', () => {
    const out = formatReminderForListTool(baseReminder());
    expect(out).toBe('r1 [pending] 2026-05-01T16:00:00.000Z: pick up dry cleaning');
  });

  it('renders ingen tid for null dueAt', () => {
    const out = formatReminderForListTool(baseReminder({ dueAt: null }));
    expect(out).toBe('r1 [pending] ingen tid: pick up dry cleaning');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm test -- --testPathPattern='reminders.test'
```

Expected: tests fail because `src/lib/reminders.ts` doesn't exist yet.

### Task 3: Implement `src/lib/reminders.ts`

**Files:**
- Create: `src/lib/reminders.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/reminders.ts
//
// Server-backed reminder store (public.reminders). Replaces the
// AsyncStorage-only memory-store reminder code. Uses supabase-js with
// the authenticated user's JWT — RLS policies enforce per-user
// isolation, so no extra server-side endpoints are needed for CRUD.
//
// Subscriptions: realtime is overkill for v1; clients refresh-on-mount
// + refresh-after-mutation. Move to realtime if multi-device sync
// becomes a priority.

import { supabase } from './supabase';
import type { Reminder, ReminderStatus } from './types';

const TABLE = 'reminders';
const PAST_DUE_GRACE_MS = 5 * 60 * 1000;

type Row = {
  id: string;
  user_id: string;
  title: string;
  due_at: string;
  completed: boolean;
  created_at: string;
  fired_at: string | null;
  scheduled_for_tz: string | null;
};

function rowToReminder(row: Row): Reminder {
  return {
    id: row.id,
    text: row.title,
    dueAt: row.due_at ? new Date(row.due_at) : null,
    status: row.completed ? 'done' : 'pending',
    createdAt: new Date(row.created_at),
    doneAt: row.completed ? new Date(row.created_at) : null,
    firedAt: row.fired_at ? new Date(row.fired_at) : null,
    scheduledForTz: row.scheduled_for_tz ?? null,
  };
}

export async function listAllReminders(userId: string): Promise<Reminder[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('due_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToReminder(r as Row));
}

export async function addReminder(
  userId: string,
  text: string,
  dueAt: Date | null,
  tz: string | null,
): Promise<Reminder> {
  if (!text.trim()) throw new Error('addReminder: empty text');
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: userId,
      title: text.trim(),
      due_at: (dueAt ?? new Date('2099-12-31T00:00:00Z')).toISOString(),
      scheduled_for_tz: tz,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToReminder(data as Row);
}

export async function markReminderDone(id: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .update({ completed: true })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteReminder(id: string): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// Filter helper for the chat list_reminders tool — drops done + past-due
// outside a small grace window. Pure, testable.
export function isPendingAndDueOrUpcoming(r: Reminder, now: Date): boolean {
  if (r.status === 'done') return false;
  if (r.dueAt && r.dueAt.getTime() < now.getTime() - PAST_DUE_GRACE_MS) return false;
  return true;
}

export function formatReminderForListTool(r: Reminder): string {
  const due = r.dueAt ? r.dueAt.toISOString() : 'ingen tid';
  return `${r.id} [${r.status}] ${due}: ${r.text}`;
}
```

- [ ] **Step 2: Update `src/lib/types.ts` to match the row shape**

Find `export type Reminder` and add fields:
```ts
export type Reminder = {
  id: string;
  text: string;
  dueAt: Date | null;
  status: ReminderStatus;
  createdAt: Date;
  doneAt: Date | null;
  // Server-tracked fields (Phase 1+):
  firedAt: Date | null;
  scheduledForTz: string | null;
};
```

- [ ] **Step 3: Run tests, verify pass**

```bash
npm test -- --testPathPattern='reminders.test'
```

Expected: 7 passing.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean. If TodayScreen / MemoryScreen complain about Reminder shape, they're using missing fields — fix in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders.ts src/lib/__tests__/reminders.test.ts src/lib/types.ts
git commit -m "feat(reminders): server-backed CRUD module + filter helpers"
```

### Task 4: Replace memory-store reminder paths with `reminders.ts` calls

**Files:**
- Modify: `src/lib/memory-store.ts` (strip reminder code; keep notes)
- Modify: `src/lib/hooks.ts` (`useReminders` + chat tools route through new module)

The memory-store still owns notes — leave that. Reminders move out.

- [ ] **Step 1: Strip reminder exports from memory-store.ts**

In `src/lib/memory-store.ts`, find and delete:
- `remindersKey`, `remindersCache`, `remindersListeners`, `notifyReminders`
- `reviveReminder` for reminders (keep notes equivalent)
- `listReminders`, `subscribeReminders`, `addReminder` (renamed from `storeAddReminder` import elsewhere), `markReminderDone`, `removeReminder`
- The reminders branch of the boot-load function (lines ~79-89 with `multiGet`)

Keep:
- All note-related code unchanged
- Any cancellation hook for `cancelReminderNotification` — that lives in notifications.ts, no change here

- [ ] **Step 2: Update `useReminders` in hooks.ts**

Find the existing `useReminders` definition (currently at hooks.ts ~2165) and replace with a server-backed version:

```ts
export function useReminders() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const demo = isDemoUser(user);
  const [reminders, setReminders] = useState<Reminder[]>(() =>
    demo ? demoReminders() : [],
  );
  const [loading, setLoading] = useState(!demo);

  const refresh = useCallback(async () => {
    if (demo) { setReminders(demoReminders()); setLoading(false); return; }
    if (!userId) { setReminders([]); setLoading(false); return; }
    try {
      const next = await listAllReminders(userId);
      setReminders(next);
    } catch (err) {
      if (__DEV__) console.warn('[useReminders] refresh failed:', err);
    } finally {
      setLoading(false);
    }
  }, [demo, userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const markDone = useCallback(async (id: string) => {
    if (demo) {
      setReminders((p) =>
        p.map((r) => r.id === id ? { ...r, status: 'done' as const, doneAt: new Date() } : r));
      return;
    }
    await markReminderDone(id);
    await refresh();
  }, [demo, refresh]);

  const remove = useCallback(async (id: string) => {
    if (demo) { setReminders((p) => p.filter((r) => r.id !== id)); return; }
    await deleteReminder(id);
    await refresh();
  }, [demo, refresh]);

  const add = useCallback(async (text: string, dueAt?: Date): Promise<Reminder> => {
    if (demo) {
      const r: Reminder = {
        id: `d-r-${Date.now()}`,
        text,
        dueAt: dueAt ?? null,
        status: 'pending',
        createdAt: new Date(),
        doneAt: null,
        firedAt: null,
        scheduledForTz: null,
      };
      setReminders((p) => [...p, r]);
      return r;
    }
    if (!userId) throw new Error('useReminders.add: no user');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await addReminder(userId, text, dueAt ?? null, tz);
    await refresh();
    return r;
  }, [demo, refresh, userId]);

  return { data: reminders, loading, error: null as Error | null, markDone, remove, add };
}
```

Add at top of hooks.ts:
```ts
import {
  listAllReminders,
  addReminder,
  markReminderDone,
  deleteReminder,
  isPendingAndDueOrUpcoming,
  formatReminderForListTool,
} from './reminders';
```

- [ ] **Step 3: Update chat tools (`add_reminder`, `list_reminders`, `done_reminder`) in hooks.ts**

Find the tool implementations (currently around hooks.ts ~2700-2740). Replace the `add_reminder` body:

```ts
if (name === 'add_reminder') {
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) return { content: 'Manglede tekst.', isError: true };
  const dueRaw = typeof input.due_at === 'string' ? input.due_at : undefined;
  const due = dueRaw ? new Date(dueRaw) : null;
  const dueClean = due && !Number.isNaN(due.getTime()) ? due : null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const userId = ctx.userId;
  if (!userId) return { content: 'Ikke logget ind.', isError: true };
  const r = await addReminder(userId, text, dueClean, tz);
  return { content: `Oprettet påmindelse ${r.id}: "${r.text}"${r.dueAt ? ` til ${r.dueAt.toISOString()}` : ''}.`, isError: false };
}
```

Replace `list_reminders` body:
```ts
if (name === 'list_reminders') {
  const userId = ctx.userId;
  if (!userId) return { content: 'Ikke logget ind.', isError: true };
  const all = await listAllReminders(userId);
  const now = new Date();
  const rs = all.filter((r) => isPendingAndDueOrUpcoming(r, now));
  if (rs.length === 0) return { content: 'Ingen påmindelser gemt.', isError: false };
  return { content: rs.map(formatReminderForListTool).join('\n'), isError: false };
}
```

If `done_reminder` exists, replace its body to call `markReminderDone(id)`. (Confirm by grepping `done_reminder` in hooks.ts.)

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

If `ctx.userId` is missing, add it to the `ChatCtx` type — chat-tools.ts has the canonical definition (parallel session may have changed shape; reconcile).

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: existing tests still pass; new `reminders.test.ts` tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/memory-store.ts src/lib/hooks.ts
git commit -m "refactor(reminders): chat tools + useReminders use server-backed module"
```

### Task 5: Stub out `scheduleReminderNotification` in `notifications.ts`

The client no longer schedules local notifications for reminders — the server-side cron handles fire. Keep the function as a no-op stub so callers don't crash if any survive the refactor; remove fully in Phase 6.

**Files:**
- Modify: `src/lib/notifications.ts`

- [ ] **Step 1: Replace `scheduleReminderNotification` body with a no-op**

Find the existing function (~line 124) and replace its body:

```ts
export async function scheduleReminderNotification(reminder: Reminder): Promise<void> {
  // SERVER-SIDE FIRE — no-op on client. The reminders-fire cron pushes
  // notifications via Expo. This function is kept as a stub through
  // one release cycle for any stale callers; remove in Phase 6.
  void reminder;
}
```

Leave `cancelReminderNotification` intact — useful for cancelling locally-scheduled nudges that may still exist from older builds.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add src/lib/notifications.ts
git commit -m "refactor(notifications): scheduleReminderNotification is a no-op (server fires)"
```

---

## Phase 2 — Server-side fire cron

### Task 6: Write the `reminders-fire` Edge Function

**Files:**
- Create: `supabase/functions/reminders-fire/index.ts`
- Create: `supabase/functions/reminders-fire/deno.json`

Selects all reminders where `due_at <= now() AND completed = false AND fired_at IS NULL`. For each, sends an Expo push (matching the daily-brief push format) and stamps `fired_at`. Idempotent — a second cron tick within the same minute won't double-fire because `fired_at` is now set.

- [ ] **Step 1: Write `index.ts`**

```ts
// supabase/functions/reminders-fire/index.ts
//
// Cron-driven reminder firing. Replaces client-side expo-notifications
// scheduling, which proved unreliable (settings hydrate race, OS
// permission revoke, app deleted before due time, etc.).
//
// Idempotency: fired_at gets stamped before push send. Two ticks
// hitting the same row would race only if one finishes between the
// other's SELECT and UPDATE; the .is('fired_at', null) filter on the
// UPDATE makes the second a no-op.
//
// Deploy with --no-verify-jwt: ES256 keys, manual cron-secret check.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 50;

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!supabaseUrl || !serviceKey || !cronSecret) {
    return json({ error: 'missing env' }, 500);
  }
  const presented = req.headers.get('x-cron-secret');
  if (presented !== cronSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: due, error } = await client
    .from('reminders')
    .select('id, user_id, title, due_at')
    .lte('due_at', new Date().toISOString())
    .eq('completed', false)
    .is('fired_at', null)
    .order('due_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    console.error('[reminders-fire] select failed:', error.message);
    return json({ error: 'db error' }, 500);
  }

  const rows = (due ?? []) as Array<{
    id: string; user_id: string; title: string; due_at: string;
  }>;
  if (rows.length === 0) return json({ processed: 0 });

  // Group reminders by user so we can send one push per user even if
  // they have multiple due at the same minute. Keep the title list short
  // — first one becomes the headline, count goes in the body.
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }

  let pushed = 0;
  for (const [userId, userRows] of byUser) {
    const tokens = await loadTokens(client, userId);
    if (tokens.length > 0) {
      const ok = await sendPush(tokens, userRows);
      if (ok) pushed += userRows.length;
    }
    // Stamp fired_at regardless of push success — failed pushes don't
    // get retried. The cost of double-pushing is worse than missing
    // one. Reminders with broken tokens get marked fired so we don't
    // hammer Expo on every cron tick for a dead device.
    await client
      .from('reminders')
      .update({ fired_at: new Date().toISOString() })
      .in('id', userRows.map((r) => r.id))
      .is('fired_at', null);
  }

  console.log(JSON.stringify({ kind: 'reminders-fire', processed: rows.length, pushed }));
  return json({ processed: rows.length, pushed });
});

async function loadTokens(client: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  return (data ?? []).map((r) => (r as { token: string }).token);
}

async function sendPush(
  tokens: string[],
  reminders: Array<{ id: string; title: string }>,
): Promise<boolean> {
  const headline = reminders[0].title;
  const body = reminders.length === 1
    ? headline
    : `${headline}\n+ ${reminders.length - 1} flere påmindelser`;
  const messages = tokens.map((token) => ({
    to: token,
    title: 'Påmindelse fra Zolva',
    body,
    sound: 'default',
    data: {
      type: 'reminder',
      reminderId: reminders[0].id,
    },
  }));
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
    return res.ok;
  } catch (err) {
    console.warn('[reminders-fire] push send failed:', err);
    return false;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Write `deno.json`**

```json
{
  "imports": {}
}
```

- [ ] **Step 3: Deploy with `--no-verify-jwt`**

```bash
supabase functions deploy reminders-fire --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

Expected: deploy succeeds, function shows in dashboard.

- [ ] **Step 4: Curl-smoke-test (no auth, expect 401)**

```bash
curl -sS -X POST -w "\nHTTP %{http_code}\n" \
  https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/reminders-fire
```

Expected: `{"error":"unauthorized"}` HTTP 401.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/reminders-fire/
git commit -m "feat(edge): reminders-fire cron sends pushes for due reminders"
```

### Task 7: Schedule the cron job

**Files:**
- Create: `supabase/schedule-reminders-fire.sql.template` (held back from prod — user installs)

Mirrors the existing `daily-brief-15min` and `poll-mail-every-min` patterns. One job, runs every minute.

- [ ] **Step 1: Write the template**

```sql
-- supabase/schedule-reminders-fire.sql.template
--
-- pg_cron schedule for reminders-fire. Held back from migrations because
-- the secret values must be supplied per-environment by the operator —
-- they don't belong in the repo.
--
-- Replace <SERVICE_ROLE_SECRET> and <CRON_SHARED_SECRET> with the actual
-- values from the Supabase dashboard before applying.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reminders-fire-every-min') THEN
    PERFORM cron.unschedule('reminders-fire-every-min');
  END IF;
END
$$;

SELECT cron.schedule(
  'reminders-fire-every-min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://sjkhfkatmeqtsrysixop.functions.supabase.co/reminders-fire',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_SECRET>',
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SHARED_SECRET>'
    ),
    body := '{"source":"cron"}'::jsonb
  ) AS request_id;
  $$
);
```

- [ ] **Step 2: Apply manually via MCP `execute_sql`**

Substitute the real secrets (look at the existing daily-brief cron job's `command` text via `SELECT command FROM cron.job WHERE jobname = 'daily-brief-15min'` and copy the exact bearer + cron-secret values).

- [ ] **Step 3: Verify cron registered**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'reminders-fire-every-min';
```

Expected: one row, schedule `* * * * *`, active `true`.

- [ ] **Step 4: Commit template**

```bash
git add supabase/schedule-reminders-fire.sql.template
git commit -m "feat(cron): schedule template for reminders-fire-every-min"
```

### Task 8: End-to-end verification on a test reminder

- [ ] **Step 1: Insert a test reminder via MCP `execute_sql`**

```sql
INSERT INTO public.reminders (user_id, title, due_at)
VALUES ('<your-user-id>', 'TEST: cron fire',
        now() + interval '90 seconds')
RETURNING id, due_at;
```

- [ ] **Step 2: Wait 2-3 minutes; verify push received on device + `fired_at` stamped**

```sql
SELECT id, title, due_at, fired_at FROM public.reminders
WHERE id = '<the-id-above>';
```

Expected: `fired_at` is non-null. Push notification appeared on the device.

- [ ] **Step 3: Clean up**

```sql
DELETE FROM public.reminders WHERE id = '<the-id-above>';
```

---

## Phase 3 — Voice integration

### Task 9: Add `create_reminder` tool to widget-action's Claude call

**Files:**
- Modify: `supabase/functions/widget-action/claude.ts`

The voice path currently forces `tool_choice: { type: 'tool', name: 'create_calendar_event' }`. Switching to `auto` lets Claude pick — but we need to update the system prompt so it knows when to pick which.

- [ ] **Step 1: Update `claude.ts` to define both tools**

Replace the existing `TOOL` constant + the `tools` / `tool_choice` arguments to the Anthropic call. Schema:

```ts
const TOOLS = [
  {
    name: 'create_calendar_event',
    description: 'Brug når brugeren vil have et MØDE eller en KALENDERBEGIVENHED med en konkret start- og sluttid. Eksempler: "sæt et møde i morgen kl. 17", "bord 19:30 hos Mami", "tandlæge tirsdag 10". Skal IKKE bruges til påmindelser uden mødelogik.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'kort titel' },
        start: { type: 'string', description: "ISO 8601 med offset i brugerens tidszone" },
        end: { type: 'string', description: 'OPTIONAL — server defaulter hvis udeladt' },
        calendar_label: {
          type: ['string', 'null'],
          enum: ['work', 'personal', null],
          description: 'kun hvis brugeren nævnte en specifik kalender',
        },
        prompt_language: { type: 'string', enum: ['da', 'en', 'unknown'] },
      },
      required: ['title', 'start', 'calendar_label', 'prompt_language'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_reminder',
    description: 'Brug når brugeren vil have en PÅMINDELSE — typisk indledet med "husk mig på", "remind me to", "minder mig om", uden mødelogik. Eksempler: "husk mig på at ringe til mor kl. 17", "remind me to take meds at 8". Skal IKKE bruges til møder.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'påmindelsesteksten — kort og handlingsorienteret' },
        due_at: {
          type: ['string', 'null'],
          description: "ISO 8601 med tidszone-offset, eller null hvis brugeren ikke nævnte et tidspunkt",
        },
        prompt_language: { type: 'string', enum: ['da', 'en', 'unknown'] },
      },
      required: ['text', 'prompt_language'],
      additionalProperties: false,
    },
  },
];

export type ClaudeExtractionEvent = {
  kind: 'event';
  title: string;
  start: string;
  end?: string;
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeExtractionReminder = {
  kind: 'reminder';
  text: string;
  due_at: string | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeExtraction = ClaudeExtractionEvent | ClaudeExtractionReminder;
```

Replace the existing `extractEvent` function. Rename to `extractAction` and let it return either kind:

```ts
export async function extractAction(
  prompt: string,
  timezone: string,
): Promise<{ extraction: ClaudeExtraction; usage: ClaudeUsage; model: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT(timezone, new Date().toISOString()),
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as {
    content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const toolUse = body.content.find((c) => c.type === 'tool_use');
  if (!toolUse?.input || !toolUse.name) {
    throw new Error('claude returned no tool_use block');
  }

  let extraction: ClaudeExtraction;
  if (toolUse.name === 'create_calendar_event') {
    extraction = { kind: 'event', ...(toolUse.input as Omit<ClaudeExtractionEvent, 'kind'>) };
  } else if (toolUse.name === 'create_reminder') {
    extraction = { kind: 'reminder', ...(toolUse.input as Omit<ClaudeExtractionReminder, 'kind'>) };
  } else {
    throw new Error(`unknown tool ${toolUse.name}`);
  }

  return {
    extraction,
    usage: { input: body.usage.input_tokens, output: body.usage.output_tokens },
    model: body.model,
  };
}
```

Update the system prompt to disambiguate:

```ts
const SYSTEM_PROMPT = (tz: string, nowIso: string) => `Du parser én anmodning fra brugeren — enten en kalenderbegivenhed eller en påmindelse.

Den nuværende dato og tid er ${nowIso}. Brugerens tidszone er ${tz}. Brug dette til at opløse alle relative datoer ("i morgen", "om to dage", "next Monday") — ALDRIG fra din egen træningsdata-cutoff.

Vælg ÉT værktøj:
- create_calendar_event: når brugeren vil have et MØDE / kalenderbegivenhed med start- og sluttid.
- create_reminder: når brugeren vil have en PÅMINDELSE (typisk "husk mig på", "remind me to") uden mødelogik.

Tvivl-håndtering: hvis prompten kun indeholder en handling og et tidspunkt ("ring til mor kl. 17"), foretræk create_reminder. Hvis der er en eksplicit møde-kontekst ("møde med", "frokost med", "appointment", "session"), foretræk create_calendar_event.

Tvetydig tid: for "kl. 5" / "5 o'clock" / "fem" uden AM/PM-kontekst, vælg det næste rimelige tidspunkt i 07-22-vinduet. Dansk "klokken fem" betyder typisk 17:00.

Rapportér også det opdagede sprog ('da' / 'en' / 'unknown').`;
```

- [ ] **Step 2: Update `index.ts` to handle both extraction kinds**

Find the existing `extractEvent` import and the call site (currently around index.ts:120). Replace with `extractAction`. Branch on `extraction.kind`:

```ts
const { extraction, usage, model } = await extractAction(prompt, timezone);

if (extraction.kind === 'reminder') {
  // Persist directly to public.reminders. RLS doesn't apply here
  // because we use the service-role client — but we explicitly set
  // user_id from the verified JWT, NOT from the Claude output.
  const dueAt = extraction.due_at ? new Date(extraction.due_at) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) {
    return json(200, unparseable());
  }
  const { data: inserted, error } = await supabaseClient
    .from('reminders')
    .insert({
      user_id: userId,
      title: extraction.text,
      due_at: (dueAt ?? new Date('2099-12-31T00:00:00Z')).toISOString(),
      scheduled_for_tz: timezone,
    })
    .select('id, due_at')
    .single();
  if (error) {
    console.error('[widget-action] reminder insert failed:', error.message);
    return json(200, provider5xx('icloud'));  // generic server-side fail
  }
  console.log(JSON.stringify({
    action: 'create_reminder', user_id: userId, success: true,
    reminder_id: inserted.id, due_iso: inserted.due_at,
  }));
  return json(200, reminderCreated(extraction, timezone));
}

// existing event-creation flow continues here, unchanged from current
// (selection, write, response build, etc.)
```

- [ ] **Step 3: Add `reminderCreated` to responses.ts**

```ts
export function reminderCreated(
  ext: { text: string; due_at: string | null; prompt_language: 'da' | 'en' | 'unknown' },
  timezone: string,
): WidgetActionResponse {
  const isEnglish = ext.prompt_language === 'en';
  const due = ext.due_at ? new Date(ext.due_at) : null;
  const timePart = due
    ? ' ' + naturalTime(due, timezone, ext.prompt_language === 'en' ? 'en' : 'da')
    : '';
  const verb = isEnglish ? "I'll remind you" : 'Jeg minder dig om';
  const dialog = `${verb} ${ext.text.toLowerCase()}${timePart}.`;
  const summary = `${ext.text}${timePart}`;
  return {
    dialog,
    snippet: { mood: 'happy', summary, deepLink: 'zolva://memory' },
  };
}
```

- [ ] **Step 4: Deploy widget-action**

```bash
supabase functions deploy widget-action --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```

- [ ] **Step 5: Manual on-device test**

"Hey Siri, Zolva husk mig på at ringe mor kl. 17"

Expected: snippet shows happy Stone, dialog "Jeg minder dig om at ringe mor i dag kl. sytten." Reminder appears in `public.reminders` for the user. Push fires at 17:00.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/widget-action/
git commit -m "feat(edge): widget-action voice supports create_reminder branch"
```

---

## Phase 4 — AsyncStorage migration

### Task 10: One-time migrate AsyncStorage reminders to server

**Files:**
- Modify: `App.tsx` (or wherever auth state hydrates — look for `migrateAsyncStorageToSecureStore` calls in auth.ts and add the reminder migration in the same boot path)

We do this once per user, gated by a flag. Existing AsyncStorage reminders (text, dueAt, status, createdAt) get inserted into `public.reminders`. After successful migration, the local key is deleted.

- [ ] **Step 1: Add a migration function to `src/lib/reminders.ts`**

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

const REMINDERS_LEGACY_KEY = (uid: string) => `zolva.${uid}.memory.reminders`;
const MIGRATION_FLAG = (uid: string) => `zolva.${uid}.migration.reminders-server.v1`;

export async function migrateLocalRemindersToServer(userId: string): Promise<void> {
  if (!userId) return;
  const flag = await AsyncStorage.getItem(MIGRATION_FLAG(userId));
  if (flag) return;

  try {
    const raw = await AsyncStorage.getItem(REMINDERS_LEGACY_KEY(userId));
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{
        id: string; text: string; dueAt?: string; status?: 'pending' | 'done'; createdAt?: string;
      }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const rows = parsed
          .filter((r) => r.status !== 'done')  // skip already-done; not worth migrating
          .map((r) => ({
            user_id: userId,
            title: r.text,
            due_at: r.dueAt ? new Date(r.dueAt).toISOString() : new Date('2099-12-31T00:00:00Z').toISOString(),
            // No scheduled_for_tz — original captured device tz at create time, lost.
          }));
        if (rows.length > 0) {
          await supabase.from('reminders').insert(rows);
        }
      }
      await AsyncStorage.removeItem(REMINDERS_LEGACY_KEY(userId));
    }
    await AsyncStorage.setItem(MIGRATION_FLAG(userId), '1');
  } catch (err) {
    if (__DEV__) console.warn('[reminders] migration failed:', err);
    // Don't set the flag — retry on next boot.
  }
}
```

- [ ] **Step 2: Call from auth boot path (auth.ts) after session resolves**

In `src/lib/auth.ts`, find the existing init `(async () => { ... })()` block (currently around line 186), and add the migration call after `data.session?.user?.id` is known:

```ts
if (uid) {
  loadProviderTokens(uid);
  ensurePushTokenListener();
  void registerPushToken();
  void migrateLocalRemindersToServer(uid);  // NEW: one-time per user
}
```

Add the import at the top:
```ts
import { migrateLocalRemindersToServer } from './reminders';
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/lib/reminders.ts src/lib/auth.ts
git commit -m "feat(reminders): one-time AsyncStorage → server migration on auth boot"
```

---

## Phase 5 — QA + checklist update

### Task 11: Update widget-v2-qa-checklist.md with voice-reminder cases

**Files:**
- Modify: `docs/superpowers/plans/widget-v2-qa-checklist.md`

- [ ] **Step 1: Append a new section after the existing voice-trigger cases**

```markdown
## Voice — reminder branch

- [ ] "Hey Siri, Zolva husk mig på at ringe mor kl. 17"
       Expected: snippet says "Jeg minder dig om at ringe mor i dag kl. sytten."
       Reminder appears in public.reminders with the correct due_at.
- [ ] "Hey Siri, Zolva remind me to take meds at 8 pm"
       Expected: snippet in English; reminder created.
- [ ] "Hey Siri, Zolva sæt et møde i morgen kl. 17"
       Expected: STILL routes to create_calendar_event (event branch); not
       create_reminder. Calendar event lands in iCloud as before.
- [ ] At the reminder's due time: push notification fires from
       reminders-fire cron, NOT from the device (kill the app first to
       confirm the push reaches it).
- [ ] After push tap: deeplink lands on Memory tab (zolva://memory).

## Server-side reminders DB spot-check

- [ ] After voice creates a reminder:
       SELECT id, title, due_at, fired_at, scheduled_for_tz
       FROM public.reminders
       WHERE user_id = '<user>' ORDER BY created_at DESC LIMIT 5;
       Expected: row exists, fired_at is null, scheduled_for_tz matches
       the user's locale tz.
- [ ] After the cron has fired:
       fired_at is non-null, push delivered to device.
- [ ] Reminders-fire idempotency: manually update fired_at back to null
       (DEV ONLY); next cron tick re-fires once and re-stamps.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/widget-v2-qa-checklist.md
git commit -m "docs(qa): add voice-reminder + server-fire cases"
```

---

## Phase 6 — Cleanup (deferrable to a follow-up commit cycle)

### Task 12: Remove `scheduleReminderNotification` no-op + dead AsyncStorage paths

Run after the migration has been live for ≥1 release cycle. Defer if not yet shipped.

**Files:**
- Modify: `src/lib/notifications.ts` (remove the no-op function entirely)
- Modify: `src/lib/memory-store.ts` (remove `scheduleReminderNotification` import if any)
- Modify: any caller of `scheduleReminderNotification` — drop the call

- [ ] **Step 1: Grep for callers**

```bash
grep -rn "scheduleReminderNotification" src/
```

Each caller is dead code post-migration. Remove the call entirely.

- [ ] **Step 2: Delete the function from `notifications.ts`**

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add -A
git commit -m "chore(reminders): drop dead scheduleReminderNotification + callers"
```

---

## Self-review

**Spec coverage:**
- Voice creates reminders → Tasks 9 (Claude tools + index.ts branch)
- Reminders fire reliably from server → Tasks 6 + 7 (edge function + cron)
- Calendar voice path still works → Task 9 (auto tool choice + system prompt disambiguation)
- Existing reminders preserved → Task 10 (migration)
- Chat list shows fresh-only → already shipped (commit dca8215); reused via `isPendingAndDueOrUpcoming` in Task 3

**No placeholders:** every code-shipping step has actual code blocks. Every command has expected output.

**Type consistency:**
- `Reminder` shape extended in Task 3, used in Tasks 4, 5, 9, 10 — all match.
- `ClaudeExtraction` discriminated union: `kind: 'event' | 'reminder'` defined in Task 9, branched in widget-action `index.ts`.
- `WidgetActionResponse.snippet.mood`: `happy` for the success case (Task 9), matches existing happy-path in event branch.

**Held-back-files reminder (final pass):**

Before merging this branch:
```bash
git status
```
Expected: clean. If any of `src/lib/auth.ts`, `src/lib/chat-tools.ts`, `src/lib/gmail.ts`, `src/lib/google-calendar.ts`, `src/lib/google-drive.ts`, `src/lib/hooks.ts` show unstaged from a parallel session, surface them before merging — do not bundle them into a reminders commit.
