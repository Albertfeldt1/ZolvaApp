# Calendar Writes — `cal.create_event` + `cal.update_event`

**Date:** 2026-05-30
**Status:** Design approved, pending spec review
**Phase:** Autonomous agent — Phase 4 remainder (sub-project A)

## Summary

Give the autonomous mail-triage agent the ability to **create** and **update**
calendar events on Google and Outlook, surfaced as approve-cards on the Today
feed and reversible via the existing Undo button.

This is the first of five Phase-4-remainder sub-projects (the others —
proactive scheduling, memory/nudge/standing-task actions, event emitters, and
provider parity — are out of scope here).

## Scope

**In scope**
- ActionTypes `cal.create_event` and `cal.update_event`.
- Providers: **Google** (Calendar API) and **Outlook** (Microsoft Graph).
- Trigger: the existing **`mail.new`** pipeline. The agent reads a thread and,
  when it concerns scheduling, proposes a calendar action:
  - *"Can we meet Tuesday at 3?"* → `cal.create_event`
  - *"Let's push our 2pm to Thursday"* → `cal.update_event`
- Safety: both default to **propose** — the write happens only when the user
  taps approve on the Today feed.
- **Full undo** for both, post-execution, via the existing Undo affordance.

**Explicitly out of scope (deferred)**
- `cal.rsvp` and the dedicated `calendar.invite` emitter / event kind. RSVP's
  invite→event-id linkage and provider response mechanics are the only risky
  part; deferred to a follow-up cycle.
- iCloud calendar writes (consistent with the current iCloud-not-in-agent-path
  gap).
- `cal.suggest_times`, proactive/scheduled triggers, and all non-calendar
  Phase-4 actions.

## Architecture — reuse the existing propose → approve → execute → undo flow

The system already has every seam we need. Calendar writes slot into the same
machinery `mail.send_reply` uses.

### The propose/execute split

The dispatcher (`_shared/agent/tools/dispatch.ts`) executes a tool one of two
ways, keyed on `opts.policy`:

- **`policy !== 'auto'`** (normal agent tick): return
  `{ mode: 'propose', recordPayload: <intended event fields> }` **without
  writing anything**. The runner then writes a `proposed_actions` row.
- **`policy === 'auto'`** (`agent-approve` after the user taps approve, or a
  user who explicitly set the action to auto in Settings): perform the write,
  capture a reverse token, return `{ mode: 'executed', reversible: true,
  reverseToken }`.

Because of this split, **`agent-approve` needs no changes** — it already loads
the correct provider token, builds `ExecuteContext`, calls
`executeTool(..., { policy: 'auto' })`, and mirrors the result into
`agent_actions` (which is what makes the Undo button work).

Calendar writes do **not** use the `mail.send_reply` safety rails (idle /
recipient-allowlist / thread-researched). Those are send-specific. The
propose/execute decision for calendar writes is purely `opts.policy === 'auto'`.

### Policy / Settings

Both actions ship with default policy **propose** (already present in
`DEFAULT_POLICY` / `ACTION_DEFAULT_MODE`). They are added to the Settings policy
picker so a user *may* opt them up to `auto` (execute on tick, still undoable)
or down to `off`. No special-casing — consistent with the existing policy model.

## Components & changes

### Server

1. **`_shared/agent/tools/calendar-write.ts`** (new — sits beside the
   read-only `calendar.ts`)
   - `googleCreateEvent` / `outlookCreateEvent` → create event, return
     `{ eventId, reverseToken }`. Reverse = delete the created event.
   - `googleUpdateEvent` / `outlookUpdateEvent` → **read the event first** to
     capture prior fields, then patch. Return `{ reverseToken }` where the
     reverse restores the captured prior fields.
   - Typed reverse tokens (see §Reverse tokens).

2. **`_shared/agent/tools/calendar.ts`** (read tool — extend)
   - Add `id` to `CalEvent` and select it from both providers
     (`events.list` item `id`; Graph `calendarView` `id`). `cal.update_event`
     needs an event id to target, and the agent only learns ids via
     `cal_list_events`.

3. **`_shared/agent/tools/dispatch.ts`** — add `cal.create_event` and
   `cal.update_event` cases implementing the propose/execute split. Validate
   required payload fields (`provider`, `title`, `start_iso`, `end_iso` for
   create; `provider`, `event_id` + changed fields for update).

4. **`_shared/agent/prompt.ts`**
   - Add `cal_create_event` and `cal_update_event` to `MAIL_TRIAGE_TOOLS`
     (underscore tool names → input schemas).
   - Add both to `TOOL_NAME_TO_ACTION`.
   - Extend the Danish system prompt: research-first — call `mail_get_body`
     (and `cal_list_events` to find an existing event / check conflicts) before
     proposing a calendar action; create only when the thread clearly proposes a
     concrete time; update only against an event id returned by
     `cal_list_events`. Be conservative when the time/details are ambiguous.

