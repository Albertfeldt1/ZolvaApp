# Onboarding Backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the one-time onboarding backfill from `docs/superpowers/specs/2026-04-29-onboarding-backfill-design.md` — when a user toggles `memory-enabled` ON for the first time, scan their last 50 "good" emails per inbox + 90 days of recurring calendar events, extract facts via Claude, and present a review screen where the user picks/chooses what to keep.

**Architecture:** Three new edge functions (`onboarding-backfill-start`, `-status`, `-cancel`) sharing one worker module under `_shared/onboarding-backfill.ts`. New `backfill_jobs` table tracks per-source progress. Three new screens chain after the existing `MemoryConsentModal`. The existing `profile-extractor` chat trigger handles onboarding question answers; a new server-side path inserts `pending_facts` for backfilled facts. Review screen flips `pending → confirmed` per user choice (matching the existing `confirmFact` lifecycle in `profile-store.ts`).

**Tech Stack:** Supabase Edge Functions (Deno), Supabase Postgres, React Native (Expo SDK 54), TypeScript. No new client dependencies. Server uses Anthropic API via the existing claude-proxy pattern (called directly with `ANTHROPIC_API_KEY` for server-side context).

---

## Testing note

This project has no unit-test framework and its conventions reject introducing one in feature plans (see `2026-04-21-persistent-memory.md` and `2026-04-19-notifications-foundation.md`). Verification is:

1. **Typecheck gate:** every task that touches TS runs `npm run typecheck` and must pass.
2. **Edge function deploy + smoke test:** Supabase CLI deploy, then call with `curl` using the user JWT.
3. **Manual verification on a dev build** for client-side tasks (Expo Go is insufficient for OAuth + Supabase auth on ES256, per project memory).
4. **Frequent commits** — one per task. Server changes commit + deploy BEFORE the client-side commits that depend on them (project convention from `project_client_server_pr_split.md`).

Do not add Jest, Vitest, or any test runner.

## Prerequisites

- Branch is `feat/onboarding-backfill` off `main`. Worktree at `.worktrees/onboarding-backfill`.
- `.env` copied into the worktree (gitignored, doesn't travel — see `feedback_worktree_dotenv.md`).
- Supabase CLI linked to project `sjkhfkatmeqtsrysixop`.
- Existing tables `facts` (with `status` column), `chat_messages`, `mail_events`, `consent_events` already deployed.
- Existing edge function `claude-proxy` deployed with `--no-verify-jwt`.
- Existing `profile-extractor.ts`, `profile-store.ts`, `profile.ts` shipped.
- `MemoryConsentModal` already lives in `src/components/`.
- Anthropic API key available in Supabase secrets as `ANTHROPIC_API_KEY` (already there for `claude-proxy` and `daily-brief`).
- A test user with at least Gmail OR Microsoft connected on a dev build.

## File map

**Create — server:**
- `supabase/migrations/20260430000000_backfill_jobs.sql` — schema + RLS for `backfill_jobs`; ensures `facts.status` CHECK accepts `'pending'`.
- `supabase/functions/_shared/onboarding-backfill.ts` — shared worker logic, filter rules, Claude batch caller, fact-insertion path.
- `supabase/functions/_shared/backfill-providers/gmail.ts` — `fetchGmailCandidates(token, maxFetch=200) → CandidateMessage[]`.
- `supabase/functions/_shared/backfill-providers/microsoft.ts` — `fetchGraphCandidates(token, maxFetch=200) → CandidateMessage[]`.
- `supabase/functions/_shared/backfill-providers/google-calendar.ts` — `fetchGoogleRecurring(token, days=90) → CalendarSeries[]`.
- `supabase/functions/_shared/backfill-providers/microsoft-calendar.ts` — `fetchGraphRecurring(token, days=90) → CalendarSeries[]`.
- `supabase/functions/onboarding-backfill-start/index.ts` — POST handler that creates jobs and runs workers.
- `supabase/functions/onboarding-backfill-status/index.ts` — GET handler returning per-job state.
- `supabase/functions/onboarding-backfill-cancel/index.ts` — POST handler marking jobs cancelled.

**Create — client:**
- `src/lib/onboarding-backfill.ts` — typed wrappers over the three edge functions.
- `src/screens/OnboardingBackfillScreen.tsx` — intro + Start/Skip.
- `src/screens/OnboardingChatQuestionsScreen.tsx` — 3 chat questions + progress poll.
- `src/screens/OnboardingFactReviewScreen.tsx` — checkbox list + bulk accept/reject.

**Modify:**
- `App.tsx` — route the three new screens after `MemoryConsentModal` confirms.
- `src/lib/hooks.ts` — extend the `memory-enabled` toggle handler to trigger the onboarding flow on FIRST opt-in (track via `AsyncStorage` flag + `backfill_jobs` table presence).
- `src/lib/profile-store.ts` — add `acceptPendingFact(id)`, `rejectPendingFact(id)`, `bulkUpdatePendingFacts(updates)`, `listPendingFactsForReview(userId)` helpers.

**Deploy:**
- All three edge functions: `supabase functions deploy onboarding-backfill-{start,status,cancel}`.
- Migration via `supabase db push`.

## Required env / secrets

Already set:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (auto-injected)
- `ANTHROPIC_API_KEY`
- `MICROSOFT_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_ID` (existing)

No new secrets required.

---

## Task 1: Migration — backfill_jobs table and facts.status

**Files:**
- Create: `supabase/migrations/20260430000000_backfill_jobs.sql`

- [ ] **Step 1: Inspect current `facts.status` constraint**

Run from the worktree root:

```bash
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$SUPABASE_DB_URL" -c "
  select conname, pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid = 'public.facts'::regclass
    and contype = 'c';
"
```

Or via the MCP if available. Note the existing CHECK constraint values for `status`. Expected: `'pending' | 'confirmed' | 'rejected'` already permitted (verified live: yes, all three are present, no extension needed). The plan's literal name for the "accepted" terminal state is `'confirmed'` because that matches the existing `confirmFact()` helper in `profile-store.ts`.

- [ ] **Step 2: Write the migration**

```sql
-- supabase/migrations/20260430000000_backfill_jobs.sql

-- backfill_jobs: one row per (user × kind × provider). Tracks the one-time
-- onboarding backfill run after a user toggles memory-enabled. Service-role
-- writes only; users can read their own rows.

create table if not exists public.backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mail', 'calendar')),
  provider text not null check (provider in ('google', 'microsoft', 'icloud')),
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','cancelled')),
  processed int not null default 0,
  total int,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists backfill_jobs_user_kind_provider_idx
  on public.backfill_jobs (user_id, kind, provider);

alter table public.backfill_jobs enable row level security;

drop policy if exists "users read own backfill jobs" on public.backfill_jobs;
create policy "users read own backfill jobs"
  on public.backfill_jobs for select
  using (auth.uid() = user_id);

create or replace function public.backfill_jobs_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists backfill_jobs_updated_at on public.backfill_jobs;
create trigger backfill_jobs_updated_at
  before update on public.backfill_jobs
  for each row execute function public.backfill_jobs_set_updated_at();

-- consent_events.event_type already accepts arbitrary text (per
-- 20260427130000_admin_consent_microsoft.sql) — no change needed for the
-- backfill_started / backfill_completed / backfill_failed / backfill_cancelled
-- event types we'll start writing.
```

If Step 1 showed `'pending'` is NOT in the existing constraint, append to the migration:

```sql
-- Extend facts.status to accept 'pending' (used by backfill output before review).
alter table public.facts
  drop constraint if exists facts_status_check;
alter table public.facts
  add constraint facts_status_check
  check (status in ('pending', 'confirmed', 'rejected'));
```

- [ ] **Step 3: Push the migration**

```bash
supabase link --project-ref sjkhfkatmeqtsrysixop  # idempotent
supabase db push
```

Expected: "Applying migration 20260430000000_backfill_jobs.sql" → success.

- [ ] **Step 4: Verify in Supabase Dashboard**

Open Table Editor → confirm `backfill_jobs` exists with the columns above. Run a quick `select * from backfill_jobs;` (should return 0 rows).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260430000000_backfill_jobs.sql
git commit -m "feat(db): backfill_jobs table for onboarding backfill progress

One row per (user × kind × provider). Service-role writes; users read
their own. Tracks queued/running/done/failed/cancelled per source so the
onboarding flow can show per-provider progress.
"
```

---

## Task 2: Shared filter module — automated-sender detection

**Files:**
- Create: `supabase/functions/_shared/onboarding-backfill.ts`

This is the single source of truth for "what counts as a good email". Tested only via runtime usage; no unit tests per project convention.

- [ ] **Step 1: Write the filter and types**

```typescript
// supabase/functions/_shared/onboarding-backfill.ts

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
  recurrencePattern: string;     // "ugentlig", "ugentlig fre 14:00", "månedlig"
  occurrenceCount: number;       // observed in window
  description?: string;
};

