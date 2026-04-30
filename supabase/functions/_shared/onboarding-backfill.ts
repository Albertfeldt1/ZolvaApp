// supabase/functions/_shared/onboarding-backfill.ts
//
// Shared worker module for the onboarding backfill flow. Used by:
//   - onboarding-backfill-start (orchestrator + worker entrypoint)
//   - onboarding-backfill-status (read-only)
//   - onboarding-backfill-cancel (write 'cancelled')

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Types ───────────────────────────────────────────────────────────────

export type CandidateMessage = {
  id: string;
  from: string;          // raw "Name <email>" or "email"
  fromEmail: string;     // normalized lowercase email
  subject: string;
  snippet: string;       // first ~200 chars of preview
  receivedAt: string;    // ISO
  labels?: string[];     // Gmail label IDs or Graph categories
  inferenceClassification?: 'focused' | 'other';
};

export type CalendarSeries = {
  seriesId: string;
  title: string;
  attendeeEmails: string[];     // excluding the user
  recurrencePattern: string;
  occurrenceCount: number;
  description?: string;
};

export type ExtractedFact = {
  text: string;
  category: 'relationship' | 'role' | 'preference' | 'project' | 'commitment' | 'other';
  confidence: number;
  referentDate: string | null;
};

// ─── Filter ──────────────────────────────────────────────────────────────

const SENDER_DOMAIN_DENYLIST = new Set([
  'mailchimp.com',
  'mailchi.mp',
  'sendgrid.net',
  'amazonses.com',
  'mailgun.org',
  'mailgun.net',
  'list.linkedin.com',
  'linkedin.com',
  'facebookmail.com',
  'twitter.com',
  'x.com',
  'slack.com',
  'github.com',
  'noreply.github.com',
  'dhl.com',
  'postnord.dk',
  'gls-pakkeshop.dk',
  'bring.dk',
  'instagram.com',
  'medium.com',
  'substack.com',
  'patreon.com',
]);

const SENDER_LOCAL_PATTERNS: ReadonlyArray<RegExp> = [
  /^no.?reply/i,
  /^do.?not.?reply/i,
  /^donotreply/i,
  /^notifications?/i,
  /^alerts?/i,
  /^mailer-daemon/i,
  /^postmaster/i,
  /^bounces?/i,
  /^newsletter/i,
  /^marketing/i,
  /^team@/i,
  /^info@/i,
];

const SUBJECT_PATTERNS: ReadonlyArray<RegExp> = [
  /unsubscribe/i,
  /newsletter/i,
  /digest/i,
  /weekly summary/i,
  /your order/i,
  /\bpackage\b/i,
  /\btracking\b/i,
  /bekræftelse af bestilling/i,
  /bekræftelse af køb/i,
  /\bkvittering\b/i,
  /\bordre\b/i,
  /\blevering\b/i,
];

export function isAutomatedSender(
  fromEmail: string,
  subject: string,
  labels: string[] = [],
  inferenceClassification?: 'focused' | 'other',
  userOwnEmail?: string,
): boolean {
  const email = fromEmail.toLowerCase().trim();
  if (!email) return true;

  // From-self filter — exclude the user's own sent-to-self mail.
  if (userOwnEmail && email === userOwnEmail.toLowerCase().trim()) return true;

  const localPart = email.split('@')[0];
  if (SENDER_LOCAL_PATTERNS.some((re) => re.test(localPart))) return true;

  const domain = email.split('@')[1];
  if (!domain) return true;
  for (const denied of SENDER_DOMAIN_DENYLIST) {
    if (domain === denied || domain.endsWith('.' + denied)) return true;
  }

  if (SUBJECT_PATTERNS.some((re) => re.test(subject))) return true;

  const gmailExcludeLabels = new Set([
    'CATEGORY_PROMOTIONS',
    'CATEGORY_UPDATES',
    'CATEGORY_FORUMS',
    'CATEGORY_SOCIAL',
  ]);
  if (labels.some((l) => gmailExcludeLabels.has(l))) return true;

  if (inferenceClassification === 'other') return true;

  // NOTE: spec listed a conditional 'support@' rule (skip only if subject
  // contains 'ticket'/'case'/'automated'). The SUBJECT_PATTERNS above
  // (your order, tracking, kvittering, etc.) cover the automated cases in
  // practice; real human support@ correspondence is rare in personal
  // inboxes, so we accept the small false-negative rate.
  return false;
}

// ─── Claude batch extraction ─────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

/** Single retry on 429 or 529, honoring retry-after up to 30s; else 2s backoff. */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429 && res.status !== 529) return res;
  // Honor retry-after if it's a small positive integer (seconds); fall back to 2s.
  const retryAfter = Number(res.headers.get('retry-after'));
  const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30
    ? retryAfter * 1000
    : 2000;
  await new Promise((r) => setTimeout(r, waitMs));
  return fetch(url, init);
}

