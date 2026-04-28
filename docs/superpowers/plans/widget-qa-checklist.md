# Widget v1 — Manual QA checklist

Run on a TestFlight build (or dev build with the widget added to the simulator homescreen).

## Setup
- [ ] Install widget from gallery: tap and hold homescreen → "+" → Zolva → Medium → Add.
- [ ] Open Zolva at least once so an initial snapshot lands.
- [ ] Verify widget no longer shows "Åbn Zolva for at opdatere".

## States
- [ ] **Morning (06:00–10:00 device time):** brief headline visible if a brief was generated today.
- [ ] **Pre-meeting (within 30 min of an event start):** "Du har et møde om {title} om in N minutes".
- [ ] **During meeting (between event start and end):** "Du er i et møde: {title}".
- [ ] **Evening (after 17:00):** evening recap headline if generated today.
- [ ] **Idle (no brief, no nearby meeting):** "Næste: {title} · in N hours" or "Spørg Zolva...".
- [ ] **Stale (>24h since last write):** "Åbn Zolva for at opdatere" + chat row.

## Tap targets
- [ ] Tap brief / next event area → opens app to today tab.
- [ ] Tap meeting nudge → opens app to calendar tab.
- [ ] Tap chat row → opens app with chat tab + keyboard up.

## Refresh triggers
- [ ] Backgroud app, change a brief or calendar event in the source provider, foreground app — widget reflects within 5 seconds.
- [ ] Lock device for 5 minutes, unlock — widget renders the right state for current time without explicit user action.

## Edge cases
- [ ] Sign out → snapshot clears → widget shows chat-only state. No leak of previous user's data.
- [ ] Disconnect all calendar providers → widget shows brief or chat-only, never "next event".
- [ ] Toggle airplane mode → widget keeps last known state (no network needed for v1).
