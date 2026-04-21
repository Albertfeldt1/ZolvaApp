# Daily Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the daily-brief feature from `docs/superpowers/specs/2026-04-21-daily-brief-design.md` — a Supabase-cron-scheduled morning (and optional evening) brief that composes calendar + unread mail + commitments + reminders + Met.no weather into a Danish summary, delivered via push notification and as a hero banner on the Today screen.

**Architecture:** One new Supabase Edge Function (`daily-brief`) runs every 15 min via Supabase Cron. It walks users whose brief time falls in the current window, aggregates per-user context, calls Claude via a service-role helper, stores the brief in a new `briefs` table, and sends a push. On the client, `useTodayBrief` reads today's brief and renders a hero banner above "Hvad jeg har bemærket". A dead `day-overview` preference row is removed and a real `evening-brief` row is added alongside the existing `morning-brief` row.

**Tech Stack:** Supabase Edge Functions (Deno), Supabase Cron (pg_cron), Met.no locationforecast API, existing `claude-proxy`, Expo push (already wired for mail). No new client dependencies.

**Depends on:** `2026-04-21-persistent-memory.md` (the brief reads `facts.category='commitment'` and may surface recent `mail_events`). Ship memory first; enable the memory feature flag before running Task 7's verification.

## Testing note

Same convention as the memory plan: no unit test framework, typecheck gate per task, manual device verification. Edge-function logic is verified by invoking the function directly with curl + inspecting the resulting DB rows and push notifications.

## Prerequisites

- Memory feature plan is implemented through Task 6 (`profile-store.ts` exists — the brief reads `facts`).
- `claude-proxy` edge function is deployed with `--no-verify-jwt`.
- Supabase project has `pg_cron` available (Dashboard → Database → Extensions → enable if not already on).
- A dev build on a physical device for Task 7.

## File map

**Create:**
- `supabase/functions/daily-brief/index.ts` — the scheduled composer + push dispatcher.
- `supabase/functions/daily-brief/weather.ts` — thin Met.no client.
- `supabase/functions/daily-brief/compose.ts` — Danish composer prompt + aggregation helpers.
- `supabase/migrations/2026-04-21-briefs.sql` — `briefs` table + RLS + `pg_cron` schedule.
- `src/components/BriefBanner.tsx` — Today screen hero banner.
- `src/lib/briefs.ts` — `useTodayBrief` hook, `markBriefRead(id)`.

**Modify:**
- `src/lib/hooks.ts:1003-1008` — delete the dead `day-overview` preference row. Add `evening-brief` row. Update the union type in `src/lib/types.ts:113-115`.
- `src/screens/TodayScreen.tsx` — render `<BriefBanner />` above the observations section.
- `src/screens/SettingsScreen.tsx:388` — remove the stale `Morgenoverblik kl. 8` hardcoded label; rely on the preference UI.
- `App.tsx` — push notification tap handler: when `data.kind === 'brief'`, route to Today.

## Task 1: `briefs` table + pg_cron schedule

**Files:**
- Create: `supabase/migrations/2026-04-21-briefs.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-04-21-briefs.sql`:

```sql
create table if not exists public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('morning','evening')),
  headline text not null,
  body jsonb not null,
  weather jsonb,
  tone text check (tone in ('calm','busy','heads-up')),
  generated_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz
);

create unique index if not exists briefs_user_kind_day_idx
  on public.briefs (user_id, kind, (generated_at::date));

create index if not exists briefs_user_generated_idx
  on public.briefs (user_id, generated_at desc);

alter table public.briefs enable row level security;

create policy "briefs owner access" on public.briefs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Every 15 minutes, invoke the daily-brief edge function via pg_net.
-- Replace <project-ref> below in the real migration if you move projects.
select cron.schedule(
  'daily-brief-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://sjkhfkatmeqtsrysixop.functions.supabase.co/daily-brief',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source":"cron"}'::jsonb
  ) as request_id;
  $$
);
```