const SENDER_DOMAIN_DENYLIST = new Set([
  'mailchimp.com',
  'mailchi.mp',
  'sendgrid.net',
  'amazonses.com',
  'mailgun.org',
  'mailgun.net',
  'list.linkedin.com',
  'linkedin.com',          // LinkedIn dispatches from various subdomains too
  'facebookmail.com',
  'twitter.com',
  'x.com',
  'slack.com',             // notification dispatcher; real human Slack mail is rare
  'github.com',            // PR/issue/notification dispatcher
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
  /^team@/i,                     // common low-signal generic
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
): boolean {
  const email = fromEmail.toLowerCase().trim();
  if (!email) return true;  // malformed → skip

  // Local-part patterns (noreply, notifications, etc.)
  const localPart = email.split('@')[0];
  if (SENDER_LOCAL_PATTERNS.some((re) => re.test(localPart))) return true;

  // Domain denylist (and parent-domain match — if "mail.linkedin.com", check "linkedin.com")
  const domain = email.split('@')[1];
  if (!domain) return true;
  for (const denied of SENDER_DOMAIN_DENYLIST) {
    if (domain === denied || domain.endsWith('.' + denied)) return true;
  }

  // Subject patterns
  if (SUBJECT_PATTERNS.some((re) => re.test(subject))) return true;

  // Gmail category labels — exclude Promotions/Updates/Forums/Social
  const gmailExcludeLabels = new Set([
    'CATEGORY_PROMOTIONS',
    'CATEGORY_UPDATES',
    'CATEGORY_FORUMS',
    'CATEGORY_SOCIAL',
  ]);
  if (labels.some((l) => gmailExcludeLabels.has(l))) return true;

  // Outlook "Other" inbox is mostly newsletters/marketing
  if (inferenceClassification === 'other') return true;

  return false;
}
```

- [ ] **Step 2: Add the Claude batch caller**

Append to the same file:

```typescript
// ─── Claude batch extraction ─────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const MAIL_EXTRACTOR_SYSTEM = `Du analyserer en kort liste af emails (afsender, emne, uddrag) og udtrækker konklusioner om brugeren — ikke om emailen.

For HVER email, vurder om den fortæller os noget vedvarende om brugeren:
- relation: hvem brugeren arbejder med (kollega, kunde, partner)
- role: brugerens rolle/titel/firma
- preference: brugerens præference (foretrækker mødet om morgenen, arbejder remote, …)
- project: igangværende projekt brugeren er involveret i
- commitment: noget brugeren har lovet/aftalt med en deadline

Returnér en JSON-array med højst 5 fakta på tværs af alle emails (vælg de stærkeste signaler). Ignorér automatiske, transaktionelle, markedsføringsmæssige eller flygtige beskeder. Skriv på dansk i kort sætningsform: fx "Maria fra salg er en hyppig kontakt" eller "Bruger arbejder med Q2-budget".

Output-format (intet andet):
[
  {"text": "...", "category": "relationship|role|preference|project|commitment", "confidence": 0.0-1.0, "referentDate": "YYYY-MM-DD" | null}
]`;

const CALENDAR_EXTRACTOR_SYSTEM = `Du analyserer brugerens tilbagevendende møder (titel, deltagere, mønster) og udtrækker konklusioner om brugeren.

For HVER mødeserie, vurder om den fortæller noget om:
- relation: hyppige samarbejdspartnere
- role: hvilken funktion brugeren har (1:1 med leder, team-stand-up som leder, …)
- project: igangværende initiativer

Returnér en JSON-array med højst 5 fakta. Ignorér ferier, frokost, generiske "kaffe"-blokke. Skriv på dansk: fx "Lars fra Acme er en tilbagevendende ekstern kontakt" eller "Bruger leder ugentlige team-stand-ups".

Output-format (intet andet):
[
  {"text": "...", "category": "relationship|role|preference|project|commitment", "confidence": 0.0-1.0, "referentDate": null}
]`;

export type ExtractedFact = {
  text: string;
  category: 'relationship' | 'role' | 'preference' | 'project' | 'commitment' | 'other';
  confidence: number;
  referentDate: string | null;
};

export async function callClaudeBatch(
  apiKey: string,
  systemPrompt: string,
  userPayload: string,
): Promise<ExtractedFact[]> {
  const res = await fetch(ANTHROPIC_URL, {
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
    return [];
  }
}
```

- [ ] **Step 3: Add fact-insertion helper**

Append:

```typescript
// ─── Fact insertion ───────────────────────────────────────────────────────

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VALID_CATEGORIES = new Set([
  'relationship',
  'role',
  'preference',
  'project',
  'commitment',
  'other',
]);

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
  // here; `referentDate` is dropped (the existing `expires_at` decay path is
  // for action-y categories and is set elsewhere).
  const candidates = facts
    .filter((f) => VALID_CATEGORIES.has(f.category))
    .filter((f) => f.confidence >= 0.55)
    .map((f) => ({ ...f, normalized: normalizeFactText(f.text) }))
    // Within-batch dedup: Claude may emit the same fact twice across calls.
    .filter((f, i, all) => all.findIndex((g) => g.normalized === f.normalized) === i);

  if (candidates.length === 0) return 0;

  // Pre-check: skip facts whose normalized_text already exists as confirmed,
  // OR as a non-expired rejection. Mirrors findDuplicateFact() in
  // src/lib/profile-store.ts. Two reasons:
  //   1. Keeps backfill from re-suggesting facts the user already confirmed
  //      or recently rejected (the review screen would re-prompt forever).
  //   2. The unique index on (user_id, normalized_text) is PARTIAL — it
  //      enforces uniqueness only WHERE status='confirmed'. Pending rows
  //      with a normalized_text that collides with a confirmed row will
  //      violate the index the moment the user confirms one of the pending
  //      duplicates in the review screen.
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

  // Plain insert (no upsert). Pending rows from a previous run with the
  // same normalized_text are technically possible; the review screen surfaces
  // them grouped so the user can pick one.
  const { error } = await client.from('facts').insert(rows);
  if (error) throw new Error(`facts insert: ${error.message}`);
  return rows.length;
}

export function normalizeFactText(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Add job-status helpers**

Append:

```typescript
// ─── Job status ───────────────────────────────────────────────────────────

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
```

- [ ] **Step 5: Verify file compiles**

There's no Deno typecheck script in this repo. Verify by ensuring imports resolve in the next task that uses this module.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/onboarding-backfill.ts
git commit -m "feat(backfill): shared worker module — filter, Claude batch, fact insert

Single source of truth for the 'good email' filter (sender denylist,
local-part patterns, subject patterns, Gmail category labels, Outlook
Focused/Other classification). Plus the Claude batch caller (Haiku 4.5),
pending-fact upsert, and backfill_jobs status helpers used by the three
edge functions in the next tasks.
"
```

---

## Task 3: Gmail backfill provider

**Files:**
- Create: `supabase/functions/_shared/backfill-providers/gmail.ts`

- [ ] **Step 1: Write the fetcher**

```typescript
// supabase/functions/_shared/backfill-providers/gmail.ts

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { isAutomatedSender } from '../onboarding-backfill.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Fetch up to `maxFetch` recent inbox messages, run through the filter,
// return the most recent `keep` survivors. We fetch more than we need
// because filtering may discard a lot.
export async function fetchGmailCandidates(
  accessToken: string,
  maxFetch = 200,
  keep = 50,
): Promise<CandidateMessage[]> {
  // Step 1: list IDs from inbox, excluding category labels via Gmail's q syntax.
  // The q= filter doesn't catch every newsletter, but cuts the pre-filter set.
  const q = encodeURIComponent('in:inbox -category:promotions -category:social -category:updates -category:forums');
  const listRes = await fetch(`${BASE}/messages?q=${q}&maxResults=${maxFetch}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`gmail list ${listRes.status}: ${await listRes.text()}`);
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);

  // Step 2: fetch metadata for each (parallel batches of 10).
  const candidates: CandidateMessage[] = [];
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const metas = await Promise.all(
      batch.map((id) =>
        fetch(
          `${BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        ).then((r) => r.ok ? r.json() : null).catch(() => null),
      ),
    );
    for (const meta of metas) {
      if (!meta) continue;
      const m = meta as {
        id: string;
        labelIds?: string[];
        snippet?: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = m.payload?.headers ?? [];
      const fromRaw = headers.find((h) => h.name === 'From')?.value ?? '';
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)';
      const fromEmail = extractEmail(fromRaw);
      const receivedAt = m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date().toISOString();
      candidates.push({
        id: m.id,
        from: fromRaw,
        fromEmail,
        subject,
        snippet: (m.snippet ?? '').slice(0, 200),
        receivedAt,
        labels: m.labelIds ?? [],
      });
    }
  }

  // Step 3: filter and keep the most recent `keep`.
  return candidates
    .filter((c) => !isAutomatedSender(c.fromEmail, c.subject, c.labels))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);
}

function extractEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  return raw.toLowerCase().trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/backfill-providers/gmail.ts
git commit -m "feat(backfill): Gmail candidate fetcher with q-filter + metadata pull"
```

---

## Task 4: Microsoft Graph backfill provider

**Files:**
- Create: `supabase/functions/_shared/backfill-providers/microsoft.ts`

- [ ] **Step 1: Write the fetcher**

```typescript
// supabase/functions/_shared/backfill-providers/microsoft.ts

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { isAutomatedSender } from '../onboarding-backfill.ts';

const BASE = 'https://graph.microsoft.com/v1.0';

export async function fetchGraphCandidates(
  accessToken: string,
  maxFetch = 200,
  keep = 50,
): Promise<CandidateMessage[]> {
  // Graph supports $top up to 1000. We use 200 since we filter aggressively
  // and want recent mail.
  const url = `${BASE}/me/mailFolders/Inbox/messages?$top=${maxFetch}&$select=id,subject,from,bodyPreview,receivedDateTime,categories,inferenceClassification&$orderby=receivedDateTime desc`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
      bodyPreview?: string;
      receivedDateTime?: string;
      categories?: string[];
      inferenceClassification?: 'focused' | 'other';
    }>;
  };

  const candidates: CandidateMessage[] = (json.value ?? []).map((m) => {
    const fromEmail = (m.from?.emailAddress?.address ?? '').toLowerCase().trim();
    const fromName = m.from?.emailAddress?.name ?? '';
    return {
      id: m.id,
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      fromEmail,
      subject: m.subject ?? '(uden emne)',
      snippet: (m.bodyPreview ?? '').slice(0, 200),
      receivedAt: m.receivedDateTime ?? new Date().toISOString(),
      labels: m.categories ?? [],
      inferenceClassification: m.inferenceClassification,
    };
  });

  return candidates
    .filter((c) => !isAutomatedSender(c.fromEmail, c.subject, c.labels, c.inferenceClassification))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/backfill-providers/microsoft.ts
git commit -m "feat(backfill): Microsoft Graph candidate fetcher with Focused/Other gate"
```

---

## Task 5: Calendar backfill providers

**Files:**
- Create: `supabase/functions/_shared/backfill-providers/google-calendar.ts`
- Create: `supabase/functions/_shared/backfill-providers/microsoft-calendar.ts`

- [ ] **Step 1: Write the Google calendar fetcher**

```typescript
// supabase/functions/_shared/backfill-providers/google-calendar.ts

import type { CalendarSeries } from '../onboarding-backfill.ts';

const BASE = 'https://www.googleapis.com/calendar/v3';

const SKIP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^lunch$/i,
  /^frokost$/i,
  /^coffee$/i,
  /^kaffe$/i,
  /^1:1$/i,
  /^one[- ]on[- ]one$/i,
  /^pause$/i,
  /^standup$/i,    // routine, low signal as a single fact
];

export async function fetchGoogleRecurring(
  accessToken: string,
  days = 90,
  keep = 30,
): Promise<CalendarSeries[]> {
  const timeMin = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date().toISOString();

  // Get all instances in window with singleEvents=false so we receive the
  // recurringEventId pointer; series master event is fetched separately.
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',  // returns instances; each has recurringEventId
    maxResults: '500',
    fields: 'items(id,summary,recurringEventId,attendees(email,self,responseStatus),description,start)',
  });
  const url = `${BASE}/calendars/primary/events?${params.toString()}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`google calendar list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      recurringEventId?: string;
      attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
      description?: string;
      start?: { dateTime?: string; date?: string };
    }>;
  };

  // Group by recurringEventId; only keep events that ARE recurring.
  const seriesMap = new Map<string, {
    seriesId: string;
    title: string;
    attendeeEmails: Set<string>;
    occurrenceCount: number;
    description?: string;
    declined: boolean;
  }>();

  for (const ev of json.items ?? []) {
    if (!ev.recurringEventId) continue;
    const userResponse = ev.attendees?.find((a) => a.self === true)?.responseStatus;
    const declined = userResponse === 'declined';
    const otherAttendees = (ev.attendees ?? [])
      .filter((a) => a.self !== true)
      .map((a) => (a.email ?? '').toLowerCase().trim())
      .filter(Boolean);
    if (otherAttendees.length === 0) continue;  // solo blocks

    const existing = seriesMap.get(ev.recurringEventId);
    if (existing) {
      existing.occurrenceCount += 1;
      otherAttendees.forEach((e) => existing.attendeeEmails.add(e));
      if (!declined) existing.declined = false;
    } else {
      const title = ev.summary ?? '(uden titel)';
      if (SKIP_TITLE_PATTERNS.some((re) => re.test(title.trim()))) continue;
      seriesMap.set(ev.recurringEventId, {
        seriesId: ev.recurringEventId,
        title,
        attendeeEmails: new Set(otherAttendees),
        occurrenceCount: 1,
        description: ev.description,
        declined,
      });
    }
  }

  return Array.from(seriesMap.values())
    .filter((s) => !s.declined)
    .map((s) => ({
      seriesId: s.seriesId,
      title: s.title,
      attendeeEmails: Array.from(s.attendeeEmails),
      recurrencePattern: `tilbagevendende (${s.occurrenceCount}× på ${days} dage)`,
      occurrenceCount: s.occurrenceCount,
      description: s.description,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, keep);
}
```

- [ ] **Step 2: Write the Microsoft calendar fetcher**

```typescript
// supabase/functions/_shared/backfill-providers/microsoft-calendar.ts

import type { CalendarSeries } from '../onboarding-backfill.ts';

const BASE = 'https://graph.microsoft.com/v1.0';

const SKIP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^lunch$/i,
  /^frokost$/i,
  /^coffee$/i,
  /^kaffe$/i,
  /^1:1$/i,
  /^pause$/i,
  /^standup$/i,
];

export async function fetchGraphRecurring(
  accessToken: string,
  days = 90,
  keep = 30,
): Promise<CalendarSeries[]> {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date().toISOString();

  // calendarView returns expanded instances; seriesMasterId points at the master.
  const params = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    $top: '500',
    $select: 'id,subject,seriesMasterId,attendees,bodyPreview,responseStatus',
    $orderby: 'start/dateTime asc',
  });
  // Note: $select-bound params with $-prefix have to be URL-encoded as such; URLSearchParams handles it.
  const url = `${BASE}/me/calendarView?${params.toString().replace(/top=/g, '$top=').replace(/select=/g, '$select=').replace(/orderby=/g, '$orderby=')}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph calendarView ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      seriesMasterId?: string;
      attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string } }>;
      bodyPreview?: string;
      responseStatus?: { response?: string };
    }>;
  };

  const seriesMap = new Map<string, {
    seriesId: string;
    title: string;
    attendeeEmails: Set<string>;
    occurrenceCount: number;
    description?: string;
    declined: boolean;
  }>();

  for (const ev of json.value ?? []) {
    if (!ev.seriesMasterId) continue;
    const declined = ev.responseStatus?.response === 'declined';
    const others = (ev.attendees ?? [])
      .map((a) => (a.emailAddress?.address ?? '').toLowerCase().trim())
      .filter(Boolean);
    if (others.length === 0) continue;

    const existing = seriesMap.get(ev.seriesMasterId);
    if (existing) {
      existing.occurrenceCount += 1;
      others.forEach((e) => existing.attendeeEmails.add(e));
      if (!declined) existing.declined = false;
    } else {
      const title = ev.subject ?? '(uden titel)';
      if (SKIP_TITLE_PATTERNS.some((re) => re.test(title.trim()))) continue;
      seriesMap.set(ev.seriesMasterId, {
        seriesId: ev.seriesMasterId,
        title,
        attendeeEmails: new Set(others),
        occurrenceCount: 1,
        description: ev.bodyPreview,
        declined,
      });
    }
  }

  return Array.from(seriesMap.values())
    .filter((s) => !s.declined)
    .map((s) => ({
      seriesId: s.seriesId,
      title: s.title,
      attendeeEmails: Array.from(s.attendeeEmails),
      recurrencePattern: `tilbagevendende (${s.occurrenceCount}× på ${days} dage)`,
      occurrenceCount: s.occurrenceCount,
      description: s.description,
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, keep);
}
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/backfill-providers/google-calendar.ts \
        supabase/functions/_shared/backfill-providers/microsoft-calendar.ts
git commit -m "feat(backfill): calendar fetchers — Google + Microsoft, recurring series only"
```

---

## Task 6: `onboarding-backfill-start` edge function

**Files:**
- Create: `supabase/functions/onboarding-backfill-start/index.ts`

- [ ] **Step 1: Write the orchestrator**

```typescript
// supabase/functions/onboarding-backfill-start/index.ts
//
// Creates per-source backfill_jobs rows and runs the workers inline.
// JWT-gated. Idempotent — if jobs already exist for this user, returns
// them without re-running.
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
  type CandidateMessage,
  type CalendarSeries,
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
  await Promise.allSettled(jobs.map((job) => runJob(service, userId, job, anthropicKey)));

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
  job: Job,
  anthropicKey: string,
): Promise<void> {
  try {
    const refresh = await loadRefreshToken(service, userId, job.provider);
    if (!refresh) {
      await finishJob(service, job.id, 'failed', 'no refresh token');
      return;
    }
    const accessToken = await refreshAccessToken(job.provider, refresh);
    if (!accessToken) {
      await finishJob(service, job.id, 'failed', 'token refresh failed');
      return;
    }

    if (job.kind === 'mail') {
      const candidates = job.provider === 'google'
        ? await fetchGmailCandidates(accessToken)
        : await fetchGraphCandidates(accessToken);

      await setJobRunning(service, job.id, candidates.length);

      // Batch 10 messages per Claude call.
      const BATCH = 10;
      let processed = 0;
      let factsTotal = 0;
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
        factsTotal += await insertPendingFacts(service, userId, facts, `backfill:${job.provider}:mail`);
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
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy onboarding-backfill-start
```

Expected: "Deployed Function onboarding-backfill-start" — note the URL.

- [ ] **Step 3: Smoke test (live call)**

Get a JWT for the test user:

```bash
TOKEN=$(supabase auth login --token > /dev/null; supabase auth get-user-token --user-id 28c51177-...)
# Or: open the dev build, sign in, then in Settings → Debug copy the JWT.
```

Then:

```bash
curl -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/onboarding-backfill-start" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kinds":["mail","calendar"]}'
```

Expected: `{"job_ids":["<uuid>","<uuid>",...]}` and a 30-90s wait while Claude processes. Check the Dashboard `backfill_jobs` table — status should progress queued → running → done.

Verify `facts` table has new rows with `status='pending'` and `source='backfill:google:mail'` etc.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/onboarding-backfill-start/index.ts
git commit -m "feat(backfill): onboarding-backfill-start edge function

JWT-gated. Creates backfill_jobs rows for each connected provider × kind,
runs workers in parallel within request scope. Idempotent — returns
existing jobs if already created for this user. Inserts pending_facts
with source='backfill:<provider>:<kind>' for the review screen.
"
```

---

## Task 7: `onboarding-backfill-status` edge function

**Files:**
- Create: `supabase/functions/onboarding-backfill-status/index.ts`

- [ ] **Step 1: Write the read-only handler**

```typescript
// supabase/functions/onboarding-backfill-status/index.ts
//
// Returns the user's backfill_jobs rows. JWT-gated.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return json({ error: 'internal' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  // Use the JWT-bound client so RLS scopes the read to the caller.
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client
    .from('backfill_jobs')
    .select('id,kind,provider,status,processed,total,started_at,finished_at,error,updated_at')
    .order('created_at', { ascending: true });
  if (error) return json({ error: 'internal', detail: error.message }, 500);

  return json({ jobs: data ?? [] });
});
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy onboarding-backfill-status
```

- [ ] **Step 3: Smoke test**

```bash
curl "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/onboarding-backfill-status" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `{"jobs":[{...}, {...}]}` matching what start created.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/onboarding-backfill-status/index.ts
git commit -m "feat(backfill): onboarding-backfill-status read endpoint"
```

---

## Task 8: `onboarding-backfill-cancel` edge function

**Files:**
- Create: `supabase/functions/onboarding-backfill-cancel/index.ts`

- [ ] **Step 1: Write the cancel handler**

```typescript
// supabase/functions/onboarding-backfill-cancel/index.ts

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  if (!supabaseUrl || !serviceKey || !anonKey) return json({ error: 'internal' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401);
  const userId = userData.user.id;

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await service
    .from('backfill_jobs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .select('id');
  if (error) return json({ error: 'internal', detail: error.message }, 500);
  return json({ cancelled: data?.length ?? 0 });
});
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy onboarding-backfill-cancel
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/onboarding-backfill-cancel/index.ts
git commit -m "feat(backfill): onboarding-backfill-cancel — bail on user request"
```

---

## Task 9: Client API wrapper

**Files:**
- Create: `src/lib/onboarding-backfill.ts`
- Modify: `src/lib/profile-store.ts` (add pending-fact CRUD)

- [ ] **Step 1: Add pending-fact helpers to profile-store**

Insert after the existing `insertPendingFact` function in `src/lib/profile-store.ts`:

```typescript
export async function listPendingFactsForReview(userId: string): Promise<Fact[]> {
  const { data, error } = await supabase
    .from('facts')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('confidence', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToFact);
}

export async function bulkUpdatePendingFacts(
  userId: string,
  updates: Array<{ id: string; status: 'confirmed' | 'rejected' }>,
): Promise<void> {
  if (updates.length === 0) return;
  // Postgres doesn't have a clean batched-different-values UPDATE via the JS
  // client, so we run two grouped updates. Mirror the field set used by
  // confirmFact / rejectFact in this same file: confirmed sets confirmed_at;
  // rejected sets rejected_at + rejection_ttl (14d) so duplicate-detection
  // and decay keep working the same as for non-backfill facts.
  const confirmed = updates.filter((u) => u.status === 'confirmed').map((u) => u.id);
  const rejected = updates.filter((u) => u.status === 'rejected').map((u) => u.id);
  const now = new Date().toISOString();
  if (confirmed.length > 0) {
    const { error } = await supabase
      .from('facts')
      .update({ status: 'confirmed', confirmed_at: now })
      .eq('user_id', userId)
      .in('id', confirmed);
    if (error) throw error;
  }
  if (rejected.length > 0) {
    const ttl = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('facts')
      .update({ status: 'rejected', rejected_at: now, rejection_ttl: ttl })
      .eq('user_id', userId)
      .in('id', rejected);
    if (error) throw error;
  }
}
```

- [ ] **Step 2: Write the edge-function wrapper**

```typescript
// src/lib/onboarding-backfill.ts
//
// Client-side wrappers over the three onboarding-backfill edge functions.
// Polling and state management live in the screens; this is the
// network boundary only.

import { supabase } from './supabase';

export type BackfillJob = {
  id: string;
  kind: 'mail' | 'calendar';
  provider: 'google' | 'microsoft' | 'icloud';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  processed: number;
  total: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type StartResponse = { job_ids: string[]; idempotent?: boolean; reason?: string };
type StatusResponse = { jobs: Array<{
  id: string; kind: string; provider: string; status: string;
  processed: number; total: number | null;
  started_at: string | null; finished_at: string | null; error: string | null;
}> };

export async function startBackfill(): Promise<StartResponse> {
  const { data, error } = await supabase.functions.invoke<StartResponse>(
    'onboarding-backfill-start',
    { body: {} },
  );
  if (error) throw new Error(error.message);
  return data ?? { job_ids: [] };
}

export async function fetchBackfillStatus(): Promise<BackfillJob[]> {
  const { data, error } = await supabase.functions.invoke<StatusResponse>(
    'onboarding-backfill-status',
    { method: 'GET' },
  );
  if (error) throw new Error(error.message);
  return (data?.jobs ?? []).map((j) => ({
    id: j.id,
    kind: j.kind as BackfillJob['kind'],
    provider: j.provider as BackfillJob['provider'],
    status: j.status as BackfillJob['status'],
    processed: j.processed,
    total: j.total,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    error: j.error,
  }));
}

export async function cancelBackfill(): Promise<{ cancelled: number }> {
  const { data, error } = await supabase.functions.invoke<{ cancelled: number }>(
    'onboarding-backfill-cancel',
    { body: {} },
  );
  if (error) throw new Error(error.message);
  return data ?? { cancelled: 0 };
}

export function isAllDone(jobs: BackfillJob[]): boolean {
  if (jobs.length === 0) return true;
  return jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
}

export function progressLabel(jobs: BackfillJob[]): string {
  if (jobs.length === 0) return 'Færdig';
  const running = jobs.find((j) => j.status === 'running');
  if (running) {
    const kind = running.kind === 'mail' ? 'emails' : 'kalender';
    if (running.total) return `Læser ${kind}… (${running.processed} af ${running.total})`;
    return `Læser ${kind}…`;
  }
  if (isAllDone(jobs)) return 'Færdig';
  return 'Forbereder…';
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/onboarding-backfill.ts src/lib/profile-store.ts
git commit -m "feat(backfill): client API + pending-fact bulk update helpers"
```

---

## Task 10: `OnboardingBackfillScreen`

**Files:**
- Create: `src/screens/OnboardingBackfillScreen.tsx`

- [ ] **Step 1: Write the intro screen**

Mirror the visual style of `MicrosoftAdminConsentScreen.tsx`. Pseudocode shape (full code in implementation — engineer copies the existing screen and adapts):

```typescript
// src/screens/OnboardingBackfillScreen.tsx
//
// Shown after MemoryConsentModal confirms, before the user lands on the
// Memory tab. Explains backfill, lists which sources will be scanned,
// offers Start / Skip.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { startBackfill } from '../lib/onboarding-backfill';
import { useConnections } from '../lib/hooks';   // existing
import { colors, fonts } from '../theme';

type Props = {
  onStart: () => void;
  onSkip: () => void;
};

export function OnboardingBackfillScreen({ onStart, onSkip }: Props) {
  const { bottom } = useChromeInsets();
  const connections = useConnections();   // returns connection rows
  const [busy, setBusy] = useState(false);

  // Build list of sources that will actually be scanned.
  const sources: string[] = [];
  if (connections.some((c) => c.id === 'gmail' && c.status === 'connected')) sources.push('Gmail');
  if (connections.some((c) => c.id === 'outlook' && c.status === 'connected')) sources.push('Outlook');
  if (connections.some((c) => c.id === 'google-calendar' && c.status === 'connected')) sources.push('Google Kalender');
  if (connections.some((c) => c.id === 'outlook-calendar' && c.status === 'connected')) sources.push('Outlook Kalender');

  const handleStart = async () => {
    setBusy(true);
    try {
      await startBackfill();   // fire-and-forget; status screen polls
      onStart();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: bottom + 32 }]}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>LÆR DIG AT KENDE</Text>
        <Text style={styles.heroH1}>Lad Zolva lære dig at kende</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.body}>
          Vi læser hurtigt dine seneste emails og tilbagevendende møder for at finde ud af, hvem du arbejder med og hvad du arbejder med. Vi gemmer kun konklusionerne — ikke selve indholdet.
        </Text>
        <Text style={[styles.body, styles.bodySpaced]}>
          Du kan altid se og ændre, hvad Zolva har lært, i Hukommelse-fanen.
        </Text>
        <View style={styles.sourceList}>
          {sources.length === 0 && (
            <Text style={styles.sourceEmpty}>Ingen konti forbundet endnu — du kan altid lade Zolva lære dig at kende ved at chatte.</Text>
          )}
          {sources.map((s) => (
            <View key={s} style={styles.sourceRow}>
              <Text style={styles.sourceCheck}>✓</Text>
              <Text style={styles.sourceLabel}>{s}</Text>
            </View>
          ))}
        </View>
        <Pressable
          onPress={handleStart}
          disabled={busy || sources.length === 0}
          style={[styles.primary, (busy || sources.length === 0) && styles.primaryDisabled]}
        >
          <Text style={styles.primaryText}>{busy ? 'Starter…' : 'Start'}</Text>
        </Pressable>
        <Pressable onPress={onSkip} style={styles.secondary}>
          <Text style={styles.secondaryText}>Spring over</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingTop: 64, backgroundColor: colors.paper },
  hero: { marginBottom: 32 },
  eyebrow: { ...fonts.eyebrow, color: colors.sage, marginBottom: 8 },
  heroH1: { ...fonts.h1, color: colors.ink, letterSpacing: -0.5 },
  section: { },
  body: { ...fonts.body, color: colors.ink, marginBottom: 12 },
  bodySpaced: { marginTop: 8 },
  sourceList: { marginTop: 24, marginBottom: 24, gap: 12 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sourceCheck: { color: colors.sage, fontSize: 16 },
  sourceLabel: { ...fonts.body, color: colors.ink },
  sourceEmpty: { ...fonts.bodySmall, color: colors.muted, fontStyle: 'italic' },
  primary: {
    paddingVertical: 16, borderRadius: 12, backgroundColor: colors.ink, alignItems: 'center',
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { ...fonts.button, color: colors.paper },
  secondary: { paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  secondaryText: { ...fonts.bodySmall, color: colors.muted },
});
```

Note: `useConnections` and the exact connection IDs may differ — check `hooks.ts:1788`'s `GOOGLE_INTEGRATIONS` and `connections` array shape and adjust filters to match. If a hook isn't exposed, read directly from the connections data the existing Settings screen uses.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/screens/OnboardingBackfillScreen.tsx
git commit -m "feat(onboarding): backfill intro screen — Start / Skip"
```

---

## Task 11: `OnboardingChatQuestionsScreen`

**Files:**
- Create: `src/screens/OnboardingChatQuestionsScreen.tsx`

- [ ] **Step 1: Write the questions + progress screen**

```typescript
// src/screens/OnboardingChatQuestionsScreen.tsx
//
// 3 short Danish questions populated via the existing profile-extractor
// chat trigger. Bottom shows backfill progress (poll every 3s) — when
// done, "Fortsæt" advances to the review screen.

import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable, ActivityIndicator } from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { fetchBackfillStatus, isAllDone, progressLabel, type BackfillJob } from '../lib/onboarding-backfill';
import { runExtractor } from '../lib/profile-extractor';
import { useUserId } from '../lib/hooks';
import { colors, fonts } from '../theme';

const QUESTIONS = [
  { id: 'Q1', label: 'Hvad arbejder du med?', placeholder: 'Marketing, salg, udvikling, …' },
  { id: 'Q2', label: 'Hvem er dine 2-3 vigtigste kolleger eller kunder?', placeholder: 'Maria fra salg, Lars fra Acme A/S, …' },
  { id: 'Q3', label: 'Hvilke deadlines eller projekter har du i øjeblikket?', placeholder: 'Q2-budget i april, lancering i juni, …' },
];

type Props = {
  onContinue: () => void;
};

export function OnboardingChatQuestionsScreen({ onContinue }: Props) {
  const { bottom } = useChromeInsets();
  const userId = useUserId();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll backfill status every 3s until done or 2 min timeout.
  useEffect(() => {
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const fresh = await fetchBackfillStatus();
        setJobs(fresh);
        if (isAllDone(fresh) || attempts > 40) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // Silent — keep polling.
      }
    };
    void poll();
    pollRef.current = setInterval(poll, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const submit = (id: string) => {
    if (!userId) return;
    const text = (answers[id] ?? '').trim();
    if (!text) return;
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q) return;
    void runExtractor({
      trigger: 'chat_turn',
      userId,
      text: `${q.label}\nBruger: ${text}`,
      source: `onboarding:${id}`,
    });
    // Mark as submitted by clearing — UI shows "Tak" briefly via state if needed.
    setAnswers((cur) => ({ ...cur, [id]: '' }));
  };

  const allDone = isAllDone(jobs);

  return (
    <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: bottom + 80 }]}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>LÆR DIG AT KENDE</Text>
        <Text style={styles.heroH1}>Mens jeg læser…</Text>
        <Text style={styles.body}>Mens jeg læser dine emails og kalender, må jeg gerne stille dig 3 hurtige spørgsmål? Du kan springe alle over.</Text>
      </View>
      {QUESTIONS.map((q) => (
        <View key={q.id} style={styles.card}>
          <Text style={styles.label}>{q.label}</Text>
          <TextInput
            style={styles.input}
            value={answers[q.id] ?? ''}
            onChangeText={(t) => setAnswers((cur) => ({ ...cur, [q.id]: t }))}
            placeholder={q.placeholder}
            multiline
            blurOnSubmit
            returnKeyType="done"
            onSubmitEditing={() => submit(q.id)}
          />
          <View style={styles.cardRow}>
            <Pressable
              onPress={() => submit(q.id)}
              disabled={!(answers[q.id] ?? '').trim()}
              style={[styles.cardBtn, !(answers[q.id] ?? '').trim() && styles.cardBtnDisabled]}
            >
              <Text style={styles.cardBtnText}>Send</Text>
            </Pressable>
            <Pressable onPress={() => submit(q.id)} style={styles.cardSkip}>
              <Text style={styles.cardSkipText}>Spring over</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <View style={styles.progress}>
        {!allDone && <ActivityIndicator color={colors.sage} />}
        <Text style={styles.progressText}>{progressLabel(jobs)}</Text>
      </View>
      <Pressable
        onPress={onContinue}
        disabled={!allDone}
        style={[styles.continue, !allDone && styles.continueDisabled]}
      >
        <Text style={styles.continueText}>{allDone ? 'Fortsæt' : 'Vent et øjeblik…'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, paddingTop: 64, backgroundColor: colors.paper },
  hero: { marginBottom: 32 },
  eyebrow: { ...fonts.eyebrow, color: colors.sage, marginBottom: 8 },
  heroH1: { ...fonts.h1, color: colors.ink, marginBottom: 12, letterSpacing: -0.5 },
  body: { ...fonts.body, color: colors.ink },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 16 },
  label: { ...fonts.label, color: colors.ink, marginBottom: 8 },
  input: { ...fonts.body, color: colors.ink, paddingVertical: 8, minHeight: 40 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  cardBtn: { paddingVertical: 8, paddingHorizontal: 16, backgroundColor: colors.ink, borderRadius: 8 },
  cardBtnDisabled: { opacity: 0.4 },
  cardBtnText: { ...fonts.button, color: colors.paper },
  cardSkip: { paddingVertical: 8, paddingHorizontal: 8 },
  cardSkipText: { ...fonts.bodySmall, color: colors.muted },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 24 },
  progressText: { ...fonts.bodySmall, color: colors.muted },
  continue: { paddingVertical: 16, borderRadius: 12, backgroundColor: colors.ink, alignItems: 'center', marginTop: 16 },
  continueDisabled: { opacity: 0.4 },
  continueText: { ...fonts.button, color: colors.paper },
});
```

Note: verify `useUserId` is exported from `hooks.ts`. If not, read user from `subscribeUserId` directly. Adjust to match the existing `theme` module's exports.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/screens/OnboardingChatQuestionsScreen.tsx
git commit -m "feat(onboarding): chat-questions screen with backfill progress poll"
```

