// daily-brief - Supabase Edge Function (cron-driven, service-role).
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
//   - Cron - must present `x-cron-secret: <CRON_SHARED_SECRET>`. Full batch.
//   - Authenticated user - must present a valid user JWT. Batch scoped to
//     that user only (useful for manual "trigger mine now" tests).
//   - Anything else → 401.
//
// The function runs with the service-role internally so it can read facts
// and mail_events for every user, but the caller gate above prevents any
// authenticated user from triggering a full-fleet Claude call.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { recordAiUsage } from '../_shared/usage.ts';
import { fetchWeather, Weather } from './weather.ts';
import { fetchCalendarForUser, getDayBoundsUTC } from '../_shared/calendar.ts';
import {
  fetchLatestInteractionByPerson,
  fetchNetworkContext,
  logCalendarInteraction,
  matchEventsToPeople,
} from '../_shared/network-context.ts';
import {
  BriefInputs,
  BriefOutput,
  buildComposerMessage,
  COMPOSER_SCHEMA,
  COMPOSER_SYSTEM,
  formatCalendarLines,
  selectRelevantEvents,
} from './compose.ts';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import { fetchGmailCandidates } from '../_shared/backfill-providers/gmail.ts';
import { fetchGraphCandidates } from '../_shared/backfill-providers/microsoft.ts';
import { fetchIcloudCandidates } from '../_shared/backfill-providers/icloud.ts';
import { parseForceRequest, kindForHour, fetchLiveUnread, type LiveUnreadDeps } from './force.ts';
import { getEntitlement } from '../_shared/entitlement-read.ts';
import { RPM_LIMIT, dailyRequestCapForTier } from '../_shared/abuse-limits.ts';

type BriefSections = {
  calendar: string[];
  mails: string[];
  followups: string[];
  focus: string[];
  weather: string[];
  personer: string[];
};

// Assembles the persisted section payload: calendar is deterministic (real
// event times), the other four come from the model. Defensive `?? []` guards
// a model response that omits a key.
function buildSections(inputs: BriefInputs, brief: BriefOutput): BriefSections {
  return {
    calendar: formatCalendarLines(inputs),
    mails: brief.mails ?? [],
    followups: brief.followups ?? [],
    focus: brief.focus ?? [],
    weather: brief.weather ?? [],
    personer: brief.personer ?? [],
  };
}