- [ ] **Step 2: Apply the migration**

Paste the entire file into Supabase Dashboard → SQL Editor → New query → Run. Confirm:
- Table Editor shows `briefs` with RLS Enabled and one policy.
- Database → Cron shows `daily-brief-15min` scheduled `*/15 * * * *`.

Before the cron can post successfully, set `app.settings.service_role_key` via Dashboard → Settings → Database → Custom Parameters (or as a session variable in a one-off SQL statement). Alternately, the edge function itself can be deployed `--no-verify-jwt` and the cron can omit the auth header — use whichever matches the project's existing secret-handling pattern (`poll-mail` is a reference).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-04-21-briefs.sql
git commit -m "feat(briefs): add briefs table, RLS, and pg_cron 15-min schedule"
```

---

## Task 2: Delete dead `day-overview`; add `evening-brief` preference

**Files:**
- Modify: `src/lib/types.ts:113-115`
- Modify: `src/lib/hooks.ts:1003-1008`
- Modify: `src/screens/SettingsScreen.tsx:388`

- [ ] **Step 1: Update the types union**

In `src/lib/types.ts`, find the `WorkPreferenceId` union (line 113–115) and replace:

```ts
export type WorkPreferenceId =
  | 'autonomy'
  | 'tone'
  | 'morning-brief'
  | 'quiet-hours'
  | 'evening-brief';
```

(Remove `'day-overview'`. Add `'evening-brief'`.)

- [ ] **Step 2: Update the default preferences array**

In `src/lib/hooks.ts`, find `DEFAULT_WORK_PREFERENCES` (around line 970) and replace the `day-overview` entry (lines 1002–1008) with:

```ts
{
  id: 'evening-brief',
  title: 'Aftenoverblik',
  meta: 'Daglig opsummering kl. aften',
  value: 'Fra',
  options: ['Fra', '17.00', '18.00', '19.00'],
},
```

- [ ] **Step 3: Clean up SettingsScreen**

Find `src/screens/SettingsScreen.tsx:388`. The hardcoded `label="Morgenoverblik kl. 8"` row is stale — remove it if it's standalone, or update to show the live preference label if it's a preview of the value. Inspect the surrounding ~20 lines and adapt.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no errors. If errors appear in places that read `'day-overview'`, delete those reads (they're dead paths now).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/hooks.ts src/screens/SettingsScreen.tsx
git commit -m "feat(prefs): replace dead day-overview with real evening-brief row"
```

---

## Task 3: Met.no weather client (edge-function side)

**Files:**
- Create: `supabase/functions/daily-brief/weather.ts`

- [ ] **Step 1: Write the client**

Create `supabase/functions/daily-brief/weather.ts`:

```ts
const USER_AGENT = 'Zolva/1.0 feldten@me.com';

export type Weather = {
  tempC: number;
  highC: number;
  lowC: number;
  conditionLabel: string;
};

const CONDITION_LABELS: Record<string, string> = {
  clearsky: 'Klart vejr',
  fair: 'Fint vejr',
  partlycloudy: 'Delvist skyet',
  cloudy: 'Skyet',
  rainshowers: 'Regnbyger',
  rain: 'Regn',
  heavyrain: 'Kraftig regn',
  snow: 'Sne',
  fog: 'Tåge',
};

function normalizeSymbol(raw: string): string {
  return raw.replace(/_(day|night|polartwilight)$/, '').replace(/_/g, '').toLowerCase();
}

// 30-minute cache keyed by rounded lat/lng to keep us well under Met.no's rate.
const cache = new Map<string, { value: Weather; expiresAt: number }>();

export async function fetchWeather(lat: number, lng: number): Promise<Weather | null> {
  const key = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      properties: {
        timeseries: Array<{
          time: string;
          data: {
            instant: { details: { air_temperature: number } };
            next_1_hours?: { summary: { symbol_code: string } };
            next_6_hours?: { details: { air_temperature_max: number; air_temperature_min: number } };
          };
        }>;
      };
    };
    const series = data.properties?.timeseries ?? [];
    if (series.length === 0) return null;
    const now = series[0];
    const tempC = now.data.instant.details.air_temperature;
    const symbol = now.data.next_1_hours?.summary.symbol_code ?? 'cloudy';
    const label = CONDITION_LABELS[normalizeSymbol(symbol)] ?? 'Blandet vejr';
    const next6 = now.data.next_6_hours?.details;
    const highC = next6?.air_temperature_max ?? tempC;
    const lowC = next6?.air_temperature_min ?? tempC;
    const value: Weather = { tempC, highC, lowC, conditionLabel: label };
    cache.set(key, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/daily-brief/weather.ts
git commit -m "feat(daily-brief): Met.no locationforecast client with 30-min cache"
```