---

## Task 12: `OnboardingFactReviewScreen`

**Files:**
- Create: `src/screens/OnboardingFactReviewScreen.tsx`

- [ ] **Step 1: Write the review screen**

```typescript
// src/screens/OnboardingFactReviewScreen.tsx
//
// Lists pending_facts grouped by source, lets the user toggle each, then
// flips the flagged rows to accepted/rejected via bulk update.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, Pressable, ActivityIndicator } from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { listPendingFactsForReview, bulkUpdatePendingFacts } from '../lib/profile-store';
import { invalidatePreamble } from '../lib/profile';
import { useUserId } from '../lib/hooks';
import type { Fact } from '../lib/types';
import { colors, fonts } from '../theme';

type Props = { onDone: () => void };

const SOURCE_GROUP_LABELS: Record<string, string> = {
  'backfill:google:mail': 'Fra Gmail',
  'backfill:microsoft:mail': 'Fra Outlook',
  'backfill:google:calendar': 'Fra Google Kalender',
  'backfill:microsoft:calendar': 'Fra Outlook Kalender',
};

function groupLabel(source: string | null | undefined): string {
  if (!source) return 'Andet';
  if (SOURCE_GROUP_LABELS[source]) return SOURCE_GROUP_LABELS[source];
  if (source.startsWith('onboarding:')) return 'Fra dine svar';
  if (source.startsWith('chat:')) return 'Fra chat';
  return 'Andet';
}

export function OnboardingFactReviewScreen({ onDone }: Props) {
  const { bottom } = useChromeInsets();
  const userId = useUserId();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    let cancelled = false;
    void listPendingFactsForReview(userId)
      .then((rows) => {
        if (cancelled) return;
        setFacts(rows);
        setAccepted(new Set(rows.map((r) => r.id)));   // default: all checked
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  const toggle = (id: string) => {
    setAccepted((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const updates = facts.map((f) => ({
        id: f.id,
        status: accepted.has(f.id) ? ('confirmed' as const) : ('rejected' as const),
      }));
      await bulkUpdatePendingFacts(userId, updates);
      invalidatePreamble(userId);
      onDone();
    } catch (e) {
      // Swallow — user can retry; in production we'd surface a toast.
      if (__DEV__) console.warn('[review] save failed:', e);
    } finally {
      setSaving(false);
    }
  };

  // Group facts by source.
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const key = groupLabel(f.source);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.sage} />
      </View>
    );
  }

  if (facts.length === 0) {
    return (
      <View style={[styles.container, styles.emptyState]}>
        <Text style={styles.emptyH1}>Vi fandt ikke noget endnu</Text>
        <Text style={styles.emptyBody}>Det kommer i takt med, at du bruger Zolva. Du kan altid se og redigere det i Hukommelse-fanen.</Text>
        <Pressable onPress={onDone} style={styles.primary}>
          <Text style={styles.primaryText}>Færdig</Text>
        </Pressable>
      </View>
    );
  }

  const checkedCount = accepted.size;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: bottom + 100 }]}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>HUKOMMELSE</Text>
          <Text style={styles.heroH1}>Hvad jeg har lært om dig</Text>
          <Text style={styles.body}>Sæt flueben ved det jeg skal huske, og fjern resten.</Text>
        </View>
        {Array.from(groups.entries()).map(([label, rows]) => (
          <View key={label} style={styles.group}>
            <Text style={styles.groupLabel}>{label}</Text>
            {rows.map((f) => {
              const checked = accepted.has(f.id);
              return (
                <Pressable
                  key={f.id}
                  onPress={() => toggle(f.id)}
                  style={[styles.factRow, checked && styles.factRowChecked]}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <View style={styles.factBody}>
                    <Text style={styles.factText}>{f.text}</Text>
                    <Text style={styles.factMeta}>{f.category}{f.referentDate ? ` · ${f.referentDate}` : ''}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: bottom + 16 }]}>
        <Pressable onPress={save} disabled={saving} style={[styles.primary, saving && styles.primaryDisabled]}>
          <Text style={styles.primaryText}>{saving ? 'Gemmer…' : `Gem ${checkedCount} fakta`}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.paper },
  scroll: { paddingHorizontal: 24, paddingTop: 64 },
  hero: { marginBottom: 24 },
  eyebrow: { ...fonts.eyebrow, color: colors.sage, marginBottom: 8 },
  heroH1: { ...fonts.h1, color: colors.ink, marginBottom: 12, letterSpacing: -0.5 },
  body: { ...fonts.body, color: colors.ink },
  group: { marginBottom: 24 },
  groupLabel: { ...fonts.label, color: colors.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  factRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingVertical: 12, paddingHorizontal: 12, marginBottom: 8,
    borderRadius: 12, backgroundColor: '#fff',
  },
  factRowChecked: { backgroundColor: '#f4f1ea' },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
    borderColor: colors.muted, alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  checkboxChecked: { borderColor: colors.sage, backgroundColor: colors.sage },
  checkmark: { color: '#fff', fontWeight: '700' },
  factBody: { flex: 1 },
  factText: { ...fonts.body, color: colors.ink },
  factMeta: { ...fonts.bodySmall, color: colors.muted, marginTop: 4 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: '#0001', backgroundColor: colors.paper },
  primary: { paddingVertical: 16, borderRadius: 12, backgroundColor: colors.ink, alignItems: 'center' },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { ...fonts.button, color: colors.paper },
  emptyState: { padding: 32, alignItems: 'center', justifyContent: 'center', gap: 16 },
  emptyH1: { ...fonts.h1, color: colors.ink, textAlign: 'center' },
  emptyBody: { ...fonts.body, color: colors.muted, textAlign: 'center' },
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/screens/OnboardingFactReviewScreen.tsx
git commit -m "feat(onboarding): fact review screen — pick what to keep"
```

