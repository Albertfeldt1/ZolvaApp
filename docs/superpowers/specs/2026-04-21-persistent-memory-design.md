# Persistent User Memory — Design

**Date:** 2026-04-21
**Branch:** feature/notifications
**Status:** Approved via brainstorm, ready for implementation plan.

## Goal

Zolva builds a living profile of each user — who they are, their relationships, their ongoing projects, their commitments — and persists it across sessions. Every Claude call in the app receives a condensed Danish preamble derived from this profile so Zolva stops feeling like a stranger on every new screen. Today each Claude call is stateless: chat lives only in `AsyncStorage`, observations and mail analysis see only today's calendar + unread mail, and the "Memory" screen only shows user-created notes and reminders.

## User-facing shape

- **New behaviour:** Zolva gradually builds a picture of the user from their chat messages and mail decisions. It proposes new facts gently ("Skal jeg huske at Maria er din leder?") inside the existing "Hvad jeg har bemærket" feed with one-tap accept/reject. Accepted facts flow into every subsequent Claude call as context.
- **Memory screen reshaped:** `MemoryScreen` becomes a three-tab hub:
  1. *Fakta om dig* — confirmed facts, grouped by category, editable/deletable.
  2. *Noter & påmindelser* — existing user-created content.
  3. *Samtalehistorik* — full chat log with a delete-all button.
- **Consent-gated:** first launch post-update shows a one-time Danish consent modal. Memory stays off until the user explicitly enables it.

## Architecture

### Write side (learning)

**Triggers.** Extractor fires after:
- Chat turn completed (in the `sendMessage` flow, after assistant reply flushed).
- Mail draft saved (`generateDraft` success).
- Mail deferred / dismissed (user action).
- Mail replied-for-real (detected on next `poll-mail` round via outbound detection).

**Debounce.** 2-second trailing debounce per trigger type; one in-flight extractor per user per type. A burst of three chat turns collapses into one extraction pass over a rolling window.

**Extractor call.** Small fixed-prompt Claude call via existing `claude-proxy`. Haiku, `max_tokens ≈ 150`. Returns strict JSON:

```json
{ "candidate": { "text": "...", "category": "relationship|role|preference|project|commitment|other", "confidence": 0.0 } | null }
```

`attachProfile: false` on this call — extracting facts from the user's own words must not be biased by the existing profile.

**Dedup + insert.** If `candidate` is non-null and `confidence ≥ 0.6`, check `facts` for any row with matching `normalized_text` where `status = 'confirmed'` OR (`status = 'rejected'` AND `rejection_ttl > now()`). If none, insert `status='pending'` with `source = 'chat:<msg_id>' | 'mail:<thread_id>'`.

**Fire-and-forget.** Extractor errors are dev-logged only. Never surfaces to the user, never blocks the trigger.

### Read side (runtime injection)

**`buildProfilePreamble(userId): Promise<string>`** — new helper in `src/lib/profile.ts`. Composes a Danish preamble:

```
Om brugeren:
• Du er … (role/other)
• Du foretrækker … (preference)

Relationer:
• Maria – din leder
• Mikkel – bedste ven, arbejder hos Nordea

Igangværende:
• Nordea-pitch – deadline 28. april

Seneste kontekst:
[3 most recent chat_messages truncated to ~120 chars each]
[5 most recent mail_events: "Mikkel <…>: 'Pitch update' – deferred 2d siden"]
```

Hard cap 800 tokens; oldest context lines drop first when over budget. Empty string if `memory_enabled = false` or Supabase unreachable.

**Injection choke point.** `src/lib/claude.ts` grows `attachProfile?: boolean` option on `complete` / `completeJson`, default `true`. Helper calls `buildProfilePreamble` and prepends result as the first block of `system`.

**Prompt caching.** Preamble goes in as `{type: 'text', text: <preamble>, cache_control: {type: 'ephemeral'}}`. `claude-proxy` accepts `system` as string OR `Array<{type,text,cache_control?}>` and forwards to Anthropic as-is. Anthropic's cache keeps the preamble hot ~5 min per user, so token cost is paid once per window regardless of how many app-side Claude calls fire.