---

## Task 4: Brief composer (edge-function side)

**Files:**
- Create: `supabase/functions/daily-brief/compose.ts`

- [ ] **Step 1: Write the composer**

Create `supabase/functions/daily-brief/compose.ts`:

```ts
import { Weather } from './weather.ts';

export type BriefInputs = {
  kind: 'morning' | 'evening';
  name: string | null;
  events: Array<{ title: string; startIso: string; endIso: string; location?: string }>;
  unread: Array<{ from: string; subject: string }>;
  commitments: string[];
  reminders: Array<{ text: string; dueIso: string | null }>;
  weather: Weather | null;
};

export type BriefOutput = {
  headline: string;
  body: string[];
  tone: 'calm' | 'busy' | 'heads-up';
};

const SYSTEM =
  'Du er Zolva, en rolig dansk AI-assistent. Du skriver en kort, varm og handlingsorienteret ' +
  '{kind}-brief til brugeren. Svar altid på dansk. Max 3–5 sætninger i body. ' +
  'Vælg tone baseret på hvor presset dagen ser ud: "calm" (rolig), "busy" (pakket), "heads-up" (noget haster).';

const SCHEMA =
  '{"headline": string, "body": string[], "tone": "calm" | "busy" | "heads-up"}\n' +
  '- headline: en kort overskrift til push-notifikationen (under 60 tegn).\n' +
  '- body: 3–5 korte sætninger der opsummerer dagen.\n' +
  '- tone: matcher dagens pres.';

export function buildComposerMessage(inputs: BriefInputs): string {
  const eventLines = inputs.events.length === 0
    ? '(ingen møder)'
    : inputs.events
        .map((e) => `- ${e.startIso}–${e.endIso} ${e.title}${e.location ? ` @ ${e.location}` : ''}`)
        .join('\n');
  const unreadLine = inputs.unread.length === 0
    ? '(ingen ulæste)'
    : inputs.unread.slice(0, 3).map((m) => `- ${m.from}: ${m.subject}`).join('\n');
  const commitmentLines = inputs.commitments.length === 0
    ? '(ingen aktive løfter)'
    : inputs.commitments.map((c) => `- ${c}`).join('\n');
  const reminderLines = inputs.reminders.length === 0
    ? '(ingen påmindelser)'
    : inputs.reminders.map((r) => `- ${r.text}${r.dueIso ? ` (${r.dueIso})` : ''}`).join('\n');
  const weather = inputs.weather
    ? `Vejr: ${inputs.weather.tempC.toFixed(0)}°C, ${inputs.weather.conditionLabel} (høj ${inputs.weather.highC.toFixed(0)}°, lav ${inputs.weather.lowC.toFixed(0)}°)`
    : 'Vejr: ukendt';

  return [
    `Dagens briefing-type: ${inputs.kind}`,
    inputs.name ? `Bruger: ${inputs.name}` : '',
    `Møder:\n${eventLines}`,
    `Ulæste mails:\n${unreadLine}`,
    `Aktive løfter/aftaler:\n${commitmentLines}`,
    `Påmindelser:\n${reminderLines}`,
    weather,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export { SYSTEM as COMPOSER_SYSTEM, SCHEMA as COMPOSER_SCHEMA };
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/daily-brief/compose.ts
git commit -m "feat(daily-brief): Danish composer prompt + input serializer"
```

