# Widget v2 — Manual on-device QA checklist

Real iPhone (Keychain access groups behave differently in the simulator).
Both Danish and English iOS locale required.

> **Note (2026-04-29):** v2 ships with a two-turn voice flow — phrase
> trigger ("Spørg Zolva") then Siri prompts for the dictation
> ("Hvad vil du bede Zolva om?"). The single-shot phrasing in lines
> 783–784 below is from the original spec; on-device behaviour will be
> two-turn. Mark those items based on the two-turn flow and note any
> deviations.

## Setup
- [ ] Fresh login as albertfeldt1@gmail.com on device
- [ ] Connect Google calendar (currently `calendar.readonly` scope — voice writes will fail with `permission_denied`)
- [ ] Connect Microsoft calendar (currently `Calendars.Read` — same as Google)
- [ ] Connect iCloud (Settings → iCloud → app-specific password) — voice WRITES go through this path
- [ ] Settings → Stemmestyring → pick an iCloud calendar as Work
- [ ] Settings → Stemmestyring → pick an iCloud calendar as Personal

## Voice trigger paths
- [ ] "Hey Siri, bed Zolva om at sætte et møde i morgen kl. 17" *(now two-turn: phrase fires, Siri prompts for dictation)*
- [ ] "Hey Siri, ask Zolva to set a meeting tomorrow at 5 PM" *(two-turn)*
- [ ] Action Button bound to "Spørg Zolva" — press, then speak
- [ ] **DA bare invocation:** "Hey Siri, spørg Zolva" — Siri's
       requestValueDialog prompts "Hvad vil du bede Zolva om?", user
       dictates, full transcript ships. If Apple silently lands on
       `perform()` with empty `prompt`, widget surfaces `empty_prompt`
       worried snippet with example phrase. Document observed behaviour.
- [ ] **EN bare invocation:** "Hey Siri, ask Zolva" — same flow in
       English. Compare DA + EN behaviour; if the prompt only fires in
       one locale, file as a known limitation in v2 ship notes.

## Routing
- [ ] No calendar hint → lands in Personal (default label)
- [ ] "i min arbejdskalender" → lands in Work
- [ ] "in my work calendar" → lands in Work
- [ ] Misspelled hint ("im my workkalender") → Claude either matches or
       falls back to default; verify dialog says which calendar was used
- [ ] iCloud calendar appears in `events.icloud.com` after voice create
       (web client; native iOS Calendar app should also show it after a
       refresh)
- [ ] Verify the event title, start, and end match what was spoken

## Response surface
- [ ] Success: Stone happy + summary line + spoken confirmation
- [ ] Time format: "i morgen kl. sytten" (DA) / "tomorrow at five PM" (EN);
       NEVER "17:00" / "1700" / ISO timestamp in spoken response
- [ ] Visible snippet matches spoken response
- [ ] Tap success snippet → opens calendar tab on the right day at the new event

## Failure paths
- [ ] Disconnect from internet → "Forbindelse fejlede. Prøv igen."
- [ ] Manually clear access token from shared keychain (dev tool), keep
       refresh token → voice call → refresh path fires, success (with
       slight latency increase, no user-visible failure)
- [ ] Manually clear BOTH tokens → voice call → "Du er logget ud" +
       deep-link to settings
- [ ] Sign out from another device (refresh token revoked server-side) →
       voice call → refresh fails with 401 → "Du er logget ud"
       (distinct from tokens-missing code path)
- [ ] Pick a Google calendar with read-only access → write fails with
       `permission_denied` dialog naming that calendar
- [ ] Speak gibberish → `unparseable` dialog routes to chat
- [ ] No calendar labels set → routes to Settings with the "vælg" copy

## Auth state matrix
- [ ] Fresh login → first voice call works (cached access token still valid)
- [ ] Fresh login → wait 65 minutes → voice call → AppIntent silently
       refreshes; user sees success, dialog spoken without delay >2s extra

## Disconnect flow (auto-clear)
- [ ] Disconnect Google → Work/Personal labels pointing at Google
       cleared in Settings UI; voice calls re-route or surface
       `no_calendar_labels`.
- [ ] Disconnect iCloud → Work/Personal labels pointing at iCloud
       cleared (mirrors auth.ts disconnectProvider for google/microsoft).
       Verify in DB:
       `SELECT work_calendar_provider, personal_calendar_provider FROM
       user_profiles WHERE user_id = '<albert>'` should show `icloud`
       gone from both columns.