// Flattened prose fallback written to the legacy `body` column. Clients that
// haven't yet received the structured-UI OTA (and the brief-detail deep link
// during the server-deploy-before-client window) still render readable text.
function buildBodyFallback(s: BriefSections): string[] {
  const out: string[] = [];
  if (s.calendar.length) out.push(`I kalenderen: ${s.calendar.join(' · ')}`);
  if (s.personer.length) out.push(`Personer: ${s.personer.join(' ')}`);
  if (s.mails.length) out.push(`Mails: ${s.mails.join('; ')}`);
  if (s.followups.length) out.push(`Opfølgninger: ${s.followups.join('; ')}`);
  out.push(...s.focus);
  out.push(...s.weather);
  return out.length ? out : ['Din brief er klar.'];
}

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

  let scopedUserId: string | null = null;
  let scopedUserEmail = '';
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
    scopedUserEmail = (userData.user.email ?? '').toLowerCase().trim();
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let rawBody: unknown = null;
  try {
    rawBody = await req.json();
  } catch {
    // empty or non-JSON body — normal for cron invocations
  }

  const liveDeps: LiveUnreadDeps = {
    loadRefreshToken,
    refreshAccessToken,
    fetchGmail: fetchGmailCandidates,
    fetchGraph: fetchGraphCandidates,
    // iCloud-only users have no OAuth token; reach their INBOX over IMAP so the
    // forced "first win" brief is populated for them too. Small fetch window
    // (10 scanned / 3 kept) — same cold-start volume as the OAuth providers.
    fetchIcloud: (c, uid, ownEmail) => {
      const encryptionKey = Deno.env.get('ICLOUD_CREDS_ENCRYPTION_KEY');
      if (!encryptionKey) {
        console.warn('[daily-brief] icloud live unread skipped: missing encryption key');
        return Promise.resolve([]);
      }
      return fetchIcloudCandidates(c, uid, encryptionKey, ownEmail, 10, 3);
    },
  };

  // Forced on-demand brief (onboarding "first win"). Bypasses the
  // work_preferences window entirely — a brand-new user may not even have a
  // brief preference row yet.
  if (parseForceRequest(rawBody, isCron) && scopedUserId) {
    // Rate-limit the forced path: it burns a real Claude compose call + live
    // Gmail fetches, and compose failures produce no brief row so there is no
    // natural dedupe guard against a scripted caller running up the shared key.
    const ent = await getEntitlement(client, scopedUserId);
    const { data: limitRows, error: limitErr } = await client.rpc(
      'check_and_incr_claude_usage',
      { p_user_id: scopedUserId, p_rpm_limit: RPM_LIMIT, p_daily_limit: dailyRequestCapForTier(ent.tier) },
    );
    if (limitErr) {
      console.error(`[daily-brief] rate_limit_check_failed user=${scopedUserId} err=${limitErr.message}`);
      return json({ error: 'rate limit check failed' }, 500);
    }
    const limit = Array.isArray(limitRows) ? limitRows[0] : limitRows;
    if (!limit?.allowed) {
      const retryAfter = Math.max(1, Number(limit?.retry_after ?? 60));
      return json({ error: 'rate_limited', retryAfter }, 429);
    }

    const zones = await fetchZones(client, [scopedUserId]);
    const tz = zones.get(scopedUserId) ?? 'UTC';
    const local = localHourMinute(new Date(), tz);
    const kind = kindForHour(local.hour);
    const r = await generateOneBrief(client, anthropicKey, scopedUserId, kind, tz, {
      forcedEmail: scopedUserEmail,
      liveDeps,
    });
    return json({ forced: true, kind, status: r.status, briefId: r.briefId });
  }

  const now = new Date();

  let prefsQuery = client
    .from('work_preferences')
    .select('user_id, id, value')
    .in('id', ['morning-brief', 'midday-brief', 'evening-brief']);
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
    const kind: 'morning' | 'midday' | 'evening' =
      pref.id === 'morning-brief' ? 'morning'
      : pref.id === 'midday-brief' ? 'midday'
      : 'evening';
    const r = await generateOneBrief(client, anthropicKey, pref.user_id, kind, tz);
    results.push({ userId: pref.user_id, kind, status: r.status });
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
    // Invalid IANA id - fall through to UTC.
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
  kind: 'morning' | 'midday' | 'evening',
  timezone: string,
  forced: { forcedEmail: string; liveDeps: LiveUnreadDeps } | null = null,
): Promise<{ status: string; briefId: string | null }> {
  // Memory toggle gate. The brief quotes facts and mail subjects, so when
  // the user has memory off we must skip composition entirely - not just
  // pass empty arrays through (which would still burn a Claude call to
  // produce a content-free brief). Mirrors src/lib/profile.ts:2-3.
  const { data: profile, error: profileErr } = await client
    .from('user_profiles')
    .select('memory_enabled')
    .eq('user_id', userId)
    .maybeSingle();
  if (profileErr) {
    console.warn('[daily-brief] memory_enabled read failed', profileErr);
    // Fail-open to match the timezone-read pattern in fetchZones; a
    // transient profile read error shouldn't drop briefs for everyone.
  }
  if (profile?.memory_enabled === false) return { status: 'skipped-memory-off', briefId: null };

  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await client
    .from('briefs')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('generated_at', `${today}T00:00:00Z`)
    .limit(1);
  if (existing && existing.length > 0) {
    return { status: 'already-briefed', briefId: (existing[0] as { id: string }).id };
  }

  const inputs = await assembleInputs(client, userId, kind, timezone);

  // Cold start: a brand-new user has no mail_events rows yet (poll-mail
  // hasn't run). On the forced path only, pull live inbox headers so the
  // first brief isn't empty-skipped.
  if (forced && inputs.unread.length === 0) {
    inputs.unread = await fetchLiveUnread(forced.liveDeps, client, userId, forced.forcedEmail);
  }

  // NB: reminders are local-only (client AsyncStorage), so the server never
  // sees them — inputs.reminders is always empty and is intentionally not part
  // of this gate.
  const nonEmpty =
    inputs.events.length > 0 ||
    inputs.unread.length > 0 ||
    inputs.commitments.length > 0;
  if (!nonEmpty) return { status: 'empty-skipped', briefId: null };

  const composed = await composeWithClaude(anthropicKey, inputs);
  if (!composed) return { status: 'compose-failed', briefId: null };
  const { brief, usage } = composed;
  void recordAiUsage(client, userId, 'daily-brief', MODEL, usage);

  const sections = buildSections(inputs, brief);
  const body = buildBodyFallback(sections);

  const { data: inserted, error: insertErr } = await client
    .from('briefs')
    .insert({
      user_id: userId,
      kind,
      headline: brief.headline,
      body,
      sections,
      weather: inputs.weather,
      tone: brief.tone,
    })
    .select('id')
    .single();
  if (insertErr) {
    // 23505 = unique_violation on briefs_user_kind_local_date_unique. A
    // concurrent invocation already wrote the brief and pushed; we
    // silently bail so the user only sees one push. This is the race
    // 20260509100000_briefs_dedupe_constraint.sql exists to neutralise.
    if ((insertErr as { code?: string }).code === '23505') return { status: 'race-loss', briefId: null };
    return { status: 'insert-failed', briefId: null };
  }
  if (!inserted) return { status: 'insert-failed', briefId: null };

  await sendPush(
    client,
    userId,
    kind,
    brief.headline,
    inserted.id as string,
    sections.focus[0] ?? sections.personer[0] ?? sections.calendar[0] ?? body[0] ?? null,
    brief.tone ?? null,
  );
  await client
    .from('briefs')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', inserted.id as string);
  return { status: 'sent', briefId: inserted.id as string };
}

