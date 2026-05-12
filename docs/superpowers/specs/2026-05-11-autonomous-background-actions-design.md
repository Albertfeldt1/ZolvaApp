# Autonomous Background Actions — Design

**Date:** 2026-05-11
**Status:** Draft (awaiting user review)
**Branch:** `worktree-autonomous-agent`

## 1. Goal

Make Zolva *act on its own in the background* — not just respond when the user opens a chat. A unified autonomous-agent loop watches mail, calendar, facts and time, decides what to do, executes low-risk actions automatically, and proposes higher-risk actions for one-tap approval. The user sees Zolva's work in a new **Today** tab and can undo anything Zolva did.

This is the next "big feature" for the app. Rollout is wide-open from day one (no internal-only gate); each user has a kill-switch (`user_profiles.agent_enabled`, default on).

## 2. Scope (v1)

Four action categories, all required for v1:
- **Mail triage** — label, archive, summarize, flag important.
- **Reply drafting + sending** — auto-draft, propose or auto-send based on trust policy.
- **Calendar actions** — RSVP, create/update event, suggest times.
- **Proactive briefings, nudges, memory follow-ups** — push notifications + Today-feed cards driven by calendar, facts, and time-of-day.

v1 ships in 4 phases under one architecture (Section 9). Each phase is independently shippable.

## 3. Architecture

```
                 ┌─────────────────────────────────────────────────┐
                 │             agent_events queue                  │
                 │  (mail.new, calendar.changed, time.morning,     │
                 │   fact.created, fact.due, user.idle, ...)       │
                 └─────────────────────────────────────────────────┘
                                 ▲                ▲
        event producers          │                │      cron sweep
  ┌─────────────────────────┐    │                │   (every 30 min +
  │ poll-mail               │────┘                │    morning/midday/
  │ calendar webhook        │                     │    evening per-user)
  │ fact upserts / triggers │                     │
  │ widget-action           │                     │
  └─────────────────────────┘                     │
                                                  │
                                          ┌───────┴────────┐
                                          │ agent-tick     │  ← new edge fn
                                          │ (event-driven) │
                                          └───────┬────────┘
                                                  │
                                  ┌───────────────┴─────────────────┐
                                  │       agent-reflect             │  ← new edge fn
                                  │ (scheduled big-picture turn)    │
                                  └───────────────┬─────────────────┘
                                                  │
                                                  ▼
                          ┌────────────────────────────────────────┐
                          │   agent-runner (shared core)           │
                          │  • loads user context                  │
                          │  • calls Claude w/ tool catalog        │
                          │  • applies trust policy per action     │
                          │  • executes auto-allowed tools         │
                          │  • writes others to proposed_actions   │
                          │  • emits notification(s)               │
                          └────────────────────────────────────────┘
                                                  │
                  ┌───────────────────────────────┼──────────────────────────────┐
                  ▼                               ▼                              ▼
        ┌──────────────────┐         ┌──────────────────────┐        ┌──────────────────┐
        │ existing tools   │         │  proposed_actions    │        │ push notification│
        │ (Gmail/Cal/Mem)  │         │  table (user-facing) │        │  + Today feed    │
        └──────────────────┘         └──────────────────────┘        └──────────────────┘
```

### 3.1 Pieces

1. **`agent_events`** — single normalized queue table. Existing producers (`poll-mail`, `widget-action`, `reminders-fire`) write into it instead of doing work inline.
2. **Two consumers, one core:**
   - `agent-tick` — invoked per event burst (debounced/coalesced per user).
   - `agent-reflect` — invoked on schedule (morning/midday/evening + 30-min sweep) for proactive nudges and memory follow-ups.
   - Both call the same **`agent-runner`** module so tool/policy/notification logic lives in one place.
3. **Trust policy** in `user_agent_policy` keyed by `(user_id, action_type)` with values `auto | propose | off`.
4. **`proposed_actions`** — actions awaiting approval; pushed to the user and executable on tap.
5. **`agent_actions`** — every executed action (auto or approved), with optional reverse-token for Undo.
6. **Reuses what exists** — `agent-runner` is built on the same job substrate as the existing `chat-jobs` table (Pass 1 already shipped). No duplicate execution engine.

## 4. Triggers & event catalog

### 4.1 Event types

Every row in `agent_events` has `user_id`, `kind`, `payload jsonb`, `created_at`, `processed_at`.