- [ ] Disconnect iCloud → server-side row gone:
       `SELECT count(*) FROM user_icloud_calendar_creds WHERE user_id =
       '<albert>'` returns 0.
- [ ] Disconnect iCloud → audit row written:
       `SELECT event, called_at FROM icloud_calendar_creds_audit WHERE
       user_id = '<albert>' ORDER BY called_at DESC LIMIT 1` returns
       `revoke`.
- [ ] Reconnect Google → no restore-prompt fires in v2 (deferred to
       v2.x). User picks Work label fresh in Settings.
- [ ] Reconnect iCloud → server-side row recreated; audit row written
       with event=link.
- [ ] After reconnect, voice call routes to the freshly-picked label correctly.

## Latency
- [ ] Hey Siri → spoken response: target ≤6s on cold Edge Function, p95 ≤4s warm
- [ ] If Siri shows the "thinking..." spinner for >8s, that's a fail —
       Edge Function is too slow; profile and fix server-side, NOT extend
       the AppIntent client timeout

## Privacy spot-check
- [ ] Check Supabase function logs (Dashboard → Edge Functions →
       widget-action → Logs) after 5 voice calls — log lines contain
       only the structured fields (action, success, error_class,
       calendar_resolution, calendar_provider, prompt_language,
       latency_ms, claude tokens). NEVER the raw transcript or any
       free-form prompt text. (No `widget_action_calls` table — v2
       ships with ephemeral logging only, per privacy-policy verdict
       recorded in plan Task 2.)
- [ ] Check icloud-creds-link logs after iCloud connect — log lines
       contain `kind`, `user_id`, and `success` only. NEVER the
       payload (email/password/calendar_home_url).
- [ ] Verify `user_icloud_calendar_creds.encrypted_blob` is gibberish
       in raw form (not the JSON cleartext):
       `SELECT length(encrypted_blob), encode(encrypted_blob, 'hex')
       FROM user_icloud_calendar_creds WHERE user_id = '<albert>'`

## Latency profiling (TestFlight gate)

- [ ] 5 cold-start calls, 15+ min apart between each — record `max`. Target: cold ≤6s.
- [ ] 20+ back-to-back warm calls — record p50, p95. Target: p50 ≤2.5s, p95 ≤4s.
- [ ] If p95 misses, profile per-step (Claude vs DB vs provider write) and
       fix server-side. Don't extend the Swift client timeout.

## Privacy policy follow-up (TestFlight gate)

- [ ] Add a Siri/voice paragraph to `albertfeldt1.github.io/ZolvaApp/`
       privacy policy before TestFlight. Suggested wording:
       *"Voice input via Siri: When you trigger Zolva via 'Hey Siri',
       the spoken transcript is processed by Apple's Speech framework
       on-device, then sent to our Edge Function for parsing. The
       transcript text is forwarded to Anthropic's Claude (under the
       terms above) to extract event details, then discarded after the
       calendar event is created. We do not store voice audio."*

## Voice — reminder branch

- [ ] "Hey Siri, Zolva husk mig på at ringe mor kl. 17"
       Expected: snippet says "Jeg minder dig om at ringe mor i dag kl. sytten."
       Reminder appears in public.reminders with the correct due_at.
- [ ] "Hey Siri, Zolva remind me to take meds at 8 pm"
       Expected: snippet in English; reminder created.
- [ ] "Hey Siri, Zolva sæt et møde i morgen kl. 17"
       Expected: STILL routes to create_calendar_event (event branch); not
       create_reminder. Calendar event lands in iCloud as before.
- [ ] At the reminder's due time: push notification fires from
       reminders-fire cron, NOT from the device (kill the app first to
       confirm the push reaches it).
- [ ] After push tap: deeplink lands on Memory tab (zolva://memory).

## Server-side reminders DB spot-check

- [ ] After voice creates a reminder:
       SELECT id, title, due_at, fired_at, scheduled_for_tz
       FROM public.reminders
       WHERE user_id = '<user>' ORDER BY created_at DESC LIMIT 5;
       Expected: row exists, fired_at is null, scheduled_for_tz matches
       the user's locale tz.
- [ ] After the cron has fired:
       fired_at is non-null, push delivered to device.
- [ ] Reminders-fire idempotency: manually update fired_at back to null
       (DEV ONLY); next cron tick re-fires once and re-stamps.
