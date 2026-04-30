// supabase/functions/onboarding-backfill-start/index.ts
//
// Creates per-source backfill_jobs rows and runs the workers inline within
// the request scope. JWT-gated. Idempotent — if jobs already exist for
// this user, returns those without re-running.
//
// Body: { kinds?: ('mail' | 'calendar')[] }  // default: both
// Response: { job_ids: string[] }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadRefreshToken, refreshAccessToken } from '../_shared/oauth.ts';
import {
  callClaudeBatch,
  finishJob,
  insertPendingFacts,
  isCancelled,
  logBackfillEvent,
  setJobRunning,
  bumpJobProgress,
} from '../_shared/onboarding-backfill.ts';
import { fetchGmailCandidates } from '../_shared/backfill-providers/gmail.ts';
import { fetchGraphCandidates } from '../_shared/backfill-providers/microsoft.ts';
import { fetchGoogleRecurring } from '../_shared/backfill-providers/google-calendar.ts';
import { fetchGraphRecurring } from '../_shared/backfill-providers/microsoft-calendar.ts';

const MAIL_SYSTEM = `Du analyserer en kort liste af emails (afsender, emne, uddrag) og udtrækker konklusioner om brugeren — ikke om emailen.

For HVER email, vurder om den fortæller os noget vedvarende om brugeren:
- relation: hvem brugeren arbejder med (kollega, kunde, partner)
- role: brugerens rolle/titel/firma
- preference: brugerens præference
- project: igangværende projekt brugeren er involveret i
- commitment: noget brugeren har lovet/aftalt med en deadline

Returnér en JSON-array med højst 5 fakta på tværs af alle emails. Skriv på dansk i kort sætningsform.

Output-format (intet andet):
[{"text": "...", "category": "relationship|role|preference|project|commitment", "confidence": 0.0-1.0, "referentDate": "YYYY-MM-DD" | null}]`;

const CAL_SYSTEM = `Du analyserer brugerens tilbagevendende møder og udtrækker konklusioner om brugeren.

For HVER mødeserie, vurder om den fortæller noget om relation, role eller project. Skriv på dansk.

Output-format (intet andet):
[{"text": "...", "category": "relationship|role|preference|project|commitment", "confidence": 0.0-1.0, "referentDate": null}]`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey || !anthropicKey) {
    return json({ error: 'internal' }, 500);
  }

  // JWT gate
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;
  const userOwnEmail = (userData.user.email ?? '').toLowerCase().trim();

  let kinds: Array<'mail' | 'calendar'> = ['mail', 'calendar'];
  try {
    const body = await req.json() as { kinds?: unknown };
    if (Array.isArray(body.kinds)) {
      const filtered = body.kinds.filter((k): k is 'mail' | 'calendar' => k === 'mail' || k === 'calendar');
      if (filtered.length > 0) kinds = filtered;
    }
  } catch { /* default */ }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Idempotency: if any backfill_jobs row exists for this user, just return.
  const { data: existingJobs } = await service
    .from('backfill_jobs')
    .select('id, status')
    .eq('user_id', userId);
  if (existingJobs && existingJobs.length > 0) {
    return json({ job_ids: existingJobs.map((j) => j.id), idempotent: true });
  }

  // Determine which providers the user has connected.
  const providers: Array<{ provider: 'google' | 'microsoft'; kind: 'mail' | 'calendar' }> = [];
  for (const kind of kinds) {
    for (const provider of ['google', 'microsoft'] as const) {
      const refresh = await loadRefreshToken(service, userId, provider);
      if (refresh) providers.push({ provider, kind });
    }
  }

  if (providers.length === 0) {
    await logBackfillEvent(service, userId, 'backfill_completed', {
      reason: 'no_providers_connected',
      facts_extracted: 0,
    });
    return json({ job_ids: [], reason: 'no_providers_connected' });
  }

  // Create jobs.
  const { data: jobs, error: jobErr } = await service
    .from('backfill_jobs')
    .insert(providers.map((p) => ({
      user_id: userId,
      kind: p.kind,
      provider: p.provider,
      status: 'queued',
    })))
    .select();
  if (jobErr || !jobs) return json({ error: 'internal', detail: jobErr?.message }, 500);

  await logBackfillEvent(service, userId, 'backfill_started', {
    jobs: jobs.length,
    kinds,
    providers: providers.map((p) => `${p.provider}:${p.kind}`),
  });

  // Run all jobs in parallel. Each worker is wrapped in a try so one failure
  // doesn't sink the whole batch.
  await Promise.allSettled(jobs.map((job) => runJob(service, userId, userOwnEmail, job, anthropicKey)));

  const { data: doneJobs } = await service
    .from('backfill_jobs')
    .select('id, status')
    .eq('user_id', userId);
  const success = (doneJobs ?? []).every((j) => j.status === 'done');
  await logBackfillEvent(service, userId, success ? 'backfill_completed' : 'backfill_failed', {
    jobs: doneJobs ?? [],
  });

  return json({ job_ids: jobs.map((j) => j.id) });
});