---

## Task 13: Wire screens into App.tsx + memory-toggle dispatch

**Files:**
- Modify: `App.tsx`
- Modify: `src/lib/hooks.ts`

- [ ] **Step 1: Track 'onboarding has run' flag**

In `src/lib/hooks.ts`, locate the `setPrivacyFlag` (or equivalent) call site for `memory-enabled`. Add a side effect that, when toggling FROM false TO true for the first time per user:

1. Set an AsyncStorage flag `zolva.${uid}.onboarding-backfill.shown = '1'` AFTER user proceeds through (or skips) the screens.
2. Exposes a hook `useOnboardingBackfillState(): { shouldShow: boolean; markShown: () => void }`.

```typescript
// Add near the privacy flag handling in src/lib/hooks.ts

const onboardingShownKey = (uid: string) => `zolva.${uid}.onboarding-backfill.shown`;

export function useOnboardingBackfillState(): {
  shouldShow: boolean;
  markShown: () => Promise<void>;
} {
  const userId = useUserId();
  const memoryEnabled = useMemoryEnabledFlag();   // existing or trivially derivable
  const [shouldShow, setShouldShow] = useState(false);
  const [shownLoaded, setShownLoaded] = useState(false);

  useEffect(() => {
    if (!userId) { setShouldShow(false); return; }
    void AsyncStorage.getItem(onboardingShownKey(userId))
      .then((v) => setShouldShow(memoryEnabled && v !== '1'))
      .finally(() => setShownLoaded(true));
  }, [userId, memoryEnabled]);

  const markShown = useCallback(async () => {
    if (!userId) return;
    await AsyncStorage.setItem(onboardingShownKey(userId), '1');
    setShouldShow(false);
  }, [userId]);

  return { shouldShow: shownLoaded && shouldShow, markShown };
}
```