5. **`_shared/agent/runner.ts`**
   - Add both action types to `SUPPORTED_ACTIONS`.
   - These carry a source `thread_id` from the mail but their *intent* is event
     fields, not a thread mutation. Ensure the thread hallucination-guard
     handles them correctly (treat as non-thread for the guard, or validate the
     carried thread_id against the allowlist — pick one and document it in the
     case).
   - `buildProposalPreview`: add Danish cases — `cal.create_event` →
     `{ title: 'Opret begivenhed?', body: '<title> · <when>' }`;
     `cal.update_event` → `{ title: 'Ret begivenhed?', body: '<what changes>' }`.

6. **`agent-undo/index.ts`** — the largest edge-fn change. Today it is
   **Google-only** (hardcoded google token, kinds `gmail.modify` / `gmail.draft`).
   - Add reverse-token kinds: `gcal.event_delete`, `gcal.event_restore` and the
     Outlook equivalents `mscal.event_delete`, `mscal.event_restore`.
   - **Select the provider token from the token** (`token.provider`) instead of
     always loading the google refresh token.
   - Apply: delete event (create-undo) or patch event back to prior fields
     (update-undo). Make delete idempotent (treat 404/410 as success, matching
     the draft-undo idempotency precedent).

### Client

7. **`src/lib/agent-feed.ts`** — add `'cal.create_event' | 'cal.update_event'`
   to the strict `AgentActionRow.action_type` union.

8. **`src/components/AgentActionCard.tsx`** — add `TITLES` entries
   (`'cal.create_event': 'Begivenhed oprettet'`, `'cal.update_event':
   'Begivenhed opdateret'`) and `detailFor()` cases (event title + time).

9. **`src/components/AgentActionPolicySection.tsx`** — add both to the local
   `ActionType` union and the `ROWS` array with Danish labels and default mode
   `propose`.

10. **`ProposedActionCard` / `TrustOfferCard`** — no change. `ProposedActionCard`
    is generic over `preview`; `TrustOfferCard` only fires for `mail.send_reply`.

## Reverse tokens

```
{ kind: 'gcal.event_delete' | 'mscal.event_delete', provider, event_id }
{ kind: 'gcal.event_restore' | 'mscal.event_restore', provider, event_id, prior: <captured fields> }
```

`prior` is captured at execution time (in the dispatcher's auto path, i.e. on
approve), since only then do we read the live event. Restore patches the same
fields back.

## Data model

No schema changes. `proposed_actions`, `agent_actions`, `user_agent_policy`,
and their reverse-token columns already accommodate the new action types and
token kinds (payloads are JSONB; action_type is text).

## Testing

- **Dispatch unit tests** (mirror existing `dispatch` tests): for each of
  create/update — propose path returns `mode:'propose'` and performs no write;
  auto path calls the correct provider fn and returns a typed reverse token.
- **Calendar-write unit tests**: create returns an event id; update reads-then-
  patches and the reverse token carries prior fields.
- **agent-undo tests**: each new reverse-token kind reverses correctly, the
  provider token is selected from the token, and delete is idempotent on 404.
- **`cal_list_events` test**: event `id` is now included in results.

## Risks & mitigations

- **Update target accuracy** — the agent could patch the wrong event. Mitigated
  by: propose-by-default (user sees the change before it lands), full undo, and
  requiring the event id to come from `cal_list_events` (no invented ids), which
  mirrors the existing thread-id hallucination guard.
- **Timezone correctness** on create/update. Use ISO-8601 with explicit offset
  end-to-end; Graph reads already set `Prefer: outlook.timezone="UTC"`.
- **Scopes** — the Google access token already covers `calendar.events`
  (per `cal_list_events`, which reads with the same token). Confirm the write
  scope is granted; if Google calendar *write* needs a broader scope than the
  current grant, that is a consent-screen change to surface before build.

## Build sequence

1. Extend `CalEvent` with `id` (read tool) + test.
2. `calendar-write.ts` create/update impls + reverse tokens + tests.
3. Dispatch cases (propose/execute split) + tests.
4. Prompt: tools, name map, system-prompt guidance; runner `SUPPORTED_ACTIONS`
   + `buildProposalPreview`.
5. `agent-undo`: provider-aware token loading + new reverse-token kinds + tests.
6. Client: union, card labels/details, Settings rows.
7. Deploy server functions first (per the client/server split convention), then
   OTA the client.