type Job = { id: string; kind: 'mail' | 'calendar'; provider: 'google' | 'microsoft' };

async function runJob(
  service: SupabaseClient,
  userId: string,
  userOwnEmail: string,
  job: Job,
  anthropicKey: string,
): Promise<void> {
  try {
    const refresh = await loadRefreshToken(service, userId, job.provider);
    if (!refresh) {
      await finishJob(service, job.id, 'failed', 'no refresh token');
      return;
    }
    // Microsoft calendar requires the Calendars.Read scope; mail uses the
    // default Mail.* scope. Google ignores microsoftScope.
    const microsoftScope = job.provider === 'microsoft'
      ? (job.kind === 'calendar' ? 'offline_access Calendars.Read' : undefined)
      : undefined;
    let accessToken: string;
    try {
      const result = await refreshAccessToken(service, userId, job.provider, refresh, { microsoftScope });
      accessToken = result.accessToken;
    } catch (err) {
      await finishJob(service, job.id, 'failed', `token refresh: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (job.kind === 'mail') {
      const candidates = job.provider === 'google'
        ? await fetchGmailCandidates(accessToken, userOwnEmail)
        : await fetchGraphCandidates(accessToken, userOwnEmail);

      await setJobRunning(service, job.id, candidates.length);

      const BATCH = 10;
      let processed = 0;
      for (let i = 0; i < candidates.length; i += BATCH) {
        if (await isCancelled(service, job.id)) {
          await finishJob(service, job.id, 'cancelled');
          return;
        }
        const slice = candidates.slice(i, i + BATCH);
        const userPayload = slice
          .map((c, idx) => `Email ${idx + 1}:
Fra: ${c.from}
Emne: ${c.subject}
Uddrag: ${c.snippet}`)
          .join('\n\n');
        const facts = await callClaudeBatch(anthropicKey, MAIL_SYSTEM, userPayload);
        await insertPendingFacts(service, userId, facts, `backfill:${job.provider}:mail`);
        processed += slice.length;
        await bumpJobProgress(service, job.id, processed);
      }
      await finishJob(service, job.id, 'done');
      return;
    }

    // calendar
    const series = job.provider === 'google'
      ? await fetchGoogleRecurring(accessToken)
      : await fetchGraphRecurring(accessToken);

    await setJobRunning(service, job.id, series.length);

    const BATCH_CAL = 5;
    let processed = 0;
    for (let i = 0; i < series.length; i += BATCH_CAL) {
      if (await isCancelled(service, job.id)) {
        await finishJob(service, job.id, 'cancelled');
        return;
      }
      const slice = series.slice(i, i + BATCH_CAL);
      const userPayload = slice
        .map((s, idx) => `Møde ${idx + 1}:
Titel: ${s.title}
Mønster: ${s.recurrencePattern}
Deltagere: ${s.attendeeEmails.join(', ')}`)
        .join('\n\n');
      const facts = await callClaudeBatch(anthropicKey, CAL_SYSTEM, userPayload);
      await insertPendingFacts(service, userId, facts, `backfill:${job.provider}:calendar`);
      processed += slice.length;
      await bumpJobProgress(service, job.id, processed);
    }
    await finishJob(service, job.id, 'done');
  } catch (err) {
    await finishJob(service, job.id, 'failed', err instanceof Error ? err.message : String(err));
  }
}
