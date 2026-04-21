# Daily Brief — Design

**Date:** 2026-04-21
**Branch:** feature/notifications
**Status:** Approved via brainstorm, ready for implementation plan.
**Depends on:** `2026-04-21-persistent-memory-design.md` (reads `facts.category = 'commitment'` and `mail_events`).

## Goal

A real morning (and optional evening) brief that tells the user what matters today: meetings, things they promised people, unread mail highlights, pending reminders, and the weather. Delivered both as a push notification at the scheduled time and as a hero banner on the Today screen when the user opens the app. Today the `morning-brief` setting is a passive gate (nothing pushes) and `day-overview` is dead config that reads nowhere.

## User-facing shape

- User sets morning and/or evening brief times in *Indstillinger → Arbejde*.
- At the scheduled time:
  - **Push** arrives with the brief headline. Tap → opens Today.
  - **Today hero banner** appears above "Hvad jeg har bemærket" with the full brief — headline, 3–5 sentence body, weather chip.
- Banner dismisses when marked read; shows again only when a new brief generates.
- If user opens the app *before* the scheduled time, no brief. If they open it *after* the window and a push never fired (permission denied or device offline), the brief still materializes in the banner on first open within the same day.

## Architecture

### Scheduling

**`daily-brief` Edge Function** — cron-scheduled via Supabase Cron every 15 minutes.

Flow per invocation:
1. Compute the current 15-min window (e.g. 08:00-08:14).
2. Query users where `morning-brief` OR `evening-brief` preference value falls in the window AND no `briefs` row exists today for that kind.
3. For each matched user, compose brief (see next section), insert into `briefs`, send push.

Service-role only; never called from the client.

### Composition

Per user, the function gathers:
- **Calendar** — today's events from Google/Microsoft using the stored refresh token (same path `poll-mail` already uses).
- **Unread mail** — counts + top 3 by sender/subject (no body fetch).
- **Commitments** — `facts` where `user_id = $1 AND category = 'commitment' AND status = 'confirmed'` (depends on memory feature).
- **Reminders** — pending reminders due today or overdue (uses existing reminders store).
- **Weather** — Met.no forecast for user's stored location.

All fed to Claude via service-role variant of `claude-proxy` with a fixed Danish composer prompt that returns structured JSON:

```json
{
  "headline": "Kort dagsopsummering",
  "body": ["Sætning 1.", "Sætning 2.", "..."],
  "tone": "calm|busy|heads-up"
}
```

Brief is stored in `briefs` table, push sent with `headline` as the body.

### Weather (Met.no / yr.no)

- Endpoint: `GET https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=&lon=`
- Required `User-Agent: Zolva/1.0 feldten@me.com` (per Met.no terms).
- Edge Function caches per `(lat,lng)` for 30 min (shared across users in same area).
- Simplified payload: current temp + today's high/low + condition symbol token → mapped to a Danish label ("Lettere regn", "Sol og skyer").

### Client behaviour

**On TodayScreen mount and focus:**
- Fetch today's brief from `briefs` via a new `useTodayBrief()` hook (`user_id = auth.uid()` AND `date(generated_at) = today` AND `kind` matching current window — morning if before 15:00, evening after).
- If present and `read_at IS NULL`, render hero banner above observations.
- Banner close button sets `read_at = now()`.

**Push handling:**
- Existing push token infra (push_tokens table) is reused.
- Push payload includes `data.kind = 'brief'` so tap routes to Today rather than a mail detail.
- No foreground notification if app is open to Today — banner is enough.

## Data model

```sql
briefs (
  id uuid PK,
  user_id uuid FK cascade,
  kind text check (kind in ('morning','evening')),
  headline text not null,
  body jsonb not null,           -- string[]
  weather jsonb,                  -- {temp, high, low, condition, label}
  tone text,                      -- calm | busy | heads-up
  generated_at timestamptz default now(),
  delivered_at timestamptz,       -- push send timestamp
  read_at timestamptz
);

-- Unique: one brief per user per kind per day
create unique index briefs_user_kind_day_idx
  on briefs (user_id, kind, (generated_at::date));
```

User location is hardcoded to Copenhagen (`lat 55.6761, lng 12.5683`) in v1 — no user-facing setting. Adding a city picker or GPS permission is v2 scope to keep v1 shipping without a geocoder dependency (Met.no is weather-only).

## Preferences changes

- **Delete** the dead `day-overview` config (`src/lib/hooks.ts:1002-1008`, `src/lib/types.ts:115`, `src/screens/SettingsScreen.tsx:388`).
- **Keep** the existing `morning-brief` row (`Fra / 07.00 / 08.00 / 09.00`). Already surfaced in Settings; now it does something.
- **Add** `evening-brief` row (`Fra / 17.00 / 18.00 / 19.00`, default `Fra`).
- **No** user-facing location row in v1 — hardcoded Copenhagen. Surfacing location as a preference waits for v2 so we don't have to ship a geocoder.

## Fallbacks

- **No Google/Microsoft token** → skip calendar section silently.
- **Met.no 503 / rate limit** → skip weather section silently.
- **Claude unavailable** → don't generate the brief; no push, no banner. Retry next cron tick.
- **No content at all** (no events, no unread, no commitments, no reminders) → skip brief (no "empty brief" push).
- **No push permission** → brief still materializes in banner on next Today open same day.

## Fact loop (depends on memory feature)

When a brief surfaces a commitment ("Du lovede Maria en draft i dag"), tapping it should be able to jump to the draft flow or mark complete. v1 scope: tap opens chat pre-filled with the commitment text. v2: inline actions.

## Out of scope (v2)

- Interactive brief actions (draft reply from brief, mark commitment done).
- Multi-location / travel mode.
- Brief history archive screen.
- Per-brief notification sounds / custom push appearance.
- Content-type preferences (e.g. "skip weather", "only meetings").
- Midday brief option.
- Location picker UI (v1 uses text input + geocode).

## Decisions locked in from brainstorm

- Delivery: **C** — push at scheduled time + pull on Today banner.
- Weather source: **A** — Met.no (free, no key, Danish-appropriate).
- Schedule: **B** — configurable via existing work prefs (morning-brief reused; new evening-brief).
- Output surface: **B** — Today hero banner; push is just the headline + deep link.