---

## Task 5: `daily-brief` edge function

**Files:**
- Create: `supabase/functions/daily-brief/index.ts`

- [ ] **Step 1: Write the edge function**

Create `supabase/functions/daily-brief/index.ts`:

```ts
// daily-brief — Supabase Edge Function (cron-driven, service-role).
//
// Flow:
// 1. Figure out current 15-min window in UTC converted to each user's local time.
// 2. For each user whose morning-brief or evening-brief time falls in-window
//    AND who has no briefs row today with that kind, compose a brief.
// 3. Insert into briefs, send push notification.
//
// Relies on service-role key for DB access. Never called from the client.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchWeather, Weather } from './weather.ts';
import { BriefInputs, BriefOutput, buildComposerMessage, COMPOSER_SCHEMA, COMPOSER_SYSTEM } from './compose.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5-20251001';

// Default location (Copenhagen) — user-specific location is v2.
const DEFAULT_LAT = 55.6761;
const DEFAULT_LNG = 12.5683;

function windowMatches(prefValue: string, nowHour: number, nowMin: number): boolean {
  if (!prefValue || prefValue === 'Fra') return false;
  const m = prefValue.match(/^(\d{1,2})\.(\d{2})$/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  // Fire if current time is within 15 min after the configured time.
  const nowTotal = nowHour * 60 + nowMin;
  const prefTotal = hour * 60 + minute;
  return nowTotal >= prefTotal && nowTotal < prefTotal + 15;
}

serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anthropicKey) {
    return json({ error: 'server misconfigured' }, 500);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const nowHour = now.getUTCHours(); // naive: treat all users as UTC for v1
  const nowMin = now.getUTCMinutes();
  // NOTE: v1 uses UTC because we don't have per-user timezone stored. For Danish
  // users this is off by 1–2 hours depending on DST. A follow-up task should
  // store user timezone in profile and shift here.

  // Fetch all users with a brief preference set.
  const { data: prefs, error: prefsErr } = await client
    .from('work_preferences') // adjust table name to match actual storage
    .select('user_id, id, value')
    .in('id', ['morning-brief', 'evening-brief']);
  if (prefsErr) {
    console.error('[daily-brief] prefs fetch error', prefsErr);
    return json({ error: 'db error' }, 500);
  }

  // NOTE: if work preferences are in AsyncStorage client-side (not in Supabase),
  // add a `work_preferences` table first or skip users without a row. See
  // Task 8 of the memory plan for the chat-sync pattern.

  const results: Array<{ userId: string; kind: string; status: string }> = [];
  for (const pref of prefs ?? []) {
    if (!windowMatches(pref.value as string, nowHour, nowMin)) continue;
    const kind = pref.id === 'morning-brief' ? 'morning' : 'evening';
    const outcome = await generateOneBrief(client, anthropicKey, pref.user_id as string, kind as 'morning' | 'evening');
    results.push({ userId: pref.user_id as string, kind, status: outcome });
  }

  return json({ processed: results.length, results });
});

async function generateOneBrief(
  client: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: string,
  kind: 'morning' | 'evening',
): Promise<string> {
  // Idempotency: skip if a brief already exists for user+kind+today.
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await client
    .from('briefs')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('generated_at', `${today}T00:00:00Z`)
    .limit(1);
  if (existing && existing.length > 0) return 'already-briefed';

  const inputs = await assembleInputs(client, userId, kind);
  // Skip "empty" briefs.
  const nonEmpty =
    inputs.events.length > 0 ||
    inputs.unread.length > 0 ||
    inputs.commitments.length > 0 ||
    inputs.reminders.length > 0;
  if (!nonEmpty) return 'empty-skipped';

  const brief = await composeWithClaude(anthropicKey, inputs);
  if (!brief) return 'compose-failed';

  const { data: inserted, error: insertErr } = await client
    .from('briefs')
    .insert({
      user_id: userId,
      kind,
      headline: brief.headline,
      body: brief.body,
      weather: inputs.weather,
      tone: brief.tone,
    })
    .select('id')
    .single();
  if (insertErr) return 'insert-failed';

  await sendPush(client, userId, kind, brief.headline, inserted.id as string);
  await client.from('briefs').update({ delivered_at: new Date().toISOString() }).eq('id', inserted.id);
  return 'sent';
}

async function assembleInputs(
  client: ReturnType<typeof createClient>,
  userId: string,
  kind: 'morning' | 'evening',
): Promise<BriefInputs> {
  const [commitmentsRes, mailRes, weather] = await Promise.all([
    client.from('facts').select('text').eq('user_id', userId).eq('status', 'confirmed').eq('category', 'commitment'),
    client.from('mail_events').select('provider_from, provider_subject').eq('user_id', userId).order('occurred_at', { ascending: false }).limit(3),
    fetchWeather(DEFAULT_LAT, DEFAULT_LNG),
  ]);

  // NOTE: calendar and reminders are local-only today. The edge function cannot
  // reach them. v1 ships without them on the server side — the Today banner can
  // still show them client-side via the existing hooks. Flag this in verification.

  return {
    kind,
    name: null,
    events: [],
    unread: (mailRes.data ?? []).map((r) => ({
      from: (r as Record<string, string>).provider_from ?? 'ukendt',
      subject: (r as Record<string, string>).provider_subject ?? '(intet emne)',
    })),
    commitments: (commitmentsRes.data ?? []).map((r) => (r as Record<string, string>).text as string),
    reminders: [],
    weather,
  };
}

async function composeWithClaude(anthropicKey: string, inputs: BriefInputs): Promise<BriefOutput | null> {
  const body = {
    model: MODEL,
    max_tokens: 512,
    temperature: 0.3,
    system: [
      { type: 'text', text: COMPOSER_SYSTEM.replace('{kind}', inputs.kind) + '\n' + COMPOSER_SCHEMA },
    ],
    messages: [{ role: 'user', content: buildComposerMessage(inputs) }],
  };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : []))
      .join('')
      .trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(cleaned) as BriefOutput;
  } catch {
    return null;
  }
}

async function sendPush(
  client: ReturnType<typeof createClient>,
  userId: string,
  kind: 'morning' | 'evening',
  headline: string,
  briefId: string,
): Promise<void> {
  const { data: tokens } = await client.from('push_tokens').select('token').eq('user_id', userId);
  if (!tokens || tokens.length === 0) return;

  const title = kind === 'morning' ? 'Morgenbrief fra Zolva' : 'Aftenbrief fra Zolva';
  const messages = tokens.map((t) => ({
    to: (t as Record<string, string>).token,
    title,
    body: headline,
    sound: 'default',
    data: { kind: 'brief', briefId },
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.warn('[daily-brief] push send failed', err);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy**

Run: `supabase functions deploy daily-brief --no-verify-jwt`

Expected: deployed confirmation.

- [ ] **Step 3: Manual invocation test**

Run:

```bash
curl -X POST https://sjkhfkatmeqtsrysixop.functions.supabase.co/daily-brief \
  -H "content-type: application/json" \
  -d '{"source":"manual"}'
