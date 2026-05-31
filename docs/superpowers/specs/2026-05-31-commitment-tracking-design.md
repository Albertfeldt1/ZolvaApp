# Commitment tracking — proactive "open loops" (Phase 4)

**Status:** design approved 2026-05-31
**Scope:** second proactive agent behaviour, after `agent-reflect` calendar-prep (spec `2026-05-31-agent-reflect-calendar-prep-design.md`). Builds on the same reflect runner-path (`executeRun` + `AgentStrategy`) and the shipped `nudge.push` tool.

## 1. Goal

Make Zolva keep track of the things hanging over the user's head — in **both directions**:

- **`you_owe`** — promises the user made ("I'll send the deck Friday") and asks made of them they haven't answered. Ball in their court.
- **`owed_to_you`** — threads the user is waiting on, where they asked something and the other side went quiet. Ball in the other court.

Zolva extracts these from mail, remembers them in a durable table, and sends **one timely push** before a promise comes due or after a wait drags on — e.g. *"Du lovede Allan Q3-decket på fredag — det er i morgen."* / *"Du har ventet på svar fra Mette i 4 dage om mødet."*

This is the first agent behaviour that **remembers structured state over time** rather than reacting to a single trigger. That durability is load-bearing: "owed to you" is the *absence* of a reply across days — it cannot be detected from any one message.

## 2. Non-goals (explicitly deferred)

- **No actions.** Commitments only ever *notify*. No auto-reply, no auto-anything. Firmly in the safe lane.
- **In-app "Open loops" list.** v1 is **nudge-only**, exactly like calendar-prep shipped. The list (see/dismiss/resolve all tracked commitments) is a fast-follow once the engine proves out.
- **Explicit dismiss buttons on the nudge.** `nudge.push` has no action buttons yet (deferred, keychain — see `widget-v2-keychain-findings`). v1 closes loops via auto-reconciliation + auto-expire, not a Dismiss tap.
- **Non-mail sources.** Chat-stated and calendar-stated commitments are out of scope for v1; mail only.
- **iCloud mail.** Reuses the Gmail/Graph read tools only.

## 3. Architecture

A new **`agent-commitments`** edge function on its own cron (~every 2h), mirroring `agent-reflect`'s shape. Per `agent_enabled` user, each run does two phases:

```
agent-commitments (cron ~2h)
  └─ per agent_enabled user:
       Phase 1 — EXTRACT  (watermark-gated, heavier; not every run)
         read sent + stale threads → Claude → commitment.record tool → upsert agent_commitments
       Phase 2 — RECONCILE + DUE-NUDGE  (every run, cheap)
         reconcile open rows against current thread state (resolve / expire)
         select due/quiet open rows → emit commitment.due events → executeRun(commitmentNudgeStrategy) → nudge.push
```

Both phases reuse the existing `executeRun(userId, trigger, events, deps, strategy)` engine and `AgentStrategy` interface from `runner.ts`. Quiet-hours gating (`isQuietHours`) wraps the whole per-user run, inherited for free.

### Two new strategies

| Strategy | Work items | Context → prompt | Tools | Effect |
|---|---|---|---|---|
| **commitmentScan** (Phase 1) | candidate threads (sent + stale), pre-fetched | thread summaries → scan prompt | `[commitment.record]` | upserts rows |
| **commitmentNudge** (Phase 2) | `commitment.due` events from selected rows | commitment rows → nudge prompt | `[nudge.push]` | fires one push per loop |

`commitmentScan` seeds an **empty** read-allowlist and never reads bodies beyond what the sweep pre-feeds — extraction works off the candidate summaries handed to it, so no thread-hallucination surface. `commitmentNudge` needs no mail tools at all; the row already carries summary + due.

## 4. Data model — `agent_commitments`

```sql
create table agent_commitments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  direction       text not null check (direction in ('you_owe','owed_to_you')),
  counterparty    text not null default '',          -- name/email of the other side
  summary         text not null,                     -- "Send the Q3 deck to Allan"
  due_at          timestamptz,                       -- explicit or inferred; null = no clear deadline
  due_inferred    boolean not null default false,    -- true if we guessed the date
  thread_id       text not null,
  provider        text not null check (provider in ('google','microsoft')),
  source_excerpt  text not null default '',          -- the sentence that triggered it
  last_message_at timestamptz,                        -- newest msg in thread at extraction (reconciliation anchor)
  status          text not null default 'open'
                    check (status in ('open','nudged','resolved','dismissed','expired')),
  created_at      timestamptz not null default now(),
  nudged_at       timestamptz,
  resolved_at     timestamptz,
  -- per-user extraction watermark lives in a separate column on user_profiles or
  -- a tiny agent_commitment_scan_state table; see §5.
  unique (user_id, thread_id, direction)
);
create index on agent_commitments (user_id, status, due_at);
```

**Dedup invariant:** one open commitment per `(user, thread, direction)`. Re-extraction **upserts** on that key — refreshes `summary`, `due_at`, `last_message_at` — never duplicates. (Mirrors the `agent_events_calendar_upcoming_dedup` pattern, but here the durable row *is* the dedup, not an event index.)

RLS: owner-only `select`; writes are service-role (the edge fn) only, matching the other agent tables.

## 5. Phase 1 — extraction

**Cadence / watermark.** Extraction is heavier than nudging and doesn't need 2h freshness. A per-user `commitments_scanned_at` watermark (column on `user_profiles`, or a small state table) gates it: only re-extract if the watermark is older than ~6h. Phase 2 still runs every sweep.

**Candidate threads** (pre-fetched by the sweep, fed to Claude as context — Claude does not free-search):