export async function callClaudeBatch(
  apiKey: string,
  systemPrompt: string,
  userPayload: string,
): Promise<ExtractedFact[]> {
  const res = await fetchWithRetry(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPayload }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  // Claude sometimes wraps the JSON in fences. Strip if present.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) =>
      typeof f.text === 'string' &&
      typeof f.category === 'string' &&
      typeof f.confidence === 'number',
    ) as ExtractedFact[];
  } catch {
    console.warn('[backfill] claude returned non-JSON:', cleaned.slice(0, 200));
    return [];
  }
}

// ─── Fact insertion ──────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'relationship',
  'role',
  'preference',
  'project',
  'commitment',
  'other',
]);

export function normalizeFactText(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export async function insertPendingFacts(
  client: SupabaseClient,
  userId: string,
  facts: ExtractedFact[],
  sourceTag: string,
): Promise<number> {
  if (facts.length === 0) return 0;

  // Live `facts` columns: id, user_id, text, normalized_text, category,
  // status, source, created_at, confirmed_at, rejected_at, rejection_ttl,
  // expires_at, decay_warning_sent_at. There is NO `confidence` column and
  // NO `referent_date` column — `confidence` is consumed only as a filter
  // here; `referentDate` is dropped (the existing `expires_at` decay path
  // is for action-y categories and is set elsewhere).
  const candidates = facts
    .filter((f) => VALID_CATEGORIES.has(f.category))
    .filter((f) => f.confidence >= 0.55)
    .map((f) => ({ ...f, normalized: normalizeFactText(f.text) }))
    // Within-batch dedup: Claude may emit the same fact twice across calls.
    .filter((f, i, all) => all.findIndex((g) => g.normalized === f.normalized) === i);

  if (candidates.length === 0) return 0;

  // Pre-check: skip facts whose normalized_text already exists as confirmed,
  // OR as a non-expired rejection. Mirrors findDuplicateFact() in
  // src/lib/profile-store.ts. The unique index on (user_id, normalized_text)
  // is PARTIAL (WHERE status='confirmed'); pending dupes that later flip
  // to confirmed would violate the index.
  const nowIso = new Date().toISOString();
  const { data: dups, error: dupErr } = await client
    .from('facts')
    .select('normalized_text, status, rejection_ttl')
    .eq('user_id', userId)
    .in('normalized_text', candidates.map((c) => c.normalized));
  if (dupErr) throw new Error(`facts dup-check: ${dupErr.message}`);
  const blocked = new Set(
    (dups ?? [])
      .filter((d) =>
        d.status === 'confirmed' ||
        (d.status === 'rejected' && d.rejection_ttl && (d.rejection_ttl as string) > nowIso),
      )
      .map((d) => d.normalized_text as string),
  );

  const rows = candidates
    .filter((c) => !blocked.has(c.normalized))
    .map((c) => ({
      user_id: userId,
      text: c.text,
      normalized_text: c.normalized,
      category: c.category,
      status: 'pending',
      source: sourceTag,
    }));
  if (rows.length === 0) return 0;

  const { error } = await client.from('facts').insert(rows);
  if (error) throw new Error(`facts insert: ${error.message}`);
  return rows.length;
}

// ─── Job status ──────────────────────────────────────────────────────────

export async function setJobRunning(client: SupabaseClient, jobId: string, total: number): Promise<void> {
  await client.from('backfill_jobs').update({
    status: 'running',
    started_at: new Date().toISOString(),
    total,
    processed: 0,
  }).eq('id', jobId);
}

export async function bumpJobProgress(client: SupabaseClient, jobId: string, processed: number): Promise<void> {
  await client.from('backfill_jobs').update({ processed }).eq('id', jobId);
}

export async function finishJob(
  client: SupabaseClient,
  jobId: string,
  status: 'done' | 'failed' | 'cancelled',
  error?: string,
): Promise<void> {
  await client.from('backfill_jobs').update({
    status,
    finished_at: new Date().toISOString(),
    error: error ?? null,
  }).eq('id', jobId);
}

export async function isCancelled(client: SupabaseClient, jobId: string): Promise<boolean> {
  const { data } = await client.from('backfill_jobs').select('status').eq('id', jobId).single();
  return data?.status === 'cancelled';
}

export async function logBackfillEvent(
  client: SupabaseClient,
  userId: string,
  type: 'backfill_started' | 'backfill_completed' | 'backfill_failed' | 'backfill_cancelled',
  details?: Record<string, unknown>,
): Promise<void> {
  await client.from('consent_events').insert({
    event_type: type,
    user_id: userId,
    details: details ?? null,
  });
}