```

Expected: response `{"processed": N, "results": [...]}` where N is 0 unless a user has a matching brief time in the current UTC 15-min window. A 200 response with `processed: 0` is fine — verifies the function runs without error.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/daily-brief/index.ts
git commit -m "feat(daily-brief): cron-driven edge function composes and pushes daily brief"
```

---

## Task 6: Client — `useTodayBrief` hook + banner + push routing

**Files:**
- Create: `src/lib/briefs.ts`
- Create: `src/components/BriefBanner.tsx`
- Modify: `src/screens/TodayScreen.tsx`
- Modify: `App.tsx` — push tap handler

- [ ] **Step 1: Write the hook**

Create `src/lib/briefs.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth';

export type Brief = {
  id: string;
  kind: 'morning' | 'evening';
  headline: string;
  body: string[];
  weather: { tempC: number; highC: number; lowC: number; conditionLabel: string } | null;
  tone: 'calm' | 'busy' | 'heads-up' | null;
  generatedAt: Date;
  readAt: Date | null;
};

function rowToBrief(r: Record<string, unknown>): Brief {
  return {
    id: r.id as string,
    kind: r.kind as 'morning' | 'evening',
    headline: r.headline as string,
    body: (r.body as string[]) ?? [],
    weather: (r.weather as Brief['weather']) ?? null,
    tone: (r.tone as Brief['tone']) ?? null,
    generatedAt: new Date(r.generated_at as string),
    readAt: r.read_at ? new Date(r.read_at as string) : null,
  };
}

export function useTodayBrief(): {
  brief: Brief | null;
  loading: boolean;
  markRead: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { user } = useAuth();
  const userId = user?.id;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) { setBrief(null); return; }
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('briefs')
        .select('*')
        .eq('user_id', userId)
        .gte('generated_at', `${today}T00:00:00Z`)
        .order('generated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0];
      setBrief(row ? rowToBrief(row as Record<string, unknown>) : null);
    } catch {
      setBrief(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const markRead = useCallback(async () => {
    if (!brief) return;
    await supabase.from('briefs').update({ read_at: new Date().toISOString() }).eq('id', brief.id);
    setBrief((prev) => (prev ? { ...prev, readAt: new Date() } : prev));
  }, [brief]);

  return { brief, loading, markRead, refresh };
}
```