| kind | source | typical payload | drives |
|---|---|---|---|
| `mail.new` | poll-mail | `{provider, message_id, thread_id, from, subject_hash}` | triage, draft, important-flag |
| `mail.replied` | mail tools | `{thread_id}` | clear draft proposals on that thread |
| `calendar.changed` | calendar webhook / poll | `{event_id, change: created/updated/cancelled}` | RSVP, prep nudge, reschedule |
| `calendar.upcoming` | reflect (computed) | `{event_id, minutes_until}` | "your X starts in 2h, here's prep" |
| `fact.created` | profile-store trigger | `{fact_id, fact_kind}` | memory follow-ups |
| `fact.due` | fact-decay/scheduler | `{fact_id, due_at}` | nudge / draft |
| `time.morning` / `time.midday` / `time.evening` | cron per-user TZ | `{slot}` | daily-brief composition + reflection |
| `time.sweep` | cron every 30 min | — | reflection sweep |
| `user.idle` | client heartbeat | `{since}` | safer "auto-send" window detection |
| `user.intent` | chat / widget | `{intent: "watch_invoices_from_X"}` | enrolls standing tasks |

### 4.2 Schedules (pg_cron)

- Per-user morning/midday/evening events use the user's stored timezone (Europe/Copenhagen-ish, `user_profiles.timezone`). A single cron iterates users.
- Global `time.sweep` every 30 minutes — coalesces per-user batches.
- `poll-mail` (existing) emits `mail.new` events instead of doing its own brief composition.

### 4.3 Coalescing

When `agent-tick` picks up events, it groups all unprocessed events for a single `user_id` within a 60-second window into one Claude turn. This prevents a 30-mail burst from triggering 30 Claude calls.

### 4.4 `user.idle` rationale

Two roles:
1. **Greenlight for auto-send** — gates outbound actions like `mail.send_reply` on `now() - last_active_at > 10 min`, so Zolva doesn't fire a reply while the user is actively in the inbox.
2. **Don't push when foregrounded** — if the user is in the app, proposals drop silently into the Today feed instead of pushing a notification.

Wiring: client updates `user_presence.last_active_at` on Expo `AppState` foreground/background transitions. Failure mitigation: cap auto-sends at "user opened app in last 7 days" so a never-pinging client doesn't get treated as eternally idle.

## 5. Action catalog & trust policy

### 5.1 Action types

| action_type | does what | default mode | sensitivity |
|---|---|---|---|
| `mail.label` | apply/remove Gmail labels, Outlook categories | **auto** | low |
| `mail.archive` | archive a thread | **auto** | low |
| `mail.flag_important` | mark a thread as "Zolva flagged" in app | **auto** | low |
| `mail.summarize` | write thread summary into chat_messages / inbox detail | **auto** | low |
| `mail.draft_reply` | create draft (visible, not sent) | **auto** | low |
| `mail.send_reply` | actually send a drafted reply | **propose** | high |
| `mail.send_new` | originate new mail (e.g. memory follow-up) | **propose** | high |
| `cal.rsvp` | accept/decline an invite | **propose** | medium |
| `cal.create_event` | create event on user's calendar | **propose** | medium |
| `cal.update_event` | move/rename event | **propose** | medium |
| `cal.suggest_times` | produce a list of slots (no write) | **auto** | low |
| `brief.compose` | extend daily-brief with new section | **auto** | low |
| `nudge.push` | send a push notification | **auto** (rate-limited) | low |
| `memory.followup_draft` | draft based on a fact | **auto** (as a draft) | low |
| `standing_task.create` | enroll a long-lived rule | **propose** | medium |

### 5.2 Policy gates (runner consults in order)

1. `user_profiles.agent_enabled = true`?
2. `user_agent_budget` not exceeded?
3. `user_agent_policy[action_type] != off` (absent row → use default mode from §5.1)?
4. For `mode = auto`, additional safety gates per action type (e.g. `mail.send_reply` requires `userIsIdle`).
5. If `mode = propose`, write to `proposed_actions` instead of executing.

### 5.3 Trust escalation

When a user approves a proposed action ≥ 3 times for the same `(action_type, recipient_pattern)`, Zolva surfaces a prompt: *"Zolva noticed you always approve replies to your mom. Want me to send these automatically?"* Tap → flips policy to `auto` for that pattern.

## 6. UX — the Today tab

### 6.1 Surface

A new top-level **Today** tab is the canonical home for everything Zolva does. Push notifications deep-link into it. Inline duplicates (e.g. a draft card inside an inbox thread) are **not** included in v1 — the Today feed is the single source of truth.

### 6.2 Feed contents (activity model)

The feed mixes two row types in chronological order:

- **Pending proposals** (`proposed_actions.status='pending'`) — primary CTA (Send / Accept / Draft now) + secondary (Edit / Skip / Open).
- **Auto-executed actions** (`agent_actions` with `proposal_id IS NULL`) — shown with a "✓ DONE" badge and an **Undo** button when `reversible=true`.