async function assembleInputs(
  client: SupabaseClient,
  userId: string,
  kind: 'morning' | 'midday' | 'evening',
  timezone: string,
): Promise<BriefInputs> {
  const [commitmentsRes, mailRes, weather, events, name] = await Promise.all([
    client
      .from('facts')
      .select('text')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .eq('category', 'commitment')
      // Action-y facts decay; skip rows past their referent date so
      // yesterday's reminders don't keep showing up in tomorrow's brief.
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
    client
      .from('mail_events')
      .select('provider_from, provider_subject')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(3),
    fetchWeather(DEFAULT_LAT, DEFAULT_LNG),
    fetchCalendarForUser(client, userId, timezone),
    fetchUserName(client, userId),
  ]);

  // Reminders are still local-only (AsyncStorage on the phone). The Today
  // banner shows them client-side via the existing hooks.

  // Drop events that already ended today so the brief never tells the user to
  // prepare for something that's over (an evening brief at 19:00 must not
  // resurface a 17:00 event). Ongoing and upcoming events are kept.
  const relevantEvents = selectRelevantEvents(events, timezone, new Date());

  // Netværks-kontekst (M2): match dagens deltagere/titler mod network_people.
  // Kommende matches bliver "Personer du møder i dag"-input; allerede
  // AFSLUTTEDE matches logges som network_interactions (idempotent via
  // source_ref — funktionen kører op til tre gange dagligt). Forfaldne
  // netværksopfølgninger surfaces uanset om der er møder. Fejl her må aldrig
  // vælte briefen — netværk er berigelse, ikke kerneindhold.
  let networkMeetings: BriefInputs['networkMeetings'] = [];
  let networkFollowupsDue: BriefInputs['networkFollowupsDue'] = [];
  try {
    const ctx = await fetchNetworkContext(client, userId);
    if (ctx.people.length > 0) {
      const followupsByPerson = new Map<string, string[]>();
      for (const f of ctx.openFollowups) {
        const list = followupsByPerson.get(f.personId) ?? [];
        list.push(f.text);
        followupsByPerson.set(f.personId, list);
      }

      if (events.length > 0) {
        // Match mod den RÅ liste — selectRelevantEvents har fjernet de
        // afsluttede events, og netop dem skal logges som afholdte møder.
        const matches = matchEventsToPeople(events, ctx.people);
        if (matches.length > 0) {
          const latest = await fetchLatestInteractionByPerson(
            client,
            userId,
            [...new Set(matches.map((m) => m.person.id))],
          );
          const relevantSet = new Set(relevantEvents);
          networkMeetings = matches
            .filter((m) => relevantSet.has(m.event))
            .sort((a, b) => a.event.startIso.localeCompare(b.event.startIso))
            .slice(0, 3)
            .map((m) => ({
              personName: m.person.name,
              company: m.person.company,
              eventTitle: m.event.title,
              startIso: m.event.startIso,
              lastInteractionSummary: latest.get(m.person.id) ?? null,
              openFollowupTexts: (followupsByPerson.get(m.person.id) ?? []).slice(0, 2),
            }));
          const ended = matches.filter((m) => !relevantSet.has(m.event) && !m.event.allDay);
          for (const meeting of ended) {
            try {
              await logCalendarInteraction(client, userId, meeting);
            } catch (err) {
              console.warn('[daily-brief] calendar interaction log failed', { userId, err: String(err) });
            }
          }
        }
      }

      const dayEndMs = Date.parse(getDayBoundsUTC(new Date(), timezone).endIso);
      const peopleById = new Map(ctx.people.map((p) => [p.id, p] as const));
      networkFollowupsDue = ctx.openFollowups
        .filter((f) => {
          if (!f.dueAtIso) return false;
          const due = Date.parse(f.dueAtIso);
          return Number.isFinite(due) && due <= dayEndMs;
        })
        .slice(0, 3)
        .flatMap((f) => {
          const person = peopleById.get(f.personId);
          return person ? [{ personName: person.name, text: f.text }] : [];
        });
    }
  } catch (err) {
    console.warn('[daily-brief] network context failed', { userId, err: String(err) });
  }

  return {
    kind,
    name,
    timezone,
    events: relevantEvents,
    unread: (mailRes.data ?? []).map((r) => ({
      from: (r as Record<string, string>).provider_from ?? 'ukendt',
      subject: (r as Record<string, string>).provider_subject ?? '(intet emne)',
    })),
    commitments: (commitmentsRes.data ?? []).map(
      (r) => (r as Record<string, string>).text as string,
    ),
    reminders: [],
    weather,
    networkMeetings,
    networkFollowupsDue,
  };
}