- [ ] **Step 2: Write the banner component**

Create `src/components/BriefBanner.tsx`:

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { colors, fonts } from '../theme';
import type { Brief } from '../lib/briefs';

export function BriefBanner({ brief, onDismiss }: { brief: Brief; onDismiss: () => void }) {
  const weatherLine = brief.weather
    ? `${brief.weather.tempC.toFixed(0)}°C · ${brief.weather.conditionLabel}`
    : null;
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>
          {brief.kind === 'morning' ? 'Morgenbrief' : 'Aftenbrief'}
        </Text>
        <Pressable onPress={onDismiss} hitSlop={12}>
          <X size={16} color={colors.fg3} strokeWidth={1.75} />
        </Pressable>
      </View>
      <Text style={styles.headline}>{brief.headline}</Text>
      {brief.body.map((line, i) => (
        <Text key={i} style={styles.body}>{line}</Text>
      ))}
      {weatherLine && <Text style={styles.weather}>{weatherLine}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: 16,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.sageSoft,
    gap: 6,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  headline: {
    fontFamily: fonts.displayItalic, fontSize: 22, letterSpacing: -0.32,
    color: colors.ink, marginTop: 4,
  },
  body: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.fg2 },
  weather: { marginTop: 8, fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
});
```

- [ ] **Step 3: Render the banner in TodayScreen**

In `src/screens/TodayScreen.tsx`, near the existing hook calls (around line 61–67):

```ts
const { brief, markRead } = useTodayBrief();
```

Just above the dark "Hvad jeg har bemærket" section, conditionally render:

```tsx
{brief && !brief.readAt && (
  <BriefBanner brief={brief} onDismiss={() => { void markRead(); }} />
)}
```

Add the imports for `useTodayBrief` and `BriefBanner`.

- [ ] **Step 4: Push tap routing**

In `App.tsx`, find the existing Expo notification response listener (from the notifications-foundation plan). Inside the handler, detect `data.kind === 'brief'` and route to the Today tab. Adjust to match the existing routing pattern — likely a `setActiveTab('today')` or navigation call.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/briefs.ts src/components/BriefBanner.tsx src/screens/TodayScreen.tsx App.tsx
git commit -m "feat(daily-brief): client banner, useTodayBrief hook, push tap routing"
```

