# Unify imap-proxy onto session-bound iCloud credentials

**Status:** Deferred (target: v3 or first follow-up after v2 ships)
**Created:** 2026-04-29
**Owner:** Albert (solo)
**Related migration:** `supabase/migrations/20260429140000_icloud_calendar_creds.sql`

## Context

As of 2026-04-29, Zolva has **two parallel patterns** for handling iCloud credentials server-side:

1. **`imap-proxy` — passthrough.** Client ships `{ email, password }` in every request body. Server stores only an HMAC binding (`icloud_credential_bindings.credential_hash`) for anti-credential-stuffing. The actual creds are not persisted server-side.

2. **`widget-action` voice path — session-bound (new in v2).** Client sends creds **once** to `icloud-creds-link`, which encrypts and stores them in `user_icloud_calendar_creds`. Subsequent voice writes read + decrypt from this table; no creds in any request body.

Pattern 2 is the right shape for the voice case (Siri runs without the app open, so client can't supply creds per call). Pattern 1 is the right shape for the *imap-proxy* original use case (client is open and authenticated, no creds-at-rest cost).

But: **two patterns for the same credential set is a permanent footgun.** Symptoms a future engineer (probably future-Albert in 6-12 months) will hit:

- Two code paths to debug when iCloud calendar/mail breaks. Which one applied when this user changed passwords?
- Cred rotation: when the user updates their app-specific password, do they update via imap-proxy's HMAC re-bind path *or* via icloud-creds-link upsert? Currently both, independently. If they get out of sync, voice writes use stale creds while mail uses current ones. Or vice versa.
- A "disconnect iCloud" UX has to fire both `imap-proxy clear-binding` AND `icloud-creds-revoke`. Forgetting one leaves a dangling artifact.
- New iCloud features (reminders? notes?) — which pattern do they pick? Bikeshedding for every new surface.

## Decision

**Defer the unification.** v2 ships with both patterns. Voice path uses session-bound; imap-proxy stays passthrough. This is fine **temporarily** because:

- Both patterns are documented (see migration headers).
- The voice path is the *new* feature; imap-proxy already works in production and changing it is a regression risk.
- v2 has a hard deadline; doing both is too much for one ship.

**Plan: in v3 (or first dedicated cleanup after v2 ships), migrate imap-proxy to read creds from `user_icloud_calendar_creds`.**

## Migration sketch (for v3)

1. Update `imap-proxy` to optionally read creds from `user_icloud_calendar_creds` if the request body omits `email`/`password`.
2. New client builds: drop the `email`/`password` fields from imap-proxy request bodies. Old builds still send them (compatibility window).
3. Migrate existing `icloud_credential_bindings` rows: for each user with a binding but no `user_icloud_calendar_creds` row, prompt re-auth on next iCloud action so they go through `icloud-creds-link`.
4. After ~2 release cycles (≥4 weeks), require `user_icloud_calendar_creds` row for all imap-proxy ops. Drop the `email`/`password` fields from the request type. Keep the HMAC binding column for one more release as a sanity check, then drop.
5. Once stable, drop `icloud_credential_bindings.credential_hash` (or the whole table — depends on whether we still want a per-user "iCloud connected" flag).

## What this trades off

- Pro: one canonical iCloud cred path. One bug surface. One disconnect call. One rotation flow.
- Pro: smaller request bodies for imap-proxy (no creds shipping per request).
- Pro: aligns with how Google/Microsoft tokens work (server-stored, used on demand).
- Con: imap-proxy's threat model becomes "stored creds" instead of "passthrough." The mitigations are the same as in the voice-path migration (pgcrypto, key in env, audit log). Threat model documented at `supabase/migrations/20260429140000_icloud_calendar_creds.sql`.
- Con: migration takes coordinated client + server changes across release cycles.

## Triggers to revisit (i.e., do this sooner if any of these happen)

- Second iCloud bug caused by the dual-pattern split.
- Adding a third iCloud surface (reminders, notes, photos) where the pattern choice matters.
- Auditor asks "where do iCloud creds live?" and the answer is "depends on which feature."
- Future engineer (you in 8 months) asks "which one is canonical" with non-trivial confusion.

## Why this lives in a doc and not a TODO comment

A TODO comment in `imap-proxy/index.ts` rots. A decision file in `docs/decisions/` is searchable, dated, and links the *why* to the *when*. When v3 planning starts, grep this directory.