Header shows two counters: *"3 venter · 7 udført"* (3 waiting · 7 done). Section labels chunk the feed by `time.*` events ("12:00 · midday brief", "Now · 14:22"). Sections containing only auto-actions are collapsible and **default to collapsed** (so an active feed isn't dominated by done rows).

### 6.3 Tab badge & push

- The tab icon shows a red badge with `count(pending proposals)`.
- Push notifications fire **only when** `proposed_actions` is written AND `userIsForeground = false`. The notification body is `proposed_actions.preview.notification_text`.

### 6.4 Settings

A new "Zolva-handlinger" section in Settings (v1 end-state — controls land progressively across phases, see §10):
- **Global kill-switch** (`agent_enabled`) — Phase 1.
- **Daily budget remaining** (read-only meter) — Phase 2.
- **Per-action policy** — list of action types with a three-way picker (Auto / Spørg / Fra) — Phase 3.
- **Trust-escalation history** — recently auto-promoted patterns with a revert button — Phase 4.

## 7. Data model

All new tables have RLS scoping to `auth.uid()` and standard timestamps.

```sql
-- 1. Event queue feeding the agent
CREATE TABLE agent_events (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  batch_id     uuid
);
CREATE INDEX ON agent_events (user_id, processed_at) WHERE processed_at IS NULL;

-- 2. One row per runner invocation
CREATE TABLE agent_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  trigger        text NOT NULL,
  event_ids      bigint[] NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text NOT NULL CHECK (status IN ('running','ok','error','budget_exceeded')),
  input_tokens   int,
  output_tokens  int,
  error          text
);

-- 3. Per-user × per-action-type trust policy
CREATE TABLE user_agent_policy (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('auto','propose','off')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, action_type)
);

-- 4. Things the agent wants to do but is waiting on you
CREATE TABLE proposed_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id         uuid REFERENCES agent_runs(id),
  action_type    text NOT NULL,
  payload        jsonb NOT NULL,
  preview        jsonb NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','approved','dismissed','expired','executed','failed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  executed_at    timestamptz,
  expires_at     timestamptz,
  context_ref    jsonb
);
CREATE INDEX ON proposed_actions (user_id, status, created_at DESC);

-- 5. Activity log: every executed action (auto or approved)
CREATE TABLE agent_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id         uuid REFERENCES agent_runs(id),
  proposal_id    uuid REFERENCES proposed_actions(id),
  action_type    text NOT NULL,
  payload        jsonb NOT NULL,
  executed_at    timestamptz NOT NULL DEFAULT now(),
  reversible     boolean NOT NULL DEFAULT false,
  reverse_token  jsonb,
  reversed_at    timestamptz
);
CREATE INDEX ON agent_actions (user_id, executed_at DESC);
CREATE UNIQUE INDEX agent_actions_idem ON agent_actions (
  user_id, action_type, (payload->>'idem_key')
) WHERE payload->>'idem_key' IS NOT NULL;

-- 6. Daily token/cost budget per user
CREATE TABLE user_agent_budget (
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day            date NOT NULL,
  input_tokens   int NOT NULL DEFAULT 0,
  output_tokens  int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- 7. App presence (drives `user.idle` signal)
CREATE TABLE user_presence (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_active_at   timestamptz,
  last_app_open_at timestamptz,
  push_token       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

Plus one column on existing `user_profiles`:
```sql
ALTER TABLE user_profiles ADD COLUMN agent_enabled boolean NOT NULL DEFAULT true;
```

Notes:
- `agent_events.processed_at IS NULL` partial index → cheap queue-tail scans.
- `proposed_actions.expires_at` keeps the feed clean; a cron sweep marks expired ones.
- `agent_actions.reverse_token` stores exactly what's needed to undo. `reversible=false` hides the Undo button.
- `user_agent_policy` is sparse — absent row means "use system default" (no signup-time bulk insert needed).

## 8. Error handling, idempotency, cost guards

### 8.1 Idempotency keys

| action_type | idem_key |
|---|---|
| `mail.label` | `(thread_id, label, op)` |
| `mail.send_reply` | `(thread_id, draft_hash)` |
| `cal.create_event` | hash of `(start, end, title, attendees)` |
| `nudge.push` | `(user_id, action_kind, target_id, day)` |

Enforced by `agent_actions_idem` unique partial index (§7).

### 8.2 Runner failure modes

| failure | behaviour |
|---|---|
| Claude API 5xx / timeout | `agent_runs.status='error'`, leave events un-processed, exponential retry on next sweep (max 3 attempts) |
| Claude rate limit | as 5xx, plus respect `retry-after` header (reuse existing `ClaudeRateLimitError`) |
| Tool call fails (Gmail 4xx) | log to `agent_actions` with `status='failed'`, surface a "Zolva tried to X but Gmail said Y" card; don't retry blindly |
| Token budget exceeded mid-run | finish current Claude call, persist decisions, set `agent_runs.status='budget_exceeded'`, defer remaining events to next day |
| Concurrent runs for same user | per-user advisory lock (`pg_advisory_xact_lock(hashtext(user_id::text))`); second runner skips |

### 8.3 Cost guards (3 layers)

1. **Per-user daily ceiling** (`user_agent_budget`): default 200k input + 50k output tokens per day. Hit → all `mode='auto'` actions for the rest of the day downgrade to `propose`; reflection sweeps stop.
2. **Global circuit breaker** (env `AGENT_GLOBAL_DAILY_USD_CAP`): refuse to start new turns when aggregate spend exceeds it.
3. **Per-event debounce**: 60s coalescing window (§4.3) plus a no-op short-circuit if the runner's context hasn't materially changed (`last_mail_id`, `last_calendar_etag` unchanged → skip Claude call entirely).

Wide-open rollout makes these guards load-bearing. Phase 1 ships with conservative defaults (100k/25k per-user day, $50 global daily cap) tightened/loosened after measuring real-world consumption.

### 8.4 Safety rails for outbound actions

For `mail.send_*`, `cal.create_event`, `cal.update_event`:
- Require `mode='auto'` AND `userIsIdle` AND no prior failed action with same idem_key in last hour.
- **Recipient-pattern allowlist** — auto-send only to recipients the user has personally corresponded with ≥ 3 times in the last 60 days (cheap query against existing `mail_events`).
- **Hard floor** — never auto-send mail to a recipient the user has never replied to themselves.

### 8.5 Observability

- View `v_agent_recent_runs`: last 100 runs per user with token spend + outcome.
- View `v_agent_pending_proposals_age`: oldest pending proposal per user (alert if > 24h — signals broken push delivery).
- Reuse `v_icloud_proxy_success_rate` pattern.

## 9. Testing strategy

### 9.1 Unit (Deno tests in `supabase/functions/_shared/`)

- Trust-policy resolver — every action type × every mode.
- Idempotency-key derivation per action type.
- Event coalescing — 30 mail events in 60s → single batch.
- Budget enforcement — synthetic ledger → mode downgrades fire correctly.
- Reverse-token application — given an `agent_actions` row, undo restores prior state.

### 9.2 Integration (Deno tests against local Supabase)

- End-to-end: insert `mail.new` event → run `agent-tick` → assert rows in `proposed_actions` + `agent_actions`.
- Concurrent-run safety: spawn two runners for same user → advisory lock proves only one Claude call.
- RLS: user A cannot read user B's `proposed_actions` via any path we currently expose.

### 9.3 Smoke (manual via dev build)

One golden-path test per action category, run as a checklist before promoting to production.

### 9.4 Hallucination guard

Reuse the existing 2026-05-03 hallucination-guard pattern: proposed-action payloads referencing mail IDs, calendar event IDs, or fact IDs must round-trip-verify against the source. Failures land in `proposed_actions.status='failed'` with the parse error.

## 10. Phasing & rollout

| Phase | Scope | "Demo-able" |
|---|---|---|
| **1 — Plumbing** | Tables, `agent-runner` skeleton, `agent_events` queue, `agent-tick` edge fn, advisory locks, budget table, `user_presence` heartbeat, Today tab in app (read-only, empty state). Runner is a no-op stub. | Internal: "the pipes work, nothing happens" |
| **2 — Mail triage (auto)** | `mail.label`, `mail.archive`, `mail.summarize`, `mail.flag_important`. Writes to `agent_actions`, surfaces as "done" cards in Today with Undo. No proposals yet — all auto, all low-stakes. | First wow moment: open app, see "Zolva archived 4 newsletters, summarized 2 threads" |
| **3 — Proposals + draft replies** | `proposed_actions` active, push notifications wired, `mail.draft_reply` (auto draft) + `mail.send_reply` (propose). Settings screen for per-action policy. | Full feedback loop visible — Zolva drafts, user taps Send |
| **4 — Calendar + reflection sweeps + memory follow-ups** | `agent-reflect` edge fn on cron, `cal.rsvp`, `cal.create_event`, `memory.followup_draft`, `nudge.push`. Standing tasks (`user.intent`). Trust-escalation prompt. | Proactive feel — Zolva surfaces things you weren't thinking about |

Each phase ships to all users (no internal gate). The user-facing `user_profiles.agent_enabled` kill-switch is on by default and exposed in Settings from Phase 1.

## 11. Open questions

None blocking — design is ready for implementation planning.

## 12. References

- `docs/superpowers/specs/2026-04-21-daily-brief-design.md` — existing daily-brief flow we extend in Phase 4.
- `docs/superpowers/specs/2026-04-21-persistent-memory-design.md` — facts store powering memory follow-ups.
- `docs/superpowers/specs/2026-05-03-chat-hallucination-guard-design.md` — guard reused in §9.4.
- Migration `20260508120000_chat_jobs.sql` — substrate for `agent-runner`.
- Memory: `project_chat_jobs_pass1.md`, `feedback_oauth_debugging.md`.