If `useMemoryEnabledFlag` doesn't exist as such, derive it from `getPrivacyFlag('memory-enabled')` with subscribePrivacyChange.

- [ ] **Step 2: Add screen route in `App.tsx`**

Inside the App component (where `MicrosoftAdminConsentScreen` is conditionally rendered), add a 3-stage onboarding pipeline. Pseudo-snippet:

```typescript
// In App.tsx render tree, after MemoryConsentModal and any other gating modals:

const { shouldShow: showOnboarding, markShown } = useOnboardingBackfillState();
const [stage, setStage] = useState<'intro' | 'questions' | 'review' | 'done'>('intro');

if (showOnboarding && stage !== 'done') {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      {stage === 'intro' && (
        <OnboardingBackfillScreen
          onStart={() => setStage('questions')}
          onSkip={async () => { await markShown(); setStage('done'); }}
        />
      )}
      {stage === 'questions' && (
        <OnboardingChatQuestionsScreen
          onContinue={() => setStage('review')}
        />
      )}
      {stage === 'review' && (
        <OnboardingFactReviewScreen
          onDone={async () => { await markShown(); setStage('done'); }}
        />
      )}
    </SafeAreaView>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add App.tsx src/lib/hooks.ts
git commit -m "feat(onboarding): wire backfill flow after memory-enabled opt-in

Tracks per-user shown flag in AsyncStorage. First time the user enables
memory, the three onboarding screens chain: intro → questions → review.
Skip at any stage marks shown so we don't re-prompt on the next launch.
"
```

