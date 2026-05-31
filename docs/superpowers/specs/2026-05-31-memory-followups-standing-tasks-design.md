# Memory follow-ups & standing tasks — two proactive behaviours (Phase 4)

**Status:** design approved 2026-05-31
**Scope:** the two remaining proactive agent behaviours from `2026-05-11-autonomous-background-actions-design.md` (§4.1, §5.1, §10). Builds on the same substrate as `agent-reflect` (calendar-prep) and `agent-commitments`: `executeRun` + `AgentStrategy` + `buildDeps` + quiet-hours gating + `nudge.push`.
**Chosen approach:** Approach A — direct-query sweep for the time-driven half, triage hook for the mail-driven half. (Rejected: B, the spec-faithful `fact.due`/`user.intent` event-producer model — extra plumbing for no v1 benefit; C, a single unified engine — conflates a clock trigger with a mail-match trigger.)

## 1. Goal

Two distinct proactive behaviours, designed together so their data model and the overlap with existing surfaces are settled coherently:

- **Memory follow-ups** — when a stored **fact** carries a future date ("pas udløber i juni", "mors fødselsdag 12/6"), Zolva surfaces it as the date nears: a nudge, or a drafted message when there's a clear recipient.
- **Standing tasks** — a user-defined **rule** ("hold øje med fakturaer fra Telia og lav et udkast") that augments mail triage: when a matching mail arrives, the agent acts on it via its normal triage tools, guided by the rule's instruction.

## 2. Where this fits — four distinct sources, no unification

The earlier concern was overlap with existing "remind me about a future thing" surfaces. Resolution: these are **four different producers with different lifecycles**, and stay separate tables/paths.

| Behaviour | Source | Fires when |
|---|---|---|
| `reminders` (exists) | user sets an explicit time | the exact time arrives |
| `agent_commitments` (exists) | extracted from **sent mail** | a promise nears due / a wait drags on |
| **memory follow-ups** (new) | a stored **fact** with a future date | the fact's `follow_up_at` arrives |
| **standing tasks** (new) | a user-defined **rule** | a matching mail arrives |

The only cross-surface guard: memory follow-ups must fire once per fact (the `followed_up_at` stamp), and a fact that happens to duplicate a commitment is a low-probability edge (separate stores) accepted for v1.

## 3. Non-goals (explicitly deferred)

- The spec-catalogue `fact.due` scheduler and `user.intent` `agent_events` producer (Approach B) — replaced by direct-query sweep + chat tool.
- A dedicated `memory.followup_draft` action type — memory follow-ups **reuse** `nudge.push` and the existing draft/proposal actions. (Adding it later buys only a separate policy toggle / telemetry line.)
- "Open-loop" / agent-inferred follow-ups with no explicit date — v1 is **time-anchored facts only**.
- A Settings UI to manage standing tasks — v1 is chat-create + chat-stop only; a read-only list is a fast-follow.
- General-condition standing rules (calendar/time triggers, arbitrary actions) — v1 is **mail-watch → triage action** only.

## 4. Memory follow-ups

### 4.1 Data model — extend `facts`

Two nullable columns (precedent: `20260427100000_facts_expires_at.sql` already ALTERs `facts`):

- `follow_up_at timestamptz` — **when to surface** this fact. `null` ⇒ no follow-up; the fact never enters the sweep.
- `followed_up_at timestamptz` — stamped once the agent has acted, so each fact fires exactly once.

`follow_up_at` is the *surface moment*, not the raw deadline — the lead (e.g. ~2 weeks before a passport expiry, the morning of a birthday) is decided at extraction time so the sweep stays a cheap "what's due now" query.

### 4.2 Producer — extend the chat fact-extractor (no new service)

The existing chat fact-extraction pipeline (`profile-extractor.ts` / `hooks.ts` — exact seam confirmed during planning) already pulls facts from chat. Extend its extraction schema/prompt so a **time-anchored, actionable** fact also yields an ISO `follow_up_at`. Non-time facts get `null`. No new producer service, no `agent_events` row.

### 4.3 Sweep — new `agent-memory-followups` edge fn + cron

Mirrors `agent-reflect` structure exactly. Per `agent_enabled` user, quiet-hours gated:

1. Select `confirmed` facts where `follow_up_at <= now` AND `followed_up_at IS NULL`.
2. If any, run a `memoryFollowupStrategy` through `executeRun`. The agent sees the due facts and, per fact, either:
   - fires `nudge.push` ("Dit pas udløber om 2 uger"), or
   - drafts a message for approval when there's a clear recipient (birthday → greeting) via the existing draft/proposal actions (`mail.send_new` / `mail.draft_reply`, propose mode).
3. Stamp `followed_up_at` on every handled fact (once-only).

Cron cadence: a daytime sweep (e.g. a few times a day); quiet-hours holds overnight-due items to the first post-quiet sweep, matching `agent-reflect`/`agent-commitments`.

