# Onboarding Backfill — Design

**Status:** Draft
**Author:** Claude (with Albert)
**Date:** 2026-04-29

## Problem

A new Zolva user starts cold. Until they've chatted ~10 turns or interacted with mail enough times, the user-memory preamble is empty and the morning brief / chat replies are generic. From `2026-04-21-persistent-memory-design.md` we have a per-event extractor that learns facts forward from chat / mail-reply / mail-archive — but no historical seed.

The `poll-mail` edge function explicitly avoids historical fetch (sets `historyId` to "now" on first call), so even mail polling doesn't help bootstrap.

## Goal

When a user toggles `memory-enabled` ON for the first time, run a one-time **onboarding backfill** that seeds the `facts` table with what we can learn from their existing email + calendar + a short onboarding chat. After backfill, the user reviews "Hvad jeg har lært om dig" and ticks/unticks each fact before it goes live.

This is **not** a signup-time auto-scan. It's an explicit consent moment: the user toggles the switch, sees a screen explaining what we're about to read, taps "Start", waits ~30 seconds, then reviews what we found.

## Non-goals

- Continuous historical scanning — backfill is one-shot per user × source.
- Storing email bodies. We extract facts in-memory and discard the email content.
- Backfilling chat history (there is none for new users).
- Backfilling iCloud mail in this version. The IMAP proxy can pull recent messages but we accept that the iCloud signal is poorer; covered by future spec.
- Deep PDF / attachment extraction. Headers + 200-char preview only.

## High-level flow

```
User → Settings → toggles "Lad Zolva lære dig at kende" ON
  ↓
MemoryConsentModal (existing) explains what memory does
  ↓
NEW: OnboardingBackfillScreen — explains backfill, lists which sources will be scanned, "Start" / "Spring over" buttons
  ↓
[User picks Start]
  ↓
Client calls POST /functions/v1/onboarding-backfill-start with user JWT
  ↓
Edge function enqueues per-source jobs in backfill_jobs (one row per provider × kind)
  ↓
Edge function spawns worker tasks (one per job) inline within request-scope
  ↓
Worker fans out:
  • mail-backfill (Gmail / Microsoft) — last 50 candidates after filter
  • calendar-backfill (Google / Microsoft / iCloud) — last 90 days, recurring meetings only
  ↓
Each worker:
  • Fetches headers/metadata
  • Filters automated/promotional senders
  • Batches 10 messages → one Claude call
  • Writes pending_facts (status='pending') with source = 'backfill:<provider>:<kind>'
  • Updates backfill_jobs progress
  ↓
Client polls GET /functions/v1/onboarding-backfill-status every 3s for ~60s
  ↓
While waiting, NEW: OnboardingChatQuestionsScreen — 3-5 short Danish prompts, populates facts immediately via the existing chat extractor
  ↓
When ALL backfill_jobs reach 'done' OR timeout (90s):
  ↓
NEW: OnboardingFactReviewScreen — lists pending_facts with source labels (e.g. "fra Gmail", "fra kalender"), each row has a checkbox (default: checked), "Gem valgte fakta" / "Spring over alle" buttons
  ↓
On confirm: bulk update pending_facts.status: checked → 'confirmed', unchecked → 'rejected'
  ↓
Existing fact-decay + preamble logic picks up the accepted facts
```

## Architecture

### Server-side: three edge functions