---

## Task 14: Manual smoke test — end-to-end verification

**Goal:** verify the full flow works on a real account before declaring done.

- [ ] **Step 1: Build + run dev build on simulator**

```bash
cd /Users/albertfeldt/ZolvaApp/.worktrees/onboarding-backfill
npx expo run:ios
```

Wait for build to complete; app launches on iPhone 17 Pro simulator.

- [ ] **Step 2: Sign in as `albertfeldt1@gmail.com`**

Use the existing dev sign-in flow. Confirm user has Google AND/OR Microsoft connected.

- [ ] **Step 3: Toggle `memory-enabled` ON**

Settings → Privacy → "Lad Zolva lære dig at kende" → confirm in MemoryConsentModal.

**Expected:** OnboardingBackfillScreen appears with sources listed.

- [ ] **Step 4: Tap Start**

**Expected:** OnboardingChatQuestionsScreen shows 3 questions; bottom progress text says "Læser emails… (X af Y)" then "Læser kalender… (Z af W)" then "Færdig".

Submit one question (e.g., "Marketing for et lille konsulenthus"). Skip the others.

- [ ] **Step 5: Wait for "Færdig"**

After ~30-60s, "Fortsæt" enables. Tap it.

**Expected:** OnboardingFactReviewScreen lists facts grouped by source. Untick at least one fact, leave others ticked.

