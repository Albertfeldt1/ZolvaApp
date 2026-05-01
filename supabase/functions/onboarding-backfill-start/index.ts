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

const MAIL_SYSTEM = `Du analyserer en samling emails for at finde få vedvarende fakta om brugeren — ikke om emails.

REGLER:

1. Konsolidér på tværs af alle emails. Hvis flere emails handler om samme person, projekt eller tema, returnér ÉT fakta — aldrig flere. Den endelige liste skal være distinkt.

2. Højst 3 fakta pr. svar. Vælg de stærkeste, mest specifikke signaler. Hellere færre, præcise fakta end mange svage.

3. Kategori — vælg én og kun én pr. fakta. Disambiguering:
   - relationship: en navngiven person brugeren har gentagen kontakt med (kollega, kunde, partner). Brug hvis personens navn nævnes.
   - role: brugerens rolle, titel, firma eller funktion ("freelance backend-udvikler", "marketingchef hos Acme").
   - preference: brugerens vane, værktøj eller måde at arbejde på ("foretrækker AI-værktøjer", "arbejder primært remote").
   - project: et navngivent, igangværende initiativ ("Q2-budget", "lancering af qixotic").
   - commitment: en konkret aftale med en deadline eller dato.

4. Skriv på dansk, ÉN kort sætning. Eksempler:
   "Maria er din leder."
   "Du arbejder som freelance backend-udvikler."
   "Du bruger Upwork til at finde freelancere."
   "Du arbejder på Q2-budget."

5. Ignorér markedsføringsmails, notifikationer, transaktioner, ordrebekræftelser og automatiske svar.

Output (kun det her, intet andet, ingen markdown):
[{"text": "...", "category": "relationship|role|preference|project|commitment", "confidence": 0.0-1.0, "referentDate": "YYYY-MM-DD" | null}]`;