// User's display name from auth metadata (same source as the client greeting:
// user_metadata.name ?? full_name). Nullable - the composer omits the line.
async function fetchUserName(
  client: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await client.auth.admin.getUserById(userId);
    if (error || !data.user) return null;
    const meta = (data.user.user_metadata ?? {}) as { name?: string; full_name?: string };
    const name = (meta.name ?? meta.full_name ?? '').trim();
    return name || null;
  } catch {
    return null;
  }
}

async function composeWithClaude(
  anthropicKey: string,
  inputs: BriefInputs,
): Promise<{ brief: BriefOutput; usage: { input_tokens: number; output_tokens: number } } | null> {
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
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : []))
      .join('')
      .trim();
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    // Fail closed if the model returns valid JSON that isn't an object (a bare
    // string or array): the `as BriefOutput` cast is a runtime no-op, so
    // without this guard `brief.headline` would be undefined and only surface
    // later as a NOT NULL insert failure.
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const brief = parsed as BriefOutput;
    return {
      brief,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  } catch {
    return null;
  }
}

async function sendPush(
  client: SupabaseClient,
  userId: string,
  kind: 'morning' | 'midday' | 'evening',
  headline: string,
  briefId: string,
  firstLine: string | null,
  tone: string | null,
): Promise<void> {
  const { data: tokens } = await client
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);
  if (!tokens || tokens.length === 0) return;

  const title =
    kind === 'morning' ? 'Morgenbrief fra Zolva'
    : kind === 'midday' ? 'Middagsbrief fra Zolva'
    : 'Aftenbrief fra Zolva';
  // Multi-line push: headline as bold first, then the first body item
  // as a preview. iOS/Android expand when the user long-presses.
  const body = firstLine ? `${headline}\n\n${firstLine}` : headline;
  const messages = tokens.map((t) => ({
    to: (t as Record<string, string>).token,
    title,
    body,
    sound: 'default',
    // tone rides along so the client can style the notification/brief card
    // (calm/busy/heads-up) without an extra fetch.
    data: { type: 'brief', briefId, ...(tone ? { tone } : {}) },
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