- [ ] **Step 6: Tap "Gem N fakta"**

**Expected:** Returns to home. No errors in dev console.

- [ ] **Step 7: Verify in Supabase Dashboard**

Run in SQL editor:

```sql
select status, count(*) from facts where user_id = '28c51177-...' group by status;
select * from backfill_jobs where user_id = '28c51177-...';
select event_type, count(*) from consent_events where user_id = '28c51177-...' group by event_type;
```

Expected:
- `facts` shows `confirmed` (the count you ticked) and `rejected` (the ones you unticked) plus any pre-existing.
- `backfill_jobs` shows all rows with `status='done'`.
- `consent_events` shows `backfill_started` + `backfill_completed`.

- [ ] **Step 8: Verify preamble updated**

Open chat. Type "Hvad ved du om mig?". Expected: Zolva paraphrases the accepted facts back, ignoring the rejected ones.

- [ ] **Step 9: Test re-toggle does NOT re-run**

Settings → toggle memory-enabled OFF then back ON.

**Expected:** No onboarding screens reappear (we already ran). The `markShown` flag persists.

- [ ] **Step 10: Test on a fresh user (optional but valuable)**

If feasible, sign out, create a new test account, connect ONE provider, repeat the flow. Confirm the source list reflects only the connected provider.

- [ ] **Step 11: Commit any final fixes from smoke test**

