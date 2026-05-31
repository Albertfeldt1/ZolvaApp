# agent-reflect — calendar-prep nudges (Phase 4)

**Status:** design approved 2026-05-31
**Scope:** first shippable slice of `agent-reflect` (spec `2026-05-11-autonomous-background-actions-design.md` §7.4). Builds directly on the shipped `nudge.push` tool — this is what gives it something to fire.

## 1. Goal

Make Zolva proactively useful around the calendar: shortly before a meeting, send the user one timely push — *"Møde med Anders om 2t · 14:00 · Zoom. I tråden aftalte I at han sender tallene først."* — combining the event with light context pulled from the user's own mail.

This is the first proactive (non-mail-triggered) agent behaviour. It exists to:
- exercise and prove out `nudge.push` with real, time-anchored value, and
- build the reusable **reflect runner-path** that later proactive features (briefs, fact follow-ups, standing tasks) plug into.

## 2. Non-goals (explicitly deferred)

- **Drive context.** The OAuth scope was downgraded `drive.readonly` → `drive.file` (2026-05-31), so `drive_search` now only sees files the user picked/created through Zolva — which the autonomous agent never does. Drive context is dead for reflect until a Picker exists. Mail context is the valuable one.
- Morning/midday/evening **briefs** — overlap the existing `daily-brief` function; revisit later.
- **`fact.due`** follow-ups (needs `memory.followup_draft`, unbuilt).
- **RSVP / reschedule** (`cal.rsvp`, reflect-driven `cal.update_event`).
- **iCloud** calendars (CalDAV reader only partially built).
- **Quiet-hours gating** is the *next* work item (#2) and lands right after this; see §7.

## 3. Architecture — shared core + two strategies (Approach A)

The current `runAgent` is hardwired to mail-triage: a fixed thread allowlist, a mail prompt, thread-anchored bookkeeping. Reflect diverges in four places, so we extract the engine and let each path supply a strategy.

Extract `runAgentCore` from `runAgent`, owning the parts that do not change between paths:
budget-check → gather work → open run → **Claude tool loop + dispatch + idem + recordAction/fireNudge** → mark processed → finish run with usage + trace.

A **strategy** supplies the parts that differ:

| Strategy | Gather work | Context → prompt | Tool set | Read-allowlist model |
|---|---|---|---|---|
| **mail-triage** (existing) | claim `agent_events` (mail.*) | thread briefs → `buildMailTriagePrompt` | `MAIL_TRIAGE_TOOLS` | **fixed** — built once from the triggering threads |
| **reflect** (new) | claim `calendar.upcoming` events | event details → `buildReflectPrompt` | `REFLECT_TOOLS` | **grows** — seeded empty, extended by `mail_search` results |

```
agent-tick  ──▶ runAgent(mail-triage strategy)  ─┐
                                                  ├─▶ runAgentCore ─▶ agent_runs + trace
agent-reflect ─▶ runReflect(reflect strategy)   ─┘
```

### Strategy interface (sketch)

```ts
interface AgentStrategy {
  // What work items this run operates on (mail: claimed agent_events;
  // reflect: claimed calendar.upcoming events). Both are ClaimedEvent[].
  gatherWork(userId: string): Promise<ClaimedEvent[]>;
  // Build the per-run context + prompt from the work items.
  buildContext(userId: string, events: ClaimedEvent[]): Promise<{ system; messages }>;
  tools: ReadonlyArray<ToolDef>;
  // Seed the readable-thread allowlist for this run.
  seedAllowlist(events: ClaimedEvent[]): Set<string>;
  // After a tool result, optionally extend the allowlist (reflect: a
  // mail_search result adds its returned thread_ids). Returns the ids to add.
  extendAllowlist?(action: ActionType, recordPayload: Record<string, unknown>): string[];
}
```

The mail-triage-specific bookkeeping that lives in the loop today (`researchedThreads`, `draftDetail`, `sourceBodyByThread`, `sourceFrom`) stays attached to the **mail strategy**, not the core. Reflect carries only its discovered-thread set.

**Correctness guard:** mail-triage behaviour must be byte-identical after the extraction. The 179 existing agent tests are the regression gate — the refactor lands green or it does not land.

## 4. Event production — `agent-reflect` edge fn + sweep cron

New edge function `agent-reflect`, invoked by a **~30-minute sweep cron** (`x-cron-secret`, deployed `--no-verify-jwt`). For each eligible user (agent enabled, has a push token):

1. **Cheap calendar read first.** Read Google + Outlook calendars for events with `start` in `[now, now + LEAD_WINDOW]`. `LEAD_WINDOW = 2h` (default, tunable).
2. **Coarse filter** (noise control, before any Claude call): skip all-day events; skip events where the user is the only attendee (solo / focus blocks); skip cancelled or user-declined events.
3. **Emit + dedup.** For each surviving event with no existing `calendar.upcoming` row for `(user_id, event_id, day)`, insert one `agent_events` row `kind='calendar.upcoming'`, `payload={event_id, provider, start, title, location, attendees, description, minutes_until, day}` where `day` is the Europe/Copenhagen date (matching the nudge idem `day`). Dedup enforced by a partial unique index on `(user_id, kind, (payload->>'event_id'), (payload->>'day')) where kind='calendar.upcoming'`.
4. **Only then run.** If (and only if) at least one event was emitted, invoke `runReflect` for the user. No qualifying events → no run, no Claude call → most sweeps are free.

The nudge idem key (`nudge.push:<kind>:<event_id>:<day>`) is the final backstop against double-nudging if dedup ever races.

## 5. The reflect run

`REFLECT_TOOLS = [mail_search, mail_get_body, nudge_push]`.

**Prompt** (`buildReflectPrompt`, Danish system prompt + per-run event list, current Copenhagen date injected like the mail prompt):
> Du er Zolva. Her er brugerens kommende begivenheder (de næste 2 timer) med tid, sted, deltagere og beskrivelse. For hver begivenhed: afgør om en kort heads-up hjælper. Hvis ja, må du `mail_search` efter en relateret tråd (på en deltagers e-mail eller emnet) og `mail_get_body` for at læse den, og derefter `nudge_push` én kort dansk påmindelse der nævner begivenheden og evt. relevant kontekst. Vær konservativ — spring rutine-/gentagne møder over og alt der ikke kræver forberedelse. Maks. én nudge pr. begivenhed.

**Discovered-thread safety:** `mail_get_body` is permitted only on a `thread_id` that a prior `mail_search` returned in **this run**. The loop seeds an empty allowlist and `extendAllowlist` adds each `mail_search` hit. A `mail_get_body` on an un-searched id is rejected by the same hallucination guard mail-triage uses — preserving "never act on an invented ID."

## 6. New `mail_search` tool

- **ActionType:** `mail.search`. Claude-facing name `mail_search`. Default policy `auto`.
- **Shape:** read-only, **context-only** (no `agent_actions` row, like `cal.list_events` / `drive.search`), and **non-thread** (input is a query, not a `thread_id`, so it skips the thread guard).
- **Input:** `{ query: string, provider: 'google'|'microsoft', limit?: number }`. `query` may be an attendee email and/or subject keywords.
- **Dispatch:** Gmail `users.messages.list?q=<query>` then group by `threadId`; Outlook `GET /me/messages?$search="<query>"`. Returns top-N `{ thread_id, from, subject, snippet, date }`.
- **Runner wiring:** add to `SUPPORTED_ACTIONS`, `CONTEXT_ONLY_ACTIONS`, `NON_THREAD_ACTIONS`; in reflect, its result feeds `extendAllowlist`. The dispatcher returns the hit list as the tool result so Claude can choose a thread to read.

`mail.search` is added to `DEFAULT_POLICY` + `ACTION_DEFAULT_MODE` (`auto`), `TOOL_NAME_TO_ACTION`. It is **reflect-only** for now (not in `MAIL_TRIAGE_TOOLS`).

## 7. Quiet-hours interaction (handoff to item #2)

Reflect nudges currently call `fireNudge` directly, like all nudges. Item #2 routes every nudge through presence/quiet-hours gating (`shouldPushForProposal`). For calendar-prep specifically there is an open question: a 09:00 meeting needs its prep nudge at ~07:00, which may fall inside "quiet hours" — so time-anchored prep nudges may warrant an exemption. **Decision deferred to #2.** This spec leaves `fireNudge` as-is; #2 owns the gate.

## 8. Error handling, budget, observability

Inherited from `runAgentCore`, unchanged from mail-triage:
- One `agent_runs` row per reflect run, `trigger='reflect.sweep'`, with the per-turn `trace`.
- Per-user daily budget ceiling applies; exceeded → the run returns `budget_exceeded` and emits nothing (reflect stops for the day, per the parent spec §11).
- A tool failure (provider 4xx, etc.) is surfaced to Claude as an `is_error` tool_result inside the per-tool try/catch; it never strands events. Events are marked processed in `finally`.

## 9. Testing

- `mail_search` dispatch — Gmail `q=` grouping + Outlook `$search`, top-N shape, both providers.
- Reflect strategy — `gatherWork` (claims `calendar.upcoming`), `buildReflectPrompt` includes event fields + Copenhagen date, tool set is `REFLECT_TOOLS`.
- Discovered-allowlist — `mail_search` result lets a later `mail_get_body` on a returned thread pass; `mail_get_body` on an un-searched id is rejected; `nudge_push` fires.
- `agent-reflect` event computation — pure filter function: window bound, all-day skip, solo skip, declined skip, emit-dedup.
- **Mail-triage regression** — the existing 179 agent tests stay green through the `runAgentCore` extraction.
- Cron template present; deploy checklist notes the manual `cron.job` apply + verification (pg_cron templates are not auto-applied).

## 10. Rollout

Server-first, per project convention: `agent-reflect` + the `runAgentCore`/`mail_search` shared changes get their own commit and deploy (`--no-verify-jwt`) before any client work. There is **no client change** in this slice (nudges already display; deep-linking + Today-feed card are items #3/#4, later). DB: one migration for the `calendar.upcoming` dedup unique index; one cron schedule template (manual apply + verify `cron.job`).