### 4.4 Idempotency & state

`followed_up_at` is the once-only gate. `nudge.push` idem stays day-scoped (existing). A draft proposal reuses the existing `proposed_actions` idem.

### 4.5 Testing

- Pure `selectDueFollowups(facts, now)` — window boundary (`follow_up_at <= now`), once-only (`followed_up_at` set ⇒ skip), status filter.
- `memoryFollowupStrategy` prompt build (deterministic given facts).
- Sweep wiring test (per-user try/catch, quiet-hours skip).

## 5. Standing tasks

### 5.1 Data model — new `agent_standing_tasks` table

- `id`, `user_id`
- `match_from text` (sender email/domain substring, nullable) and/or `match_keyword text` (subject keyword, nullable) — **at least one required**.
- `instruction text` — the natural-language directive.
- `status text` — `active` | `paused` (CHECK).
- `created_at`, `last_matched_at`, `match_count int default 0` (telemetry).
- Owner-RLS select policy. (Realtime publication only if/when a read UI lands — deferred.)

### 5.2 Creation — chat intent detection → propose → approve

1. The chat agent gains a `standing_task_create` tool, called when it detects a "hold øje med X" intent in the user's message.
2. The tool produces a **`proposed_actions`** row of type `standing_task.create` (propose mode) — **not** a direct insert. A durable rule is never enrolled without explicit approval.
3. The user approves via the existing `agent-approve`; a **new branch there materialises the rule** into `agent_standing_tasks`.

This is the one genuinely new action type — `standing_task.create` (default `propose`) — because approval must create the durable row.

### 5.3 Removal — chat-symmetric, no UI

The chat agent also gains a `standing_task_stop` tool: when the user says "stop med at holde øje med X", it pauses the matching `active` rule directly (`status='paused'`). Low-risk and reversible, so no approval proposal is needed. A read-only Settings list stays a fast-follow.

### 5.4 Evaluation — hook into the existing `agent-tick` triage

No separate evaluator sweep. Inside `agent-tick`, when building triage context for the claimed `mail.new` events:

1. Load the user's `active` standing tasks.
2. A **pure** `matchStandingTasks(briefs, tasks)` matches each incoming mail's `from`/`subject` against each rule's `match_from`/`match_keyword` (case-insensitive substring), returning per-thread instructions.
3. Inject matched instructions into the triage prompt, scoped to the thread ("Stående opgave for denne tråd: …").
4. The agent triages with its normal tools, guided by the instruction; stamp `last_matched_at` / `match_count`.

### 5.5 Safety property

A standing task **only biases triage** — it cannot bypass rails. `mail.send_reply` stays gated by the per-action policy mode + the user-idle gate + the recipient-allowlist check, so "watch X and reply" still cannot auto-send unless those gates independently pass. The instruction is advisory context, not an execution grant.

### 5.6 Testing

- Pure `matchStandingTasks(briefs, tasks)` — from match, keyword match, both-required-AND semantics if both set, case-insensitivity, multiple rules on one mail, no-match.
- `standing_task.create` dispatch shaping (payload validation, no provider call).
- `agent-approve` materialisation branch (proposal → row insert; idempotent on double-approve).
- Chat `standing_task_create` / `standing_task_stop` tool wiring.

## 6. Shared wiring (minimal new seams)

- **ActionType:** add `standing_task.create` (default `propose`) to the type union + `ACTION_DEFAULT_MODE`. Memory follow-ups add none.
- **Chat tools:** `standing_task_create`, `standing_task_stop` registered in the chat agent's tool catalogue + system-prompt guidance.
- **Dispatch:** `standing_task.create` shapes the rule payload (no provider API). `agent-approve` gains the materialisation branch.
- **Prompts:** `memoryFollowupStrategy` system prompt; `agent-tick` triage prompt extended with injected standing-task instructions.
- **Edge fns / cron:** new `agent-memory-followups` fn + cron job; `agent-standing-tasks` needs **no** new fn (it lives in `agent-tick`).

## 7. Build sequence (each its own plan + server-first deploy)

1. **Memory follow-ups first** — self-contained: `facts` columns migration + extractor change + `agent-memory-followups` sweep + cron. Ships and is verifiable independently.
2. **Standing tasks second** — larger: `agent_standing_tasks` table + chat tools + `agent-approve` branch + `agent-tick` triage hook.

Both follow the established server-commit-then-deploy cycle; client touchpoints (if any) OTA from `main`.

## 8. Open items to confirm during planning

- Exact chat fact-extractor seam and how `follow_up_at` is added to its output schema.
- Cron cadence for `agent-memory-followups` (align with reflect/commitments windows).
- Whether `standing_task_stop` should match by `match_from`/keyword or need a task id surfaced to the chat agent.