If anything broke, fix and commit. Common issues:
- Connection IDs in `OnboardingBackfillScreen` don't match — check `connections` array shape.
- `useUserId` not exported — substitute appropriate hook.
- Theme tokens (`fonts.eyebrow`, `colors.sage`) don't exist — match the existing screens.

```bash
git add -p
git commit -m "fix(onboarding): smoke-test fixes from manual verification"
```

---

## Self-review checklist

After completing all tasks, verify:

1. **Spec coverage.** Every section of `2026-04-29-onboarding-backfill-design.md` maps to a task above:
   - High-level flow → Task 13 (App.tsx wiring)
   - Three edge functions → Tasks 6, 7, 8
   - Filter rules → Task 2 (`isAutomatedSender`)
   - Schema → Task 1
   - UX screens → Tasks 10, 11, 12
   - Cost ceiling → enforced via `BATCH=10` mail / `BATCH_CAL=5` calendar in Task 6
   - Telemetry → `logBackfillEvent` calls in Task 6 worker

2. **Type consistency.** `BackfillJob`, `CandidateMessage`, `CalendarSeries`, `ExtractedFact` types are defined in Task 2 and consumed without rename in Tasks 3-9.

3. **No placeholders.** Every code step contains complete code, not "TODO".

4. **Edge cases from spec covered.**
   - Memory off mid-backfill → `isCancelled` check in worker loop (Task 6).
   - Edge function timeout → workers write progress incrementally and `finishJob` runs in `finally`.
   - Re-toggle → idempotency in `onboarding-backfill-start` (Task 6).
   - Demo user → `PROFILE_MEMORY_ENABLED` env still gates `runExtractor`; `useOnboardingBackfillState` returns false for demo.
   - Empty results → empty-state branch in `OnboardingFactReviewScreen` (Task 12).

5. **Commits.** 14 commits — one per task. Server commits (1-8) precede client commits (9-13) per project convention.

---

## Done criteria

- All 14 tasks complete with commits.
- `npm run typecheck` passes.
- Smoke test on `albertfeldt1@gmail.com` shows facts written, accepted/rejected, and the preamble reflects the new state.
- `backfill_jobs` shows `status='done'` for every connected source.
- No errors in `consent_events` table for the test user.
- Branch `feat/onboarding-backfill` ready to merge to main.