const CAL_SYSTEM = `Du analyserer brugerens tilbagevendende møder og udtrækker få vedvarende fakta om brugeren.

REGLER:

1. Konsolidér. Flere møder med samme person eller om samme projekt → ÉT fakta. Den endelige liste skal være distinkt.

2. Højst 3 fakta pr. svar. Vælg de stærkeste signaler.

3. Kategori (vælg én):
   - relationship: tilbagevendende ekstern eller intern samarbejdspartner ved navn.
   - role: brugerens funktion (fx "leder ugentlige team-stand-ups", "1:1 med leder hver uge").
   - project: et navngivent initiativ.

4. Skriv på dansk, ÉN kort sætning. Eksempler:
   "Lars fra Acme er en tilbagevendende ekstern kontakt."
   "Du leder ugentlige team-stand-ups."
   "Du har 1:1 med Maria hver uge."

5. Ignorér frokost, generiske kaffemøder, ferier.

Output (kun det her):
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
      if (filtered.length > 0) kinds = Array.from(new Set(filtered));
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

  // Create jobs. The unique index on (user_id, kind, provider) handles the
  // race where two near-simultaneous "Start" requests both pass the
  // idempotency check above — the second insert returns 23505 and we
  // re-fetch the rows the first request just created. Spec L185 calls for
  // a Postgres advisory lock; this is the simpler equivalent that works
  // with supabase-js's pooled-connection model (no transactional lifetime
  // we can rely on for advisory locks).
  const { data: insertedJobs, error: jobErr } = await service
    .from('backfill_jobs')
    .insert(providers.map((p) => ({
      user_id: userId,
      kind: p.kind,
      provider: p.provider,
      status: 'queued',
    })))
    .select();
  let jobs = insertedJobs;
  if (jobErr) {
    // 23505 = unique_violation. Re-fetch — the other request created them.
    if (jobErr.code === '23505') {
      const { data: refetched } = await service
        .from('backfill_jobs')
        .select('id, kind, provider, status')
        .eq('user_id', userId);
      if (!refetched || refetched.length === 0) {
        return json({ error: 'internal', detail: 'race re-fetch empty' }, 500);
      }
      return json({ job_ids: refetched.map((j) => j.id), idempotent: true });
    }
    return json({ error: 'internal', detail: jobErr.message }, 500);
  }
  if (!jobs) return json({ error: 'internal' }, 500);

  await logBackfillEvent(service, userId, 'backfill_started', {
    jobs: jobs.length,
    kinds,
    providers: providers.map((p) => `${p.provider}:${p.kind}`),
  });

  // Run all jobs in parallel. Each worker is wrapped in a try so one failure
  // doesn't sink the whole batch.
  // KNOWN LIMITATION: Edge functions have a 150s wall-clock cap. If the
  // worker hits it, the in-flight job stays in 'running' status and the
  // terminal logBackfillEvent call below never fires. Spec L246 promises
  // partial-completion → 'done', which would require a stale-job sweeper
  // (Deno.cron or daily reaper). Tracked for follow-up; for now,
  // production users are unlikely to exceed 150s on the realistic 4-job
  // shape (Gmail + Outlook × mail + cal).
  const settledResults = await Promise.allSettled(
    jobs.map((job) => runJob(service, userId, userOwnEmail, job, anthropicKey))
  );
  const factsTotal = settledResults.reduce((sum, r) => {
    if (r.status === 'fulfilled' && typeof r.value === 'number') return sum + r.value;
    return sum;
  }, 0);

  const { data: doneJobs } = await service
    .from('backfill_jobs')
    .select('id, status')
    .eq('user_id', userId);
  const final = doneJobs ?? [];
  const success = final.every((j) => j.status === 'done');
  await logBackfillEvent(service, userId, success ? 'backfill_completed' : 'backfill_failed', {
    jobs_total: final.length,
    jobs_done: final.filter((j) => j.status === 'done').length,
    jobs_failed: final.filter((j) => j.status === 'failed').length,
    jobs_cancelled: final.filter((j) => j.status === 'cancelled').length,
    facts_total: factsTotal,
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
): Promise<number> {
  try {
    const refresh = await loadRefreshToken(service, userId, job.provider);
    if (!refresh) {
      await finishJob(service, job.id, 'failed', 'no refresh token');
      return 0;
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
      return 0;
    }

    let factsThisJob = 0;
    // Cross-batch anti-context. Texts of facts already extracted in this
    // run get passed back to Claude as "do not repeat these" — stops
    // semantic dupes (different wording, same theme) from piling up.
    const priorFactTexts: string[] = [];

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
          return factsThisJob;
        }
        const slice = candidates.slice(i, i + BATCH);
        const userPayload = slice
          .map((c, idx) => `Email ${idx + 1}:
Fra: ${c.from}
Emne: ${c.subject}
Uddrag: ${c.snippet}`)
          .join('\n\n');
        const facts = await callClaudeBatch(anthropicKey, MAIL_SYSTEM, userPayload, priorFactTexts);
        for (const f of facts) priorFactTexts.push(f.text);
        factsThisJob += await insertPendingFacts(service, userId, facts, `backfill:${job.provider}:mail`);
        processed += slice.length;
        await bumpJobProgress(service, job.id, processed);
      }
      await finishJob(service, job.id, 'done');
      return factsThisJob;
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
        return factsThisJob;
      }
      const slice = series.slice(i, i + BATCH_CAL);
      const userPayload = slice
        .map((s, idx) => `Møde ${idx + 1}:
Titel: ${s.title}
Mønster: ${s.recurrencePattern}
Deltagere: ${s.attendeeEmails.join(', ')}`)
        .join('\n\n');
      const facts = await callClaudeBatch(anthropicKey, CAL_SYSTEM, userPayload, priorFactTexts);
      for (const f of facts) priorFactTexts.push(f.text);
      factsThisJob += await insertPendingFacts(service, userId, facts, `backfill:${job.provider}:calendar`);
      processed += slice.length;
      await bumpJobProgress(service, job.id, processed);
    }
    await finishJob(service, job.id, 'done');
    return factsThisJob;
  } catch (err) {
    await finishJob(service, job.id, 'failed', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
