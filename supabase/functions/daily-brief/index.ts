// daily-brief — Supabase Edge Function (cron-driven, service-role).
//
// Flow:
//   1. Match current UTC 15-min window against work_preferences rows for
//      morning-brief / evening-brief.
//   2. For each matching user who doesn't already have today's brief of
//      that kind, assemble context (commitments from facts, recent mail
//      events, weather), compose via Claude, insert the brief row, and
//      send a push notification.
//
// CALLER GATING (same pattern as poll-mail):
//   - Cron — must present `x-cron-secret: <CRON_SHARED_SECRET>`. Full batch.
//   - Authenticated user — must present a valid user JWT. Batch scoped to
//     that user only (useful for manual "trigger mine now" tests).
//   - Anything else → 401.
//
// The function runs with the service-role internally so it can read facts
// and mail_events for every user, but the caller gate above prevents any
// authenticated user from triggering a full-fleet Claude call.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchWeather, Weather } from './weather.ts';
import { fetchCalendarForUser } from '../_shared/calendar.ts';
import {
  BriefInputs,
  BriefOutput,
  buildComposerMessage,
  COMPOSER_SCHEMA,
  COMPOSER_SYSTEM,
} from './compose.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5-20251001';

// Default location (Copenhagen). Per-user location is a v2 follow-up.
const DEFAULT_LAT = 55.6761;
const DEFAULT_LNG = 12.5683;

type PrefRow = { user_id: string; id: string; value: string };

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  if (!supabaseUrl || !serviceKey || !anonKey || !anthropicKey) {
    return json({ error: 'missing env' }, 500);
  }

  const presentedSecret = req.headers.get('x-cron-secret');
  const isCron = !!cronSecret && presentedSecret === cronSecret;
  console.log('[daily-brief][debug]', {
    cronSecretSet: !!cronSecret,
    cronSecretLen: cronSecret?.length ?? 0,
    presentedSet: !!presentedSecret,
    presentedLen: presentedSecret?.length ?? 0,
    match: isCron,
  });

  let scopedUserId: string | null = null;
  if (!isCron) {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'unauthorized' }, 401);
    }
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: 'unauthorized' }, 401);
    }
    scopedUserId = userData.user.id;
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();

  let prefsQuery = client
    .from('work_preferences')
    .select('user_id, id, value')
    .in('id', ['morning-brief', 'evening-brief']);
  if (scopedUserId) {
    prefsQuery = prefsQuery.eq('user_id', scopedUserId);
  }
  const { data: prefs, error: prefsErr } = await prefsQuery;
  if (prefsErr) {
    console.error('[daily-brief] prefs fetch error', prefsErr);
    return json({ error: 'db error' }, 500);
  }

  const prefRows = (prefs ?? []) as PrefRow[];
  const userIds = Array.from(new Set(prefRows.map((p) => p.user_id)));
  const zoneByUser = userIds.length > 0 ? await fetchZones(client, userIds) : new Map<string, string>();

  const results: Array<{ userId: string; kind: string; status: string }> = [];
  for (const pref of prefRows) {
    const tz = zoneByUser.get(pref.user_id) ?? 'UTC';
    const local = localHourMinute(now, tz);
    if (!windowMatches(pref.value, local.hour, local.minute)) continue;
    const kind = pref.id === 'morning-brief' ? 'morning' : 'evening';
    const status = await generateOneBrief(client, anthropicKey, pref.user_id, kind, tz);
    results.push({ userId: pref.user_id, kind, status });
  }

  return json({ processed: results.length, results });
});

async function fetchZones(
  client: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const { data, error } = await client
    .from('user_profiles')
    .select('user_id, timezone')
    .in('user_id', userIds);
  if (error) {
    console.warn('[daily-brief] user_profiles fetch failed', error);
    return new Map();
  }
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as { user_id: string; timezone: string };
    if (r.timezone) map.set(r.user_id, r.timezone);
  }
  return map;
}

function localHourMinute(now: Date, tz: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return { hour, minute };
    }
  } catch {
    // Invalid IANA id — fall through to UTC.
  }
  return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
}

function windowMatches(prefValue: string, nowHour: number, nowMin: number): boolean {
  if (!prefValue || prefValue === 'Fra') return false;
  const m = prefValue.match(/^(\d{1,2})\.(\d{2})$/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  // Fire if the cron tick lands within 15 minutes after the configured time.
  const nowTotal = nowHour * 60 + nowMin;
  const prefTotal = hour * 60 + minute;
  return nowTotal >= prefTotal && nowTotal < prefTotal + 15;
}

async function generateOneBrief(
  client: SupabaseClient,
  anthropicKey: string,
  userId: string,
  kind: 'morning' | 'evening',
  timezone: string,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await client
    .from('briefs')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('generated_at', `${today}T00:00:00Z`)
    .limit(1);
  if (existing && existing.length > 0) return 'already-briefed';

  const inputs = await assembleInputs(client, userId, kind, timezone);
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
  if (insertErr || !inserted) return 'insert-failed';

  await sendPush(
    client,
    userId,
    kind,
    brief.headline,
    inserted.id as string,
    brief.body[0] ?? null,
  );
  await client
    .from('briefs')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', inserted.id as string);
  return 'sent';
}

async function assembleInputs(
  client: SupabaseClient,
  userId: string,
  kind: 'morning' | 'evening',
  timezone: string,
): Promise<BriefInputs> {
  const [commitmentsRes, mailRes, weather, events] = await Promise.all([
    client
      .from('facts')
      .select('text')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .eq('category', 'commitment'),
    client
      .from('mail_events')
      .select('provider_from, provider_subject')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(3),
    fetchWeather(DEFAULT_LAT, DEFAULT_LNG),
    fetchCalendarForUser(client, userId, timezone),
  ]);

  // Reminders are still local-only (AsyncStorage on the phone). The Today
  // banner shows them client-side via the existing hooks.

  return {
    kind,
    name: null,
    timezone,
    events,
    unread: (mailRes.data ?? []).map((r) => ({
      from: (r as Record<string, string>).provider_from ?? 'ukendt',
      subject: (r as Record<string, string>).provider_subject ?? '(intet emne)',
    })),
    commitments: (commitmentsRes.data ?? []).map(
      (r) => (r as Record<string, string>).text as string,
    ),
    reminders: [],
    weather,
  };
}

async function composeWithClaude(
  anthropicKey: string,
  inputs: BriefInputs,
): Promise<BriefOutput | null> {
  const body = {
    model: MODEL,
    max_tokens: 512,
    temperature: 0.2,
    system: [
      {
        type: 'text',
        text: COMPOSER_SYSTEM.replace('{kind}', inputs.kind) + '\n' + COMPOSER_SCHEMA,
      },
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
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(cleaned) as BriefOutput;
  } catch {
    return null;
  }
}

async function sendPush(
  client: SupabaseClient,
  userId: string,
  kind: 'morning' | 'evening',
  headline: string,
  briefId: string,
  firstLine: string | null,
): Promise<void> {
  const { data: tokens } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (!tokens || tokens.length === 0) return;

  const title = kind === 'morning' ? 'Morgenbrief fra Zolva' : 'Aftenbrief fra Zolva';
  // Multi-line push: headline as bold first, then the first body item
  // as a preview. iOS/Android expand when the user long-presses.
  const body = firstLine ? `${headline}\n\n${firstLine}` : headline;
  const messages = tokens.map((t) => ({
    to: (t as Record<string, string>).token,
    title,
    body,
    sound: 'default',
    data: { type: 'brief', briefId },
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
