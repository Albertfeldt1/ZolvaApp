# Scheduling Negotiation + Renewal Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three improvements to the Zolva autonomous agent, derived from a codebase trace of four proposed use cases (two of which — meeting-request→calendar draft, and pre-meeting brief — turned out to already be built and live):

- **Group A — Scheduling negotiation (#2):** when a human asks to meet but proposes NO concrete time, the triage agent calls a new deterministic `cal_find_free_slots` tool and drafts a reply offering ~3 open slots. *(new)*
- **Group B — Pre-meeting brief tightening (#3):** strengthen the reflect prompt so the per-meeting brief reliably searches the attendee's latest thread by default. *(tiny prompt tweak)*
- **Group C — Renewal/expiry capture (#4):** make memory-follow-ups actually fire in production by (C1) anchoring the extractor to "today" so Danish relative dates resolve, (C2) auto-confirming high-confidence facts (chat facts currently sit `pending` forever with no confirm UI → the sweep never acts on them), and (C3) a lead window so renewal nudges arrive *before* the date. *(new)*

**Architecture:** Group A + B are server (`supabase/functions/_shared/agent/**`) → committed + deployed (redeploy `agent-tick` for A, `agent-reflect` for B) BEFORE the Group C client OTA. Group C is client (`src/lib/**`) → OTA from main.

**Tech Stack:** Supabase edge functions (Deno/TS), React-Native (Expo) client, Claude via shared runner, `deno test` + Jest.

---

## Background the engineer needs (verified anchors)

- **Triage path:** `mailTriageStrategy` (runner.ts ~578) → `buildMailTriagePrompt` (prompt.ts ~359) → `MAIL_TRIAGE_TOOLS` (prompt.ts 42–196). Already contains `cal_list_events`, `cal_create_event`, `cal_update_event`, `mail_draft_reply`, `mail_send_reply`, `mail_get_body`, `drive_search`, `nudge_push`. The prompt ALREADY mandates create-event-on-concrete-time (line ~369) — do NOT re-add that.
- **Calendar read executors:** `googleListEvents` (tools/calendar.ts:19), `outlookListEvents` (tools/calendar.ts:61) → `CalEvent[]` (`{id,title,start,end,attendees:string[],location}`, calendar.ts:10–17). Times are ISO. `cal_list_events` dispatch at dispatch.ts ~306 is context-only (policy `auto`, no `agent_actions` row).
- **Reflect:** `REFLECT_SYSTEM_PROMPT` (prompt.ts ~286), `REFLECT_TOOLS = [MAIL_SEARCH_TOOL, MAIL_GET_BODY_TOOL, NUDGE_PUSH_TOOL]` (prompt.ts 218). Attendee emails already flow into the `calendar.upcoming` payload and are printed in the prompt.
- **Extractor (client):** `profile-extractor.ts` — Claude extraction prompt ~27–62 (`{text,category,confidence,referentDate}`), categories ~57 (`relationship|role|preference|project|commitment|other`), `DECAY_CATEGORIES`/`FOLLOWUP_CATEGORIES = ['commitment','other']` (~65/85), `computeExpiresAt`, `computeFollowUpAt` (~83–102, sets `follow_up_at = referentDate@00:00Z`), confidence threshold `0.6` (~104), then `insertPendingFact(...)` (~156).
- **Fact store (client):** `insertPendingFact` (profile-store.ts ~107) inserts `status='pending'`. The `facts.status` CHECK is `pending|confirmed|rejected`; a confirmed row must carry `confirmed_at` (see project memory). `rowToFact` (~38) maps rows.
- **Conventions:** Conventional Commits, scope `agent` (server) / `calendar` / `chat` as fits, bullet bodies, NO AI attribution, don't `git push`. Server commits+deploys FIRST. Only `git add` the named files (there is unrelated WIP elsewhere at times — never `git add -A`). Use `--no-verify` if a pre-commit hook would touch unrelated files. `deno test supabase/functions/_shared/agent/` for server; `npx jest <path>` for client.

---

## GROUP A — Scheduling negotiation (`cal_find_free_slots`)

### Task A1: Pure free-slot finder module + tests

**Files:**
- Create: `supabase/functions/_shared/agent/free-slots.ts`
- Test: `supabase/functions/_shared/agent/free-slots.test.ts`

- [ ] **Step 1 (TDD): write failing tests** for `computeFreeSlots(busy, opts)`:

```typescript
// free-slots.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeFreeSlots, type BusyInterval } from './free-slots.ts';

// opts: { fromIso, toIso, tz, workdayStartHour, workdayEndHour, slotMinutes, maxSlots }
const OPTS = {
  tz: 'Europe/Copenhagen', workdayStartHour: 9, workdayEndHour: 17,
  slotMinutes: 30, maxSlots: 3,
};

Deno.test('empty calendar → first slots of each workday at 09:00 local', () => {
  // Mon 2026-06-01 .. within window; first free slot should start 09:00 CPH = 07:00Z (CEST)
  const slots = computeFreeSlots([], { ...OPTS, fromIso: '2026-06-01T05:00:00Z', toIso: '2026-06-03T20:00:00Z' });
  assertEquals(slots.length, 3);
  assertEquals(slots[0].start_iso, '2026-06-01T07:00:00.000Z'); // 09:00 CEST
});

Deno.test('a busy block pushes the slot after it', () => {
  const busy: BusyInterval[] = [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T09:00:00Z' }]; // 09–11 CPH
  const slots = computeFreeSlots(busy, { ...OPTS, fromIso: '2026-06-01T05:00:00Z', toIso: '2026-06-01T20:00:00Z', maxSlots: 1 });
  assertEquals(slots[0].start_iso, '2026-06-01T09:00:00.000Z'); // 11:00 CPH
});

Deno.test('fully-booked workday yields no slot that day', () => {
  const busy: BusyInterval[] = [{ start: '2026-06-01T07:00:00Z', end: '2026-06-01T15:00:00Z' }]; // 09–17 CPH
  const slots = computeFreeSlots(busy, { ...OPTS, fromIso: '2026-06-01T05:00:00Z', toIso: '2026-06-01T20:00:00Z', maxSlots: 3 });
  assertEquals(slots.length, 0);
});

Deno.test('skips weekends', () => {
  // 2026-06-06 is Saturday, 06-07 Sunday; first slot should be Mon 06-08
  const slots = computeFreeSlots([], { ...OPTS, fromIso: '2026-06-06T05:00:00Z', toIso: '2026-06-08T20:00:00Z', maxSlots: 1 });
  assertEquals(slots[0].start_iso.startsWith('2026-06-08'), true);
});

Deno.test('respects slot duration (60-min) start alignment to workday start', () => {
  const slots = computeFreeSlots([], { ...OPTS, slotMinutes: 60, fromIso: '2026-06-01T05:00:00Z', toIso: '2026-06-01T20:00:00Z', maxSlots: 1 });
  assertEquals(slots[0], { start_iso: '2026-06-01T07:00:00.000Z', end_iso: '2026-06-01T08:00:00.000Z' });
});
```

- [ ] **Step 2: run, verify fail** (`deno test supabase/functions/_shared/agent/free-slots.test.ts`).

- [ ] **Step 3: implement `computeFreeSlots`.** Pure, deterministic, timezone-aware. Sketch:

```typescript
// free-slots.ts
//
// Deterministic free-slot finder for scheduling-negotiation replies. The model
// gets a verified list of open windows instead of reasoning over raw events
// (which mis-handles DST/timezones). Working hours are in the user's tz.

export interface BusyInterval { start: string; end: string } // ISO
export interface FreeSlot { start_iso: string; end_iso: string }
export interface FreeSlotOpts {
  fromIso: string; toIso: string; tz: string;
  workdayStartHour: number; workdayEndHour: number; // local hours
  slotMinutes: number; maxSlots: number;
}

// Local wall-clock (Y/M/D/H in `tz`) → UTC ms. Uses Intl to get the tz offset
// at that instant (DST-correct) and inverts it.
function zonedTimeToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  // offset = (what that UTC instant reads as in tz) - itself
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const seenUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = seenUtc - asUtc;
  return asUtc - offset;
}

// dow in tz (0=Sun..6=Sat) for a UTC instant
function zonedDow(ms: number, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms));
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wd);
}

export function computeFreeSlots(busy: BusyInterval[], opts: FreeSlotOpts): FreeSlot[] {
  const fromMs = Date.parse(opts.fromIso), toMs = Date.parse(opts.toIso);
  const slotMs = opts.slotMinutes * 60_000;
  const intervals = busy
    .map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e))
    .sort((a, b) => a.s - b.s);
  const overlapsBusy = (s: number, e: number) => intervals.some((b) => s < b.e && e > b.s);

  const out: FreeSlot[] = [];
  // iterate day by day in tz; derive that day's Y/M/D from the from instant, walk forward
  for (let dayMs = fromMs; dayMs <= toMs && out.length < opts.maxSlots; ) {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: opts.tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(dayMs)).split('-').map(Number); // [Y,M,D]
    const dow = zonedDow(zonedTimeToUtcMs(ymd[0], ymd[1], ymd[2], 12, 0, opts.tz), opts.tz);
    if (dow !== 0 && dow !== 6) { // skip weekends
      for (let h = opts.workdayStartHour; h + opts.slotMinutes / 60 <= opts.workdayEndHour && out.length < opts.maxSlots; ) {
        const s = zonedTimeToUtcMs(ymd[0], ymd[1], ymd[2], h, 0, opts.tz);
        const e = s + slotMs;
        if (s >= fromMs && e <= toMs && !overlapsBusy(s, e)) {
          out.push({ start_iso: new Date(s).toISOString(), end_iso: new Date(e).toISOString() });
        }
        // advance by slot; simple v1: step in slotMinutes from workday start
        h += opts.slotMinutes / 60;
      }
    }
    // next calendar day: add 24h then re-derive (DST-safe enough for day stepping)
    dayMs += 24 * 60 * 60_000;
  }
  return out.slice(0, opts.maxSlots);
}
```

(Engineer: verify the test expectations against this impl; adjust slot stepping so the asserted instants match. The DST-correctness requirement is the reason this is a tested helper — make the tests pass for CEST June dates.)

- [ ] **Step 4: run, verify pass.**
- [ ] **Step 5: commit** — `feat(agent): deterministic cal free-slot finder`

---

### Task A2: `cal_find_free_slots` tool + executor + dispatch

**Files:**
- Modify: `supabase/functions/_shared/agent/prompt.ts` (tool def + add to `MAIL_TRIAGE_TOOLS`)
- Modify: `supabase/functions/_shared/agent/tools/dispatch.ts` (execute the tool, context-only)
- Modify: `supabase/functions/_shared/agent/tools/calendar.ts` if a thin reader wrapper helps (reuse `googleListEvents`/`outlookListEvents`)

- [ ] **Step 1: tool definition** near the other calendar tools in prompt.ts:

```typescript
const CAL_FIND_FREE_SLOTS_TOOL = {
  name: 'cal_find_free_slots',
  description: 'Find open meeting slots in the user calendar over the coming work days, '
    + 'respecting working hours (09–17 Europe/Copenhagen) and existing events. Use this '
    + 'when a human asks to meet but proposes NO concrete time, then offer ~3 of the '
    + 'returned slots in a drafted reply. Returns slots as { start_iso, end_iso } in UTC.',
  input_schema: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['google', 'microsoft'] },
      duration_minutes: { type: 'integer', minimum: 15, maximum: 240 },
      days_ahead: { type: 'integer', minimum: 1, maximum: 14 },
    },
    required: ['provider'],
  },
} as const;
```

Add `CAL_FIND_FREE_SLOTS_TOOL` to `MAIL_TRIAGE_TOOLS`.

- [ ] **Step 2: dispatch** (context-only, mirrors `cal_list_events` at dispatch.ts ~306): read events for `[now, now + days_ahead]` via the existing list-events readers, map to `BusyInterval[]`, call `computeFreeSlots` with `{ tz:'Europe/Copenhagen', workdayStartHour:9, workdayEndHour:17, slotMinutes: duration_minutes ?? 30, maxSlots: 3, fromIso: now, toIso: now+days }`, return `{ slots }` as the tool_result. No `agent_actions` row (policy `auto`).

- [ ] **Step 3: typecheck** `deno check` the touched files.
- [ ] **Step 4: commit** — `feat(agent): cal_find_free_slots tool for scheduling negotiation`

---

### Task A3: triage prompt — offer slots when no time is proposed

**Files:** Modify `supabase/functions/_shared/agent/prompt.ts` (`buildMailTriagePrompt` system text) + test.

- [ ] **Step 1 (TDD):** a test asserting the triage system prompt mentions `cal_find_free_slots` and the no-concrete-time branch.
- [ ] **Step 2:** add one directive to the triage system prompt, distinct from the existing concrete-time mandate:
  > "Hvis en menneskelig tråd beder om et møde men IKKE foreslår et konkret tidspunkt, kald `cal_find_free_slots` og udkast et svar (`mail_draft_reply`) der tilbyder ~3 ledige tidspunkter på dansk (Europe/Copenhagen). Opret IKKE en begivenhed endnu — vent til de vælger."
- [ ] **Step 3:** run the prompt test + the full server suite (`deno test supabase/functions/_shared/agent/`).
- [ ] **Step 4: commit** — `feat(agent): triage offers free slots when no time is proposed`

---

## GROUP B — Pre-meeting brief tightening (#3)

### Task B1: strengthen reflect prompt to search attendees by default

**Files:** Modify `supabase/functions/_shared/agent/prompt.ts` (`REFLECT_SYSTEM_PROMPT`) + a prompt assertion test.

- [ ] **Step 1 (TDD):** assert the reflect prompt instructs searching the first attendee by default.
- [ ] **Step 2:** tighten the wording so the brief is reliable: prefer `mail_search` on the first attendee's email (or subject) to find the latest related thread before composing the heads-up; keep the "skip routine/recurring meetings" guard and the one-nudge rule (`action_kind='meeting_prep'`). No payload/schema change (attendees already in the payload).
- [ ] **Step 3:** run full server suite.
- [ ] **Step 4: commit** — `feat(agent): reflect pre-meeting brief searches attendees by default`

---

## GROUP C — Renewal/expiry capture (#4)  *(client)*

### Task C1: anchor the extractor to "today" so Danish relative dates resolve

**Files:** Modify `src/lib/profile-extractor.ts` (extraction prompt) + test.

- [ ] **Step 1 (TDD where feasible):** unit-test a small pure helper `todayInCopenhagen(now: Date): string` returning `YYYY-MM-DD`; assert it formats in Europe/Copenhagen.
- [ ] **Step 2:** inject a "Dags dato: <YYYY-MM-DD> (Europe/Copenhagen). Opløs relative datoer ("i juni", "til oktober", "om to uger") til en konkret ISO-dato ud fra dags dato; for måned-uden-dag, brug den 1." line into the extraction system/user prompt so `referentDate` resolves reliably. Keep the existing `referentDate` null-when-undated behaviour.
- [ ] **Step 3:** `npx tsc --noEmit | grep profile-extractor || echo clean`.
- [ ] **Step 4: commit** — `feat(chat): anchor fact extractor to today for relative dates`

---

### Task C2: auto-confirm high-confidence facts

**Files:** Modify `src/lib/profile-store.ts` (accept a confirmed insert) + `src/lib/profile-extractor.ts` (decide) + tests.

- [ ] **Step 1 (TDD):** pure `shouldAutoConfirm(category, confidence, hasFollowUp)` — returns true when `confidence >= AUTO_CONFIRM_THRESHOLD` (0.85). Tests for above/below threshold.
- [ ] **Step 2:** extend `insertPendingFact` (or add `insertFact` with a `status`) so a high-confidence fact inserts as `status='confirmed'` with `confirmed_at = new Date().toISOString()` (the CHECK requires `confirmed_at` on confirmed rows — see memory). Default remains `pending`.
- [ ] **Step 3:** in `profile-extractor.ts` `runNow`, compute `shouldAutoConfirm(...)` and pass the resolved status. Auto-confirmed facts appear in MemoryScreen (confirmed tab) and are user-deletable — note this in a comment.
- [ ] **Step 4:** `npx tsc --noEmit | grep -E 'profile-(store|extractor)' || echo clean`; run the jest tests.
- [ ] **Step 5: commit** — `feat(chat): auto-confirm high-confidence extracted facts`

---

### Task C3: lead window so renewal nudges arrive before the date

**Files:** Modify `src/lib/profile-extractor.ts` (`computeFollowUpAt`) + test.

- [ ] **Step 1 (TDD):** extend the existing `computeFollowUpAt` tests:
  - deadline-like text ("forny dit pas", "bilsyn", "forsikring udløber") with a date >14d out → `follow_up_at = referentDate − 14 days`.
  - deadline-like but <14d out → `follow_up_at = referentDate` (don't push into the past).
  - non-deadline dated commitment ("ring til Allan fredag") → `follow_up_at = referentDate` (unchanged, on the day).
- [ ] **Step 2:** add a Danish deadline-keyword test (`forny|fornyelse|udløb|udløber|syn|bilsyn|forsikring|abonnement|frist|deadline`) inside `computeFollowUpAt(category, referentDate, text)` — add the `text` param. Apply the 14-day lead only when it matches AND the lead day is still in the future. Keep the signature backward-compatible at the call site (pass the fact text).
- [ ] **Step 3:** run the jest suite for the extractor follow-up tests.
- [ ] **Step 4: commit** — `feat(chat): lead-time window for renewal/expiry follow-ups`

---

## Deploy

- [ ] **D1:** full server suite green (`deno test supabase/functions/_shared/agent/`).
- [ ] **D2:** deploy the two affected functions: `supabase functions deploy agent-tick --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop` (Group A) and `supabase functions deploy agent-reflect --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop` (Group B).
- [ ] **D3:** smoke A — a confirmed test scenario or log check that `cal_find_free_slots` runs without error (health/trace). Smoke C — extract a dated Danish renewal phrase for the test account, confirm it auto-confirms with a lead `follow_up_at`, then clean up.
- [ ] **D4:** merge to main; OTA the client (Group C) from main (`eas update --branch production`). Stash any unrelated WIP out of the bundle first.

---

## Self-review notes
- #1 (meeting→calendar) and the core of #3 (pre-meeting brief) were found ALREADY BUILT during the codebase trace — Group B is only a reliability tweak, and #1 is intentionally out of scope. Verified the triage prompt already mandates create-on-concrete-time and the live agent emitted `cal.create_event` actions.
- Biggest risk is Task A1's DST/timezone math — that is exactly why it's a deterministic, unit-tested helper rather than left to the model.
- C2 is what makes memory-follow-ups (already shipped) actually fire in prod; without it, chat-extracted facts stay `pending` and the sweep has nothing to act on.