1. **Sent mail**, `in:sent newer_than:7d` (Gmail) / `sentitems` last 7d (Graph). The user's own words → source of `you_owe` promises.
2. **Stale threads** — threads whose newest message is older than the silence threshold. Classify by who spoke last:
   - last message **inbound** (from them), contains an ask, user hasn't replied → `you_owe` (a reply is owed)
   - last message **outbound** (from user), looks like a question/ask, no reply since → `owed_to_you`

For each candidate the sweep hands Claude: subject, counterparty, the latest message text, who sent it, and its age. Claude decides whether a real commitment exists and calls **`commitment.record`** with `{ direction, counterparty, summary, due_at?, due_inferred, thread_id, provider, source_excerpt }`.

**`commitment.record` tool** (new `ActionType` `commitment.record`). A DB-write context tool — not a provider action, no proposal, no policy gate (it touches only our own table). The dispatcher branch upserts into `agent_commitments` on the dedup key and returns `recorded` / `updated`. Registered in `MAIL_TRIAGE_TOOLS`? **No** — scan-only, added to a new `COMMITMENT_SCAN_TOOLS` set and to `SUPPORTED_ACTIONS` / `TOOL_NAME_TO_ACTION` / the dispatcher switch (the standard new-tool checklist from `project_autonomous_agent_phase4a.md`).

**Due inference.** Explicit deadline in text → `due_at` set, `due_inferred=false`. Otherwise infer a soft due (`due_inferred=true`): `you_owe` promise → `+2` business days from the promise; `owed_to_you` → `+3` days from `last_message_at`. Null only when truly open-ended.

## 6. Phase 2 — reconcile + due-nudge

**Reconcile first** (cheap, no Claude). For each `open` row, compare the thread's current newest-message timestamp against stored `last_message_at`:

- `owed_to_you` and a **new inbound** message arrived → they replied → `status='resolved'`, `resolved_at=now()`.
- `you_owe` and the **user sent** a new message after `created_at` → likely handled → `status='resolved'`.
- past `due_at + 7d` with no movement → `status='expired'` (stop nudging; never auto-resolved, so it's distinguishable in metrics).

So loops close themselves; the user is never nagged about something already handled.

**Select due** (conservative cadence):

- `you_owe`: `due_at <= now + 24h` and not yet nudged today.
- `owed_to_you`: silent (`last_message_at < now - 3d`) and `nudged_at is null` (waiting-on nudges once, not daily).

Emit one deduped **`commitment.due`** `agent_event` per selected row, then `executeRun(..., commitmentNudgeStrategy)`. The strategy prompts Claude with the commitment(s); Claude phrases the Danish nudge and calls `nudge.push` with idem `commitment:<thread_id>:<day>` (one nudge per loop per day max). On a real send, set `nudged_at=now()`, `status='nudged'`.

Routing the nudge through Claude (rather than a templated string) buys good Danish phrasing and a final "is this actually worth a ping" judgment, consistent with calendar-prep.

## 7. Edge / failure handling

- **Per-provider isolation** — a failing Gmail or Graph read is swallowed (logged) so one provider can't blank the sweep, matching `agent-reflect`'s `readUpcoming`.
- **Quiet hours** — the whole per-user run is skipped during `[22:00, 07:00)` local, gated *before* any `commitment.due` insert (same reasoning as calendar-prep: don't consume the daily dedup while suppressing the push).
- **Budget** — `runReflect`-style runs keep their own budget guard; `executeRun` does not budget-check.
- **Outlook sent/stale limits** — Graph `$search` can't filter sent-vs-received or by date cleanly; use `/me/mailFolders/sentitems/messages` for sent and `receivedDateTime` ordering for stale. Documented as a known sharper-edge than Gmail.
- **`commitment.record` is non-thread-scoped** — add `commitment.record` to `NON_THREAD_ACTIONS` so the thread hallucination-guard is skipped (it carries `thread_id` as data, not as a read target).

## 8. Testing

- Pure units: due-inference, stale classification (who-spoke-last × age), select-due predicate, reconcile state transitions. All table-driven, no network — the bulk of confidence lives here.
- Dispatcher: `commitment.record` upsert (insert vs update-on-conflict), `commitment.due` nudge idem.
- Strategy wiring: `commitmentScan` empty-allowlist, `commitmentNudge` tools = `[nudge.push]`.
- Live smoke (the non-negotiable gate, per this codebase's history): seed a real promise in sent mail → run the fn → assert a row, then a nudge with the right idem key; reply in a waiting-on thread → assert it reconciles to `resolved`.

## 9. Slice order (for the implementation plan)

1. **Engine + `you_owe`-from-sent + due-nudge** — table, `commitment.record`, scan strategy (sent only), reconcile, nudge strategy. **Smoke-test on the real mailbox before going further** — this codebase's expensive lesson is that "shipped" ≠ "ran".
2. **`owed_to_you`** — stale-thread detection + classification, waiting-on nudge.
3. **Reconciliation polish + in-app "Open loops" list** (deferred surface).

Both directions land in v1; slice 1 just sequences the simpler half first so the layer is proven before the harder signal stacks on it.

## 10. New-tool checklist (don't miss a seam)

Adding `commitment.record` + `commitment.due` touches, per `project_autonomous_agent_phase4a.md`:
`ActionType` (types.ts) · `TOOL_NAME_TO_ACTION` + `actionTypeFromToolName` (prompt.ts) · new `COMMITMENT_SCAN_TOOLS` catalogue · `SUPPORTED_ACTIONS` + `NON_THREAD_ACTIONS` (runner.ts) · dispatcher switch (tools/dispatch.ts) · the new `commitmentScanStrategy` / `commitmentNudgeStrategy` in runner.ts · `agent-commitments` fn + cron registration (remember: pg_cron templates are NOT auto-applied — verify the `cron.job` row).