**1. `onboarding-backfill-start`**
- POST, JWT-gated.
- Body: `{ kinds?: ('mail' | 'calendar')[] }` (default: both)
- Creates one `backfill_jobs` row per (user × provider × kind) where the user has a connected provider for that kind (Gmail/Microsoft/iCloud — but we skip iCloud mail in v1).
- Returns `{ job_ids: string[] }` and immediately calls Promise.allSettled to run the workers in-flight (we don't wait for completion before responding — we acknowledge job creation, the worker continues until function timeout or completion).
- Idempotent: if jobs for this user already exist with status='done' or 'running', returns those without re-running.

**2. `onboarding-backfill-status`**
- GET, JWT-gated.
- Returns the user's `backfill_jobs` rows: `[{id, kind, provider, status, processed, total, started_at, finished_at, error}]`.
- Client polls this until all `status` ∈ {'done', 'failed', 'cancelled'}.

**3. `onboarding-backfill-cancel`**
- POST, JWT-gated.
- Marks any 'queued' or 'running' jobs for the user as 'cancelled'.
- Workers check status mid-loop and bail.

### Server-side: shared worker logic

`supabase/functions/_shared/onboarding-backfill.ts` exports:

- `runMailBackfill(client, userId, provider, jobId)` — fetches up to 200 candidates, filter to 50 "good" emails, batches 10 per Claude call, inserts facts.
- `runCalendarBackfill(client, userId, provider, jobId)` — fetches recurring events from last 90 days, dedup by series, batches 5 per Claude call, inserts facts.
- `isAutomatedSender(from, subject)` — shared filter rules below.
- `extractFactsBatched(systemPrompt, batches, userId, sourceTag)` — calls Claude in batches and writes pending_facts.

### Filter rules — what counts as a "good" email

Hard exclude (skip before sending to Claude):

1. **Sender pattern matches:**
   - `noreply@`, `no-reply@`, `donotreply@`, `do-not-reply@`
   - `notifications@`, `notification@`, `alert@`, `alerts@`
   - `mailer-daemon@`, `postmaster@`, `bounce@`, `bounces@`
   - `support@` only when subject contains "ticket" / "case" / "automated"
   - Sender domain on a hard-coded denylist: `mailchimp.com`, `sendgrid.net`, `amazonses.com`, `mailgun.org`, `linkedin.com` (LinkedIn dispatch), `facebookmail.com`, `twitter.com` (X dispatch), `slack.com` (notification dispatcher), `github.com` (PR/issue dispatch), `dhl.com`, `postnord.dk`, `gls-pakkeshop.dk`, etc.

2. **Subject patterns (case-insensitive):**
   - `unsubscribe`, `newsletter`, `digest`, `weekly summary`, `your order`, `package`, `tracking`, `bekræftelse af bestilling`, `kvittering`, `tracking`

3. **Gmail labels:** `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`, `CATEGORY_SOCIAL`. Available via `messages.list?labelIds=…&-…` exclusion or post-fetch filtering.

4. **Microsoft Graph categories:** Skip if `categories` includes "Newsletter" or "Promotion". Use `inferenceClassification` field — skip `other` (Outlook's "Focused vs Other" already filters marketing).

5. **From-self filter:** Skip messages where `from` email equals the user's own email.

After filtering, take the **most recent 50 surviving messages** per inbox. Order by date desc.

If the filter pass yields fewer than 50, that's fine — we extract from however many survived. Don't widen the date window.

### Calendar filter — what counts as "good"

Recurring meetings only (`recurringEventId` set on Google, `seriesMasterId` set on Graph). Dedup by series — one fact extraction per unique recurrence, not one per occurrence.

Skip:
- Events with `attendees.length === 0` (solo blocks)
- Events the user has declined (`responseStatus === 'declined'`)
- All-day events without invitees (vacation, holidays)
- Events with subject matching `lunch`, `frokost`, `coffee`, `kaffe`, `1:1` alone (low signal — these are routine)

Limit: top 30 unique series after filter.

### Schema: `backfill_jobs`

```sql
create table public.backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mail', 'calendar')),
  provider text not null check (provider in ('google', 'microsoft', 'icloud')),
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  processed int not null default 0,
  total int,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index backfill_jobs_user_kind_provider_idx
  on public.backfill_jobs (user_id, kind, provider);

alter table public.backfill_jobs enable row level security;
create policy "users read own backfill jobs"
  on public.backfill_jobs for select
  using (auth.uid() = user_id);
-- writes are service-role only (no user-write policy).
```

### Schema: extending `facts` for review-before-accept

The existing `facts` table has a `status` column with CHECK constraint `status in ('pending', 'confirmed', 'rejected')` (verified in Task 1). We use `status='pending'` for backfill output, then bulk-update to `'confirmed'` (matching the existing `confirmFact` helper in `profile-store.ts`) on review confirm. The `confirmed_at` / `rejected_at` / `rejection_ttl` timestamps must be set alongside the status change to match the existing fact-lifecycle pattern.

### Cost ceiling

Per opt-in user with 2 inboxes + Google + Microsoft calendar:

| Source | Calls | Tokens in | Tokens out | Cost |
|---|---|---|---|---|
| Gmail backfill (50 / 10 per call) | 5 | 7,500 | 1,000 | $0.013 |
| Microsoft mail backfill | 5 | 7,500 | 1,000 | $0.013 |
| Google calendar backfill (30 / 5 per call) | 6 | 6,000 | 600 | $0.009 |
| Microsoft calendar backfill | 6 | 6,000 | 600 | $0.009 |
| **Total** | **22 calls** | **27k** | **3.2k** | **~$0.044** |

Worst case (3 inboxes, all loaded, 50 each): ~$0.07. Comfortably under the $0.10 ceiling.

If 1k users opt in / month: ~$45/month. Negligible.

### Concurrency / rate limits

- Inside a single edge function invocation, run providers in parallel (`Promise.allSettled`).
- Per-user lock via `try_advisory_lock(hashtext('onboarding-backfill:' || user_id))` so a double-toggle doesn't kick off two parallel runs.
- Anthropic rate limit: Haiku 4.5 default RPM is comfortably above the call rate (22 calls per minute is well under any tier).
- Google API quota: 250 units/sec/user (Gmail), each `messages.list` is 5 units, `messages.get` (metadata) is 5 units. 50 messages × 5 = 250 units — fine.
- Microsoft Graph: 10k requests / 10 min / app per tenant. We're well under.

## UX

### `OnboardingBackfillScreen`

Shown **after** `MemoryConsentModal` confirms, **before** the user lands on the Memory tab.

Layout (Danish):
- Eyebrow: "LÆR DIG AT KENDE"
- H1: "Lad Zolva lære dig at kende"
- Body: "Vi læser hurtigt dine seneste emails og tilbagevendende møder for at finde ud af, hvem du arbejder med og hvad du arbejder med. Vi gemmer kun konklusionerne — ikke selve indholdet."
- Sub: "Du kan altid se og ændre, hvad Zolva har lært, i Hukommelse-fanen."
- Sources list: small rows showing each connected source ("Gmail", "Outlook", "Google Kalender", "Outlook Kalender") with a checkmark
- Primary button: "Start"
- Secondary button: "Spring over"

If skipped: navigate to `OnboardingChatQuestionsScreen` directly (still want some baseline facts).

### `OnboardingChatQuestionsScreen`

Shown WHILE backfill is running (so the user has something to do).

3 short prompts, each in a card with a `TextInput`:

1. **"Hvad arbejder du med?"** — placeholder: "Marketing, salg, udvikling, …"
2. **"Hvem er dine 2-3 vigtigste kolleger eller kunder?"** — placeholder: "Maria fra salg, Lars fra Acme A/S, …"
3. **"Hvilke deadlines eller projekter har du i øjeblikket?"** — placeholder: "Q2-budget i april, lancering i juni, …"

Below each input: "Spring over"-button.

Bottom: progress indicator showing backfill status — "Læser dine emails… (12 af 50)" → "Læser kalender… (4 af 30)" → "Færdig". When backfill done, show "Fortsæt" button to advance to review screen.

Each text submission fires `runExtractor({trigger:'chat_turn', text: prompt + ' ' + response, source: 'onboarding:Q1'})` so facts pile up in real-time.

### `OnboardingFactReviewScreen`

Shown after backfill + onboarding questions complete.

Layout:
- H1: "Hvad jeg har lært om dig"
- Body: "Jeg har samlet det her fra dine emails og kalender. Sæt flueben ved det jeg skal huske, og fjern det andet."
- Group facts by `source` prefix, with a section header per source:
  - "Fra Gmail" / "Fra Outlook" / "Fra kalender" / "Fra dine svar" (the chat questions)
- Each fact row: checkbox (default checked), Danish text, small caption with category and date if `referent_date`.
- Sticky footer: "Gem 12 fakta" (count updates live) and a small "Spring over alle"-link.

On submit:
- Update `pending_facts` rows in bulk: checked → `status='confirmed', confirmed_at=now()`; unchecked → `status='rejected', rejected_at=now(), rejection_ttl=now()+14d` (mirroring `confirmFact` / `rejectFact` in `profile-store.ts`).
- Invalidate the user's preamble cache so the next Claude call rebuilds with the new facts.
- Navigate to home / Today screen with a brief toast: "Tak. Jeg lærer dig løbende."

If user has zero facts (rare — backfill found nothing AND skipped questions): show empty state "Vi fandt ikke noget endnu. Det kommer i takt med, at du bruger Zolva." → confirm button skips review.

## Edge cases

- **User connects a provider after toggling memory-enabled.** The original backfill ran with whichever providers were connected at toggle time. Connecting a new one later does NOT trigger a fresh backfill — that's a future-spec problem. The new provider's mail/calendar contributes to forward-going extraction via existing chat/mail-event hooks.
- **User toggles memory off mid-backfill.** Worker checks `memory-enabled` at start of each batch; if disabled, marks job 'cancelled' and bails. Pending facts are deleted (not just rejected) since memory is off.
- **Edge function timeout.** Supabase edge functions have a 150s wall-clock cap. If we hit it, the worker writes whatever it finished and the job ends 'done' (not 'failed') — partial results are better than none. UI shows whatever completed.
- **Duplicate facts.** The existing `findDuplicateFact` + `normalizeFactText` from `profile-store.ts` already deduplicates against accepted facts. Backfill goes through the same path (`insertPendingFact`).
- **Demo user / kill switch.** `PROFILE_MEMORY_ENABLED` env still gates everything. Demo users skip backfill entirely (the screen never appears in demo mode).
- **Re-toggle.** If user toggles memory off then back on later, we DON'T re-run backfill (existing `backfill_jobs` rows for this user with `status='done'` mean we already did it). Adding a "redo backfill" button is future scope.

## Telemetry

Reuse the existing `consent_events` pattern with new event types — or add a `backfill_events` table. Simpler: add 4 new event_type values to `consent_events`:
- `backfill_started`
- `backfill_completed` (with details: facts_extracted, sources)
- `backfill_failed`
- `backfill_cancelled`

This keeps observability in one place.

## Out of scope (file as future tickets)

- iCloud mail backfill — defer until we benchmark IMAP performance under load.
- Drive scan for "what does this user work on" — drive.readonly scope just shipped; could add later.
- "Re-run backfill" button in Settings.
- Showing facts in the review screen with a snippet of the source ("Vi så denne email: …") — privacy story is cleaner if we don't surface email content directly. Reconsider after launch if users want it.
- Refining the filter rules based on real usage telemetry.

## Open questions for plan

- Should the backfill worker run inline (within `onboarding-backfill-start` request scope) or as a background-deferred task? Inline keeps the implementation simple and stays under 150s for our payload size; defer to plan.
- Schema migration for `facts.status` accepting `'pending'` — verify in plan Task 1.