---

## Task 7: Manual end-to-end verification on device

**Prerequisites:** Memory feature flag on and memory enabled for the test user, because the brief composer reads `facts`. A dev build running on a physical device. An active `morning-brief` preference time.

- [ ] **Step 1: Seed a confirmed commitment**

On the dev device, chat with Zolva: *"Jeg har lovet Maria en draft i dag"*. Wait for the pending-fact row in Today, tap *Ja, husk det*. Verify it lands in `facts` with `category='commitment'`, `status='confirmed'`.

- [ ] **Step 2: Force a brief generation**

Adjust your `morning-brief` value to the next upcoming 15-min UTC window (check Dashboard → Functions → daily-brief logs to confirm the window).

Wait for the cron (or trigger manually):

```bash
curl -X POST https://sjkhfkatmeqtsrysixop.functions.supabase.co/daily-brief -d '{"source":"manual"}'
```

Expected: `processed` ≥ 1, `results[*].status === 'sent'`.

- [ ] **Step 3: Verify the brief row**

In Supabase Table Editor → `briefs`, confirm a new row exists for your user with today's date, non-empty `body`, non-null `weather`, and `delivered_at` set.

- [ ] **Step 4: Verify push + banner**

- Push notification arrives on the device within ~60s of the cron hit. Tapping it opens the Today screen.
- Today screen shows the `BriefBanner` at the top of the scroll, above "Hvad jeg har bemærket", with the headline, 3–5 sentence body, and a weather line.
- Tap the X. Banner disappears, `briefs.read_at` is set, banner stays gone on subsequent Today mounts.

- [ ] **Step 5: Idempotency**

Invoke the cron endpoint a second time within the same day. Confirm no duplicate `briefs` row, and log output for that user says `already-briefed`.

- [ ] **Step 6: Empty-day**

Temporarily delete all `facts`, `mail_events`, and disable the test user's calendar. Trigger the cron. Confirm the response shows `empty-skipped` for that user and no `briefs` row is created and no push is sent.

- [ ] **Step 7: Final commit (if any remaining edits)**

```bash
git add -A
git commit -m "chore(daily-brief): verification pass — manual e2e on device"
```

---

## Known limitations / follow-ups

- **No per-user timezone.** The cron matches UTC hours to the user's preference value, so Danish users will receive briefs 1–2 hours off from their local-time setting. Add a `timezone` column to `user_preferences` and shift in `windowMatches`.
- **No per-user location.** Weather is hardcoded to Copenhagen; a location picker is v2.
- **Work preferences are AsyncStorage-only today.** Task 5's `assembleInputs` reads from a `work_preferences` table that doesn't yet exist; if the existing app keeps preferences in AsyncStorage, either (a) migrate preferences to Supabase as a prerequisite follow-up task, or (b) store the brief times on the user profile row directly. Either approach is acceptable; pick whichever fits the evening-brief preference work naturally.
- **Calendar/reminder data is local-only.** Server-side cannot reach them, so the brief body ignores meetings and reminders in v1. When calendar sync lands in Supabase, extend `assembleInputs`.
- **Reply-event trigger.** The memory spec mentions `replied` as a mail event; v1 still doesn't detect it.

## Out-of-scope (do not add to this plan)

- Interactive brief actions (draft reply, mark commitment done).
- Brief history archive screen.
- Content-type preferences ("skip weather").
- Midday brief option.
- Custom push sounds.