**Memoization.** Module-level `Map<string, {value: string, signature: string}>` keyed by `user_id`, invalidated when `factsSignature` (hash of `max(updated_at) + count` on `facts`) changes. Accept/reject handlers invalidate synchronously; a Supabase Realtime subscription on `facts` keeps cross-device state fresh.

**Demo mode.** `isDemoUser(user)` short-circuits `buildProfilePreamble` to return a static pre-baked Danish profile from `src/lib/demo.ts`. No Supabase queries.

## Data model

Already applied to Supabase. Tables (all with RLS `auth.uid() = user_id` for all ops, cascade-delete from `auth.users`):

```sql
facts (
  id uuid PK,
  user_id uuid FK cascade,
  text text,                 -- "Maria er din leder"
  normalized_text text,      -- for dedup / fuzzy match
  category text,             -- relationship | role | preference | project | commitment | other
  status text,               -- pending | confirmed | rejected
  source text,               -- "chat:<msg_id>" | "mail:<thread_id>"
  created_at, confirmed_at, rejected_at, rejection_ttl timestamptz
)

chat_messages (
  id uuid PK,
  user_id uuid FK cascade,
  client_id text,            -- AsyncStorage id, for sync dedup
  role text,                 -- user | assistant | tool
  content text,
  created_at timestamptz,
  UNIQUE (user_id, client_id)
)

mail_events (
  id uuid PK,
  user_id uuid FK cascade,
  event_type text,           -- read | deferred | dismissed | drafted_reply | replied
  provider_thread_id text,
  provider_from text,
  provider_subject text,
  occurred_at timestamptz
)
```

Indexes: `facts(user_id, status)`, `chat_messages(user_id, created_at DESC)`, `mail_events(user_id, occurred_at DESC)`, partial unique `facts(user_id, normalized_text) WHERE status='confirmed'`.

**Deliberate tradeoff:** `provider_subject` + `provider_from` leave the device. Mail bodies do not. This lets Zolva say "you deferred Mikkel's pitch thread last week" without body copies in Supabase.

## Privacy, migration, kill-switch

- **`memory_enabled`** — new row in existing work preferences (or minimal new `user_preferences` table), default `false`.
- **Consent modal** — one-time on first launch after this ships: plain Danish bullets explaining what's stored (chat, mail metadata, facts) and what isn't (bodies). Two buttons: *Aktivér hukommelse* / *Ikke nu*. "Ikke nu" re-prompts once after 14 days, then never.
- **Local-chat migration** — on opt-in, background promise uploads existing AsyncStorage chat to `chat_messages` using `client_id` for dedup. Partial failures leave remainder local; retried on next app open.
- **Kill switch** — `memory_enabled = false` toggle on MemoryScreen stops extractor calls, preamble injection, and chat sync immediately. Adjacent buttons: *Slet profil* (wipes `facts`) and *Slet samtalehistorik* (wipes `chat_messages` + `mail_events`).
- **Delete account** — existing cascade already covers new tables; no edge-function changes.
- **Supabase outage** — `buildProfilePreamble` returns empty string; features degrade to stateless Zolva. No user-visible error.
- **Feature flag** — `EXPO_PUBLIC_PROFILE_MEMORY` env var wraps the whole feature at app level for phased rollout.

## Out of scope (v2 candidates)

- Embedding-based semantic retrieval (pgvector).
- Full mail body storage.
- Fact confidence decay / auto-forgetting.
- Realtime cross-device live sync of pending proposals (v1 polls on screen focus).
- Interactive profile editor with multi-select category filters.

## Open questions resolved during brainstorm

- Learning scope: chat + passive suggestions from mail/calendar (user-confirmed). Never silent persistence of inferred facts.
- Raw-history scope: chat full text + structured mail events. No bodies.
- Extraction timing: live event-driven, not cron.
- Preamble injection: every Claude call, single choke point via `claude.ts`.
- Proposal UX: inline in existing observations feed, same gating, same visual language.
