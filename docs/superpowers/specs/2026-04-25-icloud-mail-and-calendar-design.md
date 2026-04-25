# iCloud Mail and Calendar — Design

**Date:** 2026-04-25
**Branch:** TBD (suggested: `feature/icloud-provider`)
**Status:** Approved via brainstorm, ready for implementation plan.
**Depends on:** Existing OAuth/secureStorage infrastructure (`src/lib/auth.ts`, `src/lib/secure-storage.ts`); existing connection-row UI pattern in `src/screens/SettingsScreen.tsx`; existing `claude-proxy` edge function pattern.

## Goal

Add iCloud as a first-class mail and calendar provider alongside Gmail and Outlook. Users authenticate with their iCloud email and an Apple-issued app-specific password, captured once on the device. Inbox and Today screens then surface iCloud mail and calendar events merged with any other connected providers.

This was triggered by a real user (Allan, signed in with Apple Sign In + Hide My Email) connecting "Google" and finding his Inbox empty. Diagnosis: his Google account at `feldten@me.com` (an iCloud-domain email used to register a Google identity) has no Gmail mailbox; his actual mail is in iCloud Mail. The product currently has no path to read it.

## User-facing shape

- **Settings → Forbundet** has a new top-of-list row "iCloud" with a generic cloud icon. Tapping it pushes a dedicated `IcloudSetupScreen`.
- **Setup screen** walks the user through generating an Apple app-specific password (with a screenshot of the Apple settings menu), captures email + password, validates both IMAP and CalDAV before persisting, and pops back on success.
- **Inbox** merges iCloud mail with any other connected providers, sorted by date.
- **Today / Upcoming events** merges iCloud calendar events with Google/Microsoft.
- **Daily brief is unchanged for v1.** It continues to require Gmail or Outlook. iCloud-only users see the brief setting disabled with a "Læs mere" affordance explaining why and offering a "Forbind Gmail" CTA. (See "Future: brief support for iCloud-only users" below.)
- When the stored credential is later rejected by Apple (user revoked the app-specific password, account locked, etc.), Settings shows the iCloud row in an `'expired'` state and Inbox/Today display a banner: *"Apple afviste adgangskoden — iCloud-mails vises ikke. Tryk for at genindtaste."* Tap → re-entry flow with email pre-filled.

## Architecture

### Components

```
┌───────────────────────────────┐
│  IcloudSetupScreen            │ user enters email + app pwd, validates both probes
│  (new — pushed from Settings) │ on success: writes via icloud-credentials.ts
└──────────────┬────────────────┘
               │
               ▼
        ┌─────────────────┐
        │ icloud-         │  Storage interface — secureStorage today,
        │ credentials.ts  │  designed to swap implementations later.
        │ (new)           │  Three-state: 'absent' | { state:'valid' } | { state:'invalid' }
        └─────────────────┘
               │ read by
       ┌───────┴────────┐
       ▼                ▼
┌────────────┐   ┌──────────────────┐
│ icloud-    │   │ icloud-mail.ts   │
│ calendar.  │   │ (new — proxy     │
│ ts (new)   │   │ client)          │
│            │   │                  │
│ HTTPS/     │   │ HTTPS POST to    │
│ CalDAV     │   │ supabase edge fn │
│ direct to  │   │ /imap-proxy      │
│ Apple      │   └────────┬─────────┘
└─────┬──────┘            │
      │                   ▼
      │          ┌──────────────────┐
      │          │ supabase/        │
      │          │ functions/       │
      │          │ imap-proxy/      │
      │          │ (new edge fn —   │
      │          │ npm:imapflow,    │
      │          │ Deno node-compat)│
      │          └────────┬─────────┘
      │                   │ TCP+TLS
      │                   ▼
      │          ┌──────────────────┐
      │          │ imap.mail.me.com │
      ▼          │ :993             │
   caldav.icloud │                  │
   .com (CalDAV) │                  │
      │                   │
      └─── parsed → ──────┘
                          │
                          ▼
        Existing client surfaces:
        • useMailItems  → InboxScreen
        • useCalendarItems / useUpcoming → TodayScreen
```

### Three new components

1. **`IcloudSetupScreen`** — capture & validate credentials.
2. **`icloud-credentials.ts`** — typed storage interface over secureStorage; swap point for future server-side migration.
3. **Edge function `imap-proxy`** — `npm:imapflow` over Deno node-compat. Stateless, per-request connections.

Plus two thin client modules: **`icloud-mail.ts`** (calls the proxy) and **`icloud-calendar.ts`** (calls Apple direct).

## Trust model

**Two trust boundaries, asymmetric by design.**

- **Calendar credentials reach Apple only.** Device → `caldav.icloud.com` over TLS. The credential is in transit to Apple and at rest only on the device.
- **Mail credentials reach Apple and the Zolva `imap-proxy` edge function.** Device → edge function over TLS → `imap.mail.me.com` over TLS. The proxy is a credential intermediary by design.

The asymmetry is deliberate. CalDAV is HTTPS that the device speaks safely with `fetch`. IMAP is a stateful, literal-laden, parser-bug-prone TCP protocol; doing it on-device requires hand-rolling a client on top of `react-native-tcp-socket` (whose new-architecture support is unverified as of April 2026 — Issue #187 still open). Routing IMAP through an edge function lets us use `imapflow` (battle-tested Node IMAP client, actively maintained, latest release Apr 17 2026) instead of writing the parser ourselves. Routing CalDAV through the same proxy would add credential exposure with no offsetting safety gain.

**Blast radius is worse than our existing OAuth surfaces — acknowledged.** A leaked Google or Microsoft refresh token is scoped (`gmail.modify`, `Calendars.Read`, etc.) and revocable from the provider's account console. A leaked Apple app-specific password is unscoped: it grants IMAP, SMTP, CalDAV, CardDAV (contacts), and notes access. There is no per-app revocation API; the user must visit appleid.apple.com and manually delete the password they generated for Zolva. The `imap-proxy` credential surface is higher-blast-radius than `claude-proxy` or `user_oauth_tokens` — do not equate them.

**Mitigations on the `imap-proxy` edge function:**

- No request-body logging — only `{ user_id, op, error_code, latency_ms }`.
- Pinned `imapflow` version (`npm:imapflow@1.3.2`); upgrades require explicit review.
- Hardcoded target — no `host` parameter on the request shape; rejects any input that would change destination.
- TLS-only outbound; STARTTLS path disabled.
- Per-IMAP-command timeout of 10s, connect timeout of 5s.
- Per-user rate limits (10 `validate`/hour, 60 `list-inbox`/hour) tracked in `icloud_proxy_calls` table; HTTP 429 on overflow.
- Credential-to-user binding via `icloud_credential_bindings` table. On `validate` success, upsert HMAC-SHA256(BINDING_HASH_PEPPER, email + ':' + password) keyed to `user_id`. On every `list-inbox`, recompute the hash from the request body and require match. Mismatch returns the same `auth-failed` shape as wrong-password — no oracle.
- Returned error bodies use typed codes only — no exception details, no IMAP raw responses, no host info.
- Function size kept small (≤200 lines + imapflow) so security review is feasible.

## Data model

### Type changes (`src/lib/types.ts`)

```ts
// Add to IntegrationKey
| 'icloud'

// Add to MailProvider
| 'icloud'

// Add to UpcomingEvent.source
| 'icloud'

// Extend IntegrationStatus
export type IntegrationStatus = 'connected' | 'pending' | 'expired' | 'disconnected';
//                                                       ^ new — credential rejected by provider

// IntegrationStatus 'pending' currently exists in the type but is never set anywhere.
// Leave it for the future "OAuth flow in flight" semantic. 'expired' is added separately
// because the two states have different UX and different transitions:
//   pending  = transient, user-initiated, UI is a spinner
//   expired  = persistent, not user-initiated, UI is a re-entry banner
```

### Status labels (`src/screens/SettingsScreen.tsx`)

```ts
const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected:    'Forbundet',
  pending:      'Venter',
  expired:      'Genindtast adgangskode',  // generic; OAuth providers can override per-row
  disconnected: 'Ikke forbundet',
};
```

`'expired'` as the enum value (semantically: "stored credential no longer accepted by provider") with a per-provider label override mechanism for future OAuth providers if/when they want a different word ("Udløbet" for genuine clock-based expiry).

### Credential storage interface (`src/lib/icloud-credentials.ts`)

```ts
export type IcloudCredentialState =
  | { kind: 'absent' }
  | { kind: 'valid';   email: string; password: string; lastSyncCursor: SyncCursor | null }
  | { kind: 'invalid'; email: string; password: string; lastSyncCursor: SyncCursor | null };

export type SyncCursor = { uidValidity: number; lastUid: number };
// v1 ignores SyncCursor — included in the type now so the storage shape doesn't have
// to change when/if server-side polling is added later.

export async function loadCredential(userId: string): Promise<IcloudCredentialState>;
export async function saveCredential(userId: string, email: string, password: string): Promise<void>;
export async function clearCredential(userId: string): Promise<void>;
export async function markInvalid(userId: string, reason?: string): Promise<void>;
```

Backed by secureStorage with key `zolva.${userId}.icloud.credential`. The interface is the seam for migrating to a server-side credential store later (see "Future" section).

**Platform behaviour for credential persistence across reinstall:**

- **iOS** — Keychain entries can survive app uninstall by default. Reuse the existing `SECURE_STORE_MIGRATION_FLAG` pattern (see `src/lib/auth.ts`) to wipe orphaned iCloud credential entries on first launch after install. Without this, a user who reinstalls Zolva would find iCloud "still connected" with credentials they may have forgotten.
- **Android** — `expo-secure-store` (Keystore-backed) is wiped on app uninstall by default; no migration flag needed. Behaviour can change if the user has Android Auto Backup enabled — verify during implementation that `android.allowBackup=false` (or appropriate `dataExtractionRules` for Android 12+) is set on the manifest, so credentials don't sync to Google Drive.

Add to verification items below: confirm the manifest backup config and document the iOS-vs-Android divergence in code comments where the credential is stored.

### New tables (`supabase/migrations/2026XXXX_icloud_proxy.sql`)

```sql
CREATE TABLE icloud_credential_bindings (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_hash   text NOT NULL,
  last_validated_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE icloud_proxy_calls (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  op         text NOT NULL CHECK (op IN ('validate', 'list-inbox')),
  called_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX icloud_proxy_calls_user_called ON icloud_proxy_calls (user_id, called_at DESC);

-- No RLS grants — service role only.
ALTER TABLE icloud_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE icloud_proxy_calls         ENABLE ROW LEVEL SECURITY;

-- Cron: daily cleanup of stale bindings AND old call records.
SELECT cron.schedule(
  'icloud-binding-sweep',
  '0 4 * * *',  -- daily 04:00 UTC
  $$
  DELETE FROM icloud_credential_bindings WHERE last_validated_at < now() - interval '90 days';
  DELETE FROM icloud_proxy_calls         WHERE called_at         < now() - interval '30 days';
  $$
);
```

**Why these numbers:**
- **Bindings: 90 days.** App-specific passwords don't expire on Apple's side, so any cleanup interval is artificial. With bind-on-first-list-inbox + refresh-on-every-list-inbox, the row stays alive as long as the user actively fetches mail. 90 days is generous enough that vacationers, less-active users, or users who set up iCloud and primarily check mail in iCloud Mail.app don't hit a re-auth cliff. The 30-day number that appeared in earlier drafts was security theater. After cleanup the next list-inbox fails closed (auth-failed), the user re-enters, the binding is recreated.
- **Proxy calls: 30 days.** Long enough to investigate any abuse pattern that surfaces (bursty validate spam, unusual rate-limit triggers). Tiny table — a row per call, one row per user-call-event.

## iCloud Mail (IMAP via edge proxy)

### Step 0 — TCP smoke test (gating prerequisite)

Before writing the proxy, verify Supabase's deployment actually permits outbound TCP to port 993. Source-code reading of `supabase/edge-runtime/crates/base/src/runtime/permissions.rs` shows user-worker `allow_net: Some(Default::default())` (empty allowlist = all net allowed in Deno's permission model), but that's runtime permission — production network layer (egress firewalls, NAT) is a separate question.

Deploy a 12-line throwaway probe:

```ts
// supabase/functions/tcp-probe/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

// IMPORTANT: recompute at deploy time. This is "intended deploy date + 48h".
// Set via Date.UTC(year, monthIndex, day) so it cannot silently rot to a past date.
// monthIndex is 0-based (3 = April).
const PROBE_EXPIRY = Date.UTC(2026, 3, 28); // 2026-04-28 00:00 UTC

serve(async () => {
  if (Date.now() > PROBE_EXPIRY) return new Response('Gone', { status: 410 });

  const t0 = performance.now();
  try {
    const conn = await Deno.connectTls({ hostname: 'imap.mail.me.com', port: 993 });
    conn.close();
    return Response.json({ ok: true, handshakeMs: Math.round(performance.now() - t0) });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
});
```

Deploy with `--no-verify-jwt`. Run 5 invocations from `curl`. Expected: `{ ok: true, handshakeMs: <50–300> }` consistently.

- **Success** → proceed with the proxy plan below.
- **Failure** (firewall above the runtime, regional restriction, etc.) → switch to Fly.io fallback before writing more code. Same imapflow code, different host. Architecture box unchanged; only the URL the client posts to changes from `${SUPABASE_URL}/functions/v1/imap-proxy` to `${IMAP_PROXY_URL}/`.

The probe expiry is defence in depth. Delete the function manually once the decision is made; the kill-switch ensures it goes inert if forgotten.

### Proxy contract

**Endpoint:** `POST /functions/v1/imap-proxy`

**Auth gate:** Required `Authorization: Bearer <supabase user jwt>`. Function calls `supabase.auth.getUser()` against the JWT to resolve `user_id` (used for rate limiting and binding check; not for credential lookup — credentials are in the request body).

**Request body:**

```ts
type Request =
  | { op: 'validate';   email: string; password: string }
  | { op: 'list-inbox'; email: string; password: string; limit?: number /* default 12, max 50 */ };
```

No `host` field. Target hardcoded `imap.mail.me.com:993` server-side.

**Response (success):**

```ts
type ValidateOk = { ok: true };

type ListOk = {
  ok: true;
  messages: Array<{
    uid:     number;
    from:    string;        // raw "Name <addr@host>" from envelope
    subject: string;
    date:    string;        // ISO 8601
    unread:  boolean;       // !flags.includes('\\Seen')
    preview: string;        // first 140 chars of text body, or '' if not retrievable
  }>;
};
```

**Response (error):**

| HTTP | Body `error` | Cause |
|---|---|---|
| 401 | `unauthorized` | JWT missing/invalid |
| 422 | `auth-failed` | Apple rejected credentials, OR binding hash mismatch |
| 429 | `rate-limited` | per-user quota exceeded (10/hr validate, 60/hr list-inbox) |
| 502 | `protocol` | unexpected IMAP response, parse error, unexpected close |
| 503 | `network` | upstream connection failed |
| 503 | `temporarily-unavailable` | IMAP NO without `[AUTHENTICATIONFAILED]`, or `[INUSE]` / `[UNAVAILABLE]` codes |
| 504 | `timeout` | per-command timeout fired |
| 500 | `internal` | unhandled exception (logged, generic body) |

Body shape on error: `{ ok: false, error: <code> }`. No exception details, no IMAP raw responses, no hostnames in returned bodies.

### IMAP operations

Both ops use a fresh imapflow connection per request (no pooling, no IDLE). Stateless function, scales to zero.

**`validate`** (called from the setup screen):
1. `client.connect()` — performs LOGIN.
2. `client.logout()`.
3. Return `{ ok: true }` or 422 `auth-failed`. **No DB writes.** Binding is established on first successful `list-inbox`, not here. Reason: a CalDAV-fails-but-IMAP-succeeded scenario at setup-screen time would otherwise create an orphan binding row for a credential the user never persists. Binding only on real-data fetch eliminates the orphan class entirely.

~1-2 round trips, typically <2s.

**`list-inbox`** (called from `useMailItems`):
1. Recompute hash from request body: `credential_hash = HMAC-SHA256(BINDING_HASH_PEPPER, email + ':' + password)`.
2. Look up `icloud_credential_bindings` for the JWT's `user_id`.
   - **Row exists**: `credential_hash` must match. Mismatch → return 422 `auth-failed` (same response shape as wrong password; no oracle).
   - **Row missing**: this is the user's first `list-inbox` for this credential. Proceed to step 3; on success, insert the binding row.
3. `client.connect()` — LOGIN.
4. `client.mailboxOpen('INBOX', { readOnly: true })`. Read-only is critical — prevents accidental `\Seen` flag mutations.
5. Get message count `n`. Range = `${Math.max(1, n - limit + 1)}:${n}` (last `limit` by sequence number).
6. `client.fetch(range, { uid: true, envelope: true, flags: true, bodyParts: ['1'] })`.
7. Map to response shape. Drop messages with malformed envelope. For preview: if `bodyParts['1']` looks like HTML (`<` in first 100 chars), strip tags via `replace(/<[^>]*>/g, '')` + decode common entities (`&amp; &lt; &gt; &nbsp; &#\d+;`), trim to 140. Otherwise use as-is, trim to 140. Lossy by design — full BODYSTRUCTURE parsing is future work.
8. `client.logout()`.
9. Upsert binding row: `credential_hash = <computed>`, `last_validated_at = now()`. (First call: insert. Subsequent calls: refresh `last_validated_at`, extends the 90-day TTL.)

**Security property** of the bind-on-first-list-inbox design: an attacker with a stolen JWT (and no existing binding for that user_id) gets exactly one shot to introduce any credential into the binding before being constrained to that credential. Combined with the 60/hour list-inbox rate limit, the abuse window is small. For users who already have a binding, the rate-limited validate endpoint exists for credential-checking without affecting the binding.

### Timeout semantics

Per IMAP command, not per session:

- **Connect** (TLS handshake + IMAP greeting): 5s. AbortController on `Deno.connectTls`.
- **Each IMAP command** (LOGIN, SELECT, FETCH, LOGOUT): 10s. imapflow's `socketTimeout` constructor option.
- **No per-session ceiling for v1.** With `limit ≤ 50` worst-case is ~5 commands × 10s = 50s, well within Supabase's default 150s function timeout.
- **Future "full-sync"** (if we ever add `limit > 50` pagination): wrap the whole session in a 60s ceiling separate from per-command timeouts. Out of scope for v1.

### Error mapping (imapflow → response)

| imapflow signal | response error / status |
|---|---|
| Response code `[AUTHENTICATIONFAILED]` on LOGIN | `auth-failed` (422) — flips client credential to `invalid` |
| Bare `NO` on LOGIN with no `[AUTHENTICATIONFAILED]` code | `temporarily-unavailable` (503) — does NOT flip credential |
| Response codes `[ALERT]`, `[INUSE]`, `[UNAVAILABLE]` | `temporarily-unavailable` (503) |
| `Deno.connectTls` throws `ConnectionRefused`, `NotFound`, `ConnectionReset`; DNS failure | `network` (503) |
| AbortController abort | `timeout` (504) |
| Unexpected `BAD` response, parse error, unexpected close | `protocol` (502) |

Client only flips credential state to `invalid` on `auth-failed`. All transient errors leave it `valid`.

### Connection cost — known overhead

Each `list-inbox` pays full TLS handshake + IMAP LOGIN + CAPABILITY + SELECT before the first FETCH. Typically 4-6 round trips on cold connection. Against `imap.mail.me.com` from a non-US-East Supabase region: ~400-800ms of pure handshake overhead per call.

Acceptable for app-open-driven fetches (typical inbox load: <1s perceived). **Any future polling-cron implementation must revisit** — 1440 LOGINs per user per day will get flagged as suspicious by Apple. Server-side polling needs persistent connections or IMAP IDLE in a different runtime that supports long-lived connections (Supabase edge functions max out at 150s).

### Mid-session credential rejection on the client

When `icloud-mail.ts` receives `{ ok: false, error: 'auth-failed' }`:

1. Call `markInvalid(userId)` in `icloud-credentials.ts` — flips stored credential's `kind` from `valid` to `invalid`.
2. The Connection layer surfaces this as `IntegrationStatus.expired`.
3. Settings row shows "Genindtast adgangskode" CTA → opens `IcloudSetupScreen` pre-filled with the email.
4. Inbox surface shows the standard auth-error banner.

`network` / `timeout` / `protocol` / `temporarily-unavailable` errors do **not** flip the credential — those are transient.

### Client shape — `src/lib/icloud-mail.ts`

```ts
export type IcloudMessage = {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  unread: boolean;
  preview: string;
};

export type IcloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'auth-failed' | 'network' | 'timeout' | 'protocol' | 'temporarily-unavailable' | 'rate-limited' | 'no-credential' };

export async function validate(email: string, password: string): Promise<IcloudResult<void>>;
export async function listInbox(limit?: number): Promise<IcloudResult<IcloudMessage[]>>;
```

`validate` is called from the setup screen with explicit args (no stored credential yet).
`listInbox` loads from `icloud-credentials.ts` and returns `'no-credential'` if absent or `kind === 'invalid'`. On `auth-failed`, calls `markInvalid` before returning.

### Integration with `useMailItems`

In `src/lib/hooks.ts:617`, add an iCloud branch parallel to Google/Microsoft:

```ts
if (icloudConnected) {  // credential.kind === 'valid'
  tasks.push(
    listInbox(12).then((r) =>
      r.ok
        ? r.data.map((m) => ({
            id: `icloud:${m.uid}`,
            provider: 'icloud' as const,
            from: m.from,
            subject: m.subject,
            receivedAt: m.date,
            isRead: !m.unread,
            preview: m.preview,
          }))
        : Promise.reject(toProviderError(r.error)),
    ),
  );
}
```

`NormalizedMail.id` gets a provider prefix (`icloud:<uid>`). Existing consumers treat IDs as opaque.

**v1 assumption — UID stability:** iCloud mail IDs are stable only for the lifetime of a single `useMailItems` result. Anything that persists message IDs across app sessions (read receipts, snooze, archive marks) must namespace by `UIDVALIDITY` too — out of scope for v1, designed-for in `lastSyncCursor: { uidValidity, lastUid }` in `IcloudCredentialState`.

## iCloud Calendar (CalDAV in-device)

### Endpoint and auth

- Host: `caldav.icloud.com`
- Auth: HTTP Basic — `Authorization: Basic ${btoa(email + ':' + password)}`
- Transport: HTTPS only, standard `fetch`
- No edge function — credential goes device → Apple direct

### Discovery (cached, with split TTL)

CalDAV requires three round trips before fetching events. Cache the resulting URLs with the credential.

```
1. PROPFIND https://caldav.icloud.com/.well-known/caldav
   Body: <propfind><prop><current-user-principal/></prop></propfind>
   Headers: Depth: 0
   → 207 Multi-Status with <current-user-principal><href>/123456789/principal/</href>
   → may return 301; follow once

2. PROPFIND https://caldav.icloud.com/123456789/principal/
   Body: <propfind><prop><c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav"/></prop></propfind>
   Headers: Depth: 0
   → 207 with <c:calendar-home-set><href>/123456789/calendars/</href>

3. PROPFIND https://caldav.icloud.com/123456789/calendars/
   Body: <propfind><prop><displayname/><c:supported-calendar-component-set/><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/></prop></propfind>
   Headers: Depth: 1
   → 207 with one <response> per calendar collection
```

Filter step 3 results to collections with `<c:comp name="VEVENT"/>` in supported-calendar-component-set (drops Reminders / Tasks calendars).

### Cache shape and TTLs (split)

```ts
type IcloudCalendarCache = {
  principalUrl:        string;
  calendarHomeUrl:     string;
  principalDiscoveredAt: number; // for principal + calendar-home cache
  calendars: Array<{ url: string; displayName: string; calendarColor?: string }>;
  calendarsListedAt:   number;   // for calendar list cache
};
```

- **principal + calendar-home TTL: 30 days.** Almost-never-changes.
- **Calendar list TTL: 24 hours.** Catches user-added subscriptions/shared calendars within a day.

### Re-discovery cascade

- 404 on REPORT (event fetch) → invalidate calendar list, re-fetch step 3 → re-attempt fetch on remaining valid URLs.
- 404 on PROPFIND of calendar-home → invalidate principal cache, re-discover from `.well-known/caldav` (steps 1-3).
- 404 on `.well-known/caldav` itself → mark credential `invalid` (account migrated or wrong creds).

### Event fetch

For each cached calendar URL, `REPORT` with `calendar-query` and time-range filter:

```
REPORT https://caldav.icloud.com/123456789/calendars/home/
Headers: Depth: 1, Content-Type: application/xml
Body:
<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="20260425T000000Z" end="20260502T000000Z"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>
```

Returns 207 multistatus with one `<response>` per matching event, each containing the full VCALENDAR/VEVENT block as text in `<c:calendar-data>`.

### Concurrency cap

Fetch up to **5 calendars in parallel**. Remaining calendars queue. Conventional browser per-host concurrent connection limit; protects power users (15-25 calendars is realistic with subscribed sports/holiday/school calendars) from triggering Apple's per-IP rate limiting and from blowing the device's mobile connection budget.

Implement as a tiny inline concurrency limiter (~10 lines) — no need to add `p-limit` dependency for one use site.

### Time horizon

**TODO during implementation, not deferrable to runtime:** read `src/lib/google-calendar.ts` and extract the time-range constant into a shared `CALENDAR_TIME_HORIZON` so the two providers can't drift. Apply the same range here. Do not hand-wave with "match Google's behavior" — make it a literal shared constant.

### Parsing — `ical.js`

Add `ical.js` (npm: `ical.js`, ~80KB minified, browser-compatible, MPL-2.0) as a runtime dependency.

```ts
import ICAL from 'ical.js';
const jcalData = ICAL.parse(calendarDataString);
const vcalendar = new ICAL.Component(jcalData);
const events = vcalendar.getAllSubcomponents('vevent').map((ve) => new ICAL.Event(ve));
```

**Recurring events** — drive the iterator within the time range:

```ts
if (event.isRecurring()) {
  const iter = event.iterator();
  let next;
  while ((next = iter.next()) && next.toUnixTime() * 1000 < timeRangeEnd) {
    if (next.toUnixTime() * 1000 >= timeRangeStart) {
      const details = event.getOccurrenceDetails(next);
      // IMPORTANT: per-occurrence fields use details.item (handles RECURRENCE-ID overrides),
      // master fields fall back to event.
      occurrences.push({
        title: details.item.summary,
        location: details.item.location,
        start: details.startDate.toJSDate(),
        end: details.endDate.toJSDate(),
      });
    }
  }
} else {
  occurrences.push(event);
}
```

### VTIMEZONE fallback (wired now, not deferred)

ical.js needs the VTIMEZONE component present in the same VCALENDAR for `TZID=` resolution. iCloud reliably includes VTIMEZONE blocks today, but if behavior changes the result is silently wrong-time events (off by the local UTC offset) — for Danish users with DST transitions twice a year, this manifests as "my 14:00 meeting shows at 13:00 for half the year." Unacceptable to ship without a fallback.

```ts
import ICAL from 'ical.js';

// Wire ical.js to fall back to platform tzdata via Intl.DateTimeFormat when
// a VEVENT references a TZID without a corresponding VTIMEZONE block in the
// same VCALENDAR.
function resolveTimezone(tzid: string): ICAL.Timezone | null {
  const known = ICAL.TimezoneService.get(tzid);
  if (known) return known;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid }); // probes platform tzdata
    if (__DEV__) console.warn('[icloud-cal] VTIMEZONE missing for', tzid, '— using Intl fallback');
    return makeIntlBackedTimezone(tzid); // ~30 lines: returns offset for arbitrary date via Intl
  } catch {
    return null; // truly unknown TZID → caller falls back to UTC + log
  }
}
```

Plus a `__DEV__` warning log when the fallback fires. If we ever see this in production telemetry (Sentry breadcrumb), Apple's behavior has changed.

### Client shape — `src/lib/icloud-calendar.ts`

```ts
export type IcloudCalEvent = {
  uid: string;            // VEVENT UID
  start: Date;
  end: Date;
  allDay: boolean;
  title: string;
  location?: string;
  description?: string;
  calendarColor?: string; // from owning calendar (not VEVENT-level COLOR)
  calendarName: string;
};

export type IcloudCalResult =
  | { ok: true; events: IcloudCalEvent[] }
  | { ok: false; error: 'auth-failed' | 'network' | 'timeout' | 'protocol' | 'no-credential' };

export async function listEvents(rangeStart: Date, rangeEnd: Date): Promise<IcloudCalResult>;
```

`auth-failed` here also calls `markInvalid` from `icloud-credentials.ts` (same flip semantics as Mail).

### Integration with `useCalendarItems` / `useUpcoming`

Pattern mirrors `useMailItems`: parallel fetch branch for iCloud when `credential.kind === 'valid'`, map to `UpcomingEvent` with `source: 'icloud'`.

`UpcomingEvent.source` adds `'icloud'`. Existing consumers (`calendar-events-today.ts` for pre-alerts, `useUpcoming` for Today screen) handle the new source value cosmetically (color, perhaps a small icon).

**Daily brief intentionally excluded.** `daily-brief` runs server-side and stays Google/Microsoft-only since iCloud credential never reaches the server in v1. See "Future" section.

## UX

### `IcloudSetupScreen`

Pushed from Settings via new `'icloud-setup'` route. Accepts optional `prefilledEmail?: string` for re-entry. Leaving = cancelling (nothing persisted until validate succeeds).

**Hero.** Eyebrow `'FORBIND ICLOUD'` (mono uppercase, matches existing pattern), H1 `'Forbind iCloud'`.

**Explainer paragraph** (no storage claims):

> Apple kræver en særlig adgangskode (én til hver app), så Zolva kan læse din mail og kalender. Du laver den selv på Apples side — det tager omkring et minut.

(Trust-model details belong in a future Privacy/About screen linked from Settings; out of scope for v1.)

**Step-by-step guide:**

1. **`Åbn Apples side`** — primary button. Opens `https://appleid.apple.com/account/manage` in `WebBrowser.openBrowserAsync` (in-app modal browser, dismissable).

2. **`Tryk på "Sign-In and Security" → "App-Specific Passwords"`** — text + **inline screenshot of the Apple settings menu showing the path. Required for v1.** Allan is 62; if the screenshot isn't ready by impl time, generate a placeholder by taking one ad-hoc (5 minutes, doesn't need a designer). Do not ship text-only as v1 default — measurably lower setup conversion without it.

3. **`Generér en ny adgangskode og navngiv den "Zolva"`** — text. Subtle warning: *`Apple viser kun adgangskoden én gang. Kopiér den med det samme.`*

4. **`Skift tilbage til Zolva og udfyld nedenfor`** — points to form.

**Form fields:**

*iCloud-email* — TextInput
- `placeholder='navn@me.com / @icloud.com'`
- `keyboardType='email-address'`, `autoCapitalize='none'`, `autoCorrect={false}`, `autoComplete='email'`
- Prefilled in re-entry flow
- **On blur:** if email doesn't end in `@me.com`, `@icloud.com`, or `@mac.com`, show inline warning (non-blocking): *`iCloud kræver en @me.com, @icloud.com eller @mac.com adresse. Tjek at du har skrevet din iCloud-mail (ikke fx @gmail.com).`* Catches the obvious wrong-account mistake before the confusing network error.

*App-specifik adgangskode* — TextInput
- `placeholder='xxxx-xxxx-xxxx-xxxx'`
- Monospace font (matches Apple's display format)
- `autoCapitalize='none'`, `autoCorrect={false}`, `autoComplete='off'`
- **`secureTextEntry={true}` by default**, with eye-icon toggle on the right side of the field. Tap to reveal, tap to hide. Free security wins: iOS auto-scrubs `secureTextEntry` fields from app-switcher snapshots; protects against screen recordings, AirPlay, and shoulder-surfing. Reveal-on-demand satisfies the paste-verification need.

**Wrong-format detection** (non-blocking inline warning):

- Strip whitespace and hyphens from input. Normalized form should be 16 chars.
- Warn if the password contains anything other than `[a-z\-\s]` after the user has typed ≥8 chars: *`Det ligner ikke en app-specifik adgangskode (xxxx-xxxx-xxxx-xxxx). Tjek at du har genereret en ny adgangskode på Apples side — din normale Apple-adgangskode virker ikke her.`*
- Catches "user pasted their regular Apple password" (which contains uppercase/digits/symbols) without false-positiving on hyphen variations.
- Display value with hyphens re-inserted every 4 chars for user confidence.
- Send normalized (no hyphens, no whitespace) to the proxy.

**Submit (`Forbind` button):**

- Disabled while either field empty OR validation in flight.
- On press: atomic dual-probe — `validate(email, password)` against `imap-proxy` AND CalDAV `PROPFIND` on `/.well-known/caldav` (current-user-principal lookup, lightest-weight CalDAV op) — in parallel via `Promise.all`. Both must succeed. If either fails, abort.
- Loading state: button shows spinner + `'Tester forbindelse…'`.

**Capture-time validation lifecycle and binding row:**

The proxy's `validate` op does NOT touch the binding table — it just probes Apple's auth and returns ok/error. The binding is established by the first successful `list-inbox` call, which happens *after* the user's credential is persisted on the device. This eliminates the orphan-binding class entirely: there's no path where a binding row exists for a credential the user never saved.

If the parallel CalDAV probe fails at setup time, the client doesn't `saveCredential`, no list-inbox is ever attempted, no binding row is created. Clean failure with no server-side residue.

**Error mapping** (after submit failure, inline above form):

| Error code | Inline message |
|---|---|
| `auth-failed` (either probe) | `Forkert email eller adgangskode. Tjek at du har lavet en app-specifik adgangskode (ikke din normale Apple-adgangskode).` |
| `network` | `Ingen forbindelse til Apple. Tjek dit internet og prøv igen.` |
| `timeout` | `Apple svarer ikke. Prøv igen om lidt.` |
| `rate-limited` | `For mange forsøg. Prøv igen om en time.` |
| `protocol` / `temporarily-unavailable` | `Noget gik galt på Apples side. Prøv igen om lidt.` |

Errors clear:
- When user edits either field
- When app foregrounds (subscribe to `AppState`, clear on `'active'` transition) — covers user going to fix something in Apple settings and coming back

**Success path:**
- `saveCredential(userId, email, normalizedPassword)` → secureStorage with `kind: 'valid'`.
- (Binding row already upserted by proxy during `validate`.)
- CalDAV discovery (steps 1-3) runs in background; doesn't block navigation.
- Pop back to Settings — row flipping to `Forbundet` is the confirmation; no toast.

### Settings integration

**New `'icloud'` Connection row** at top of connections list.

```ts
{
  id:     'icloud',
  title:  'iCloud',
  sub:    status === 'connected' ? credentialEmail
        : status === 'expired'   ? 'Adgangskoden er afvist'
        :                          'Mail og kalender',
  status, // 'connected' | 'expired' | 'disconnected'
  logo:   <Cloud /> (lucide-react-native generic cloud icon, NOT Apple's iCloud logo)
}
```

**Trademark note:** Apple's brand guidelines are strict about third-party use of their iCloud logo. Use the generic `Cloud` icon from `lucide-react-native` (already in the app's icon library) plus the text "iCloud" — same pattern other apps use. Do not ship Apple's actual iCloud logo without legal sign-off.

**Tap behaviour** — special-case in dispatch:

```ts
const onRowPress = c.id === 'icloud'
  ? (c.status === 'connected' ? confirmIcloudDisconnect : openIcloudSetup)
  : (c.status === 'connected' ? handleDisconnect       : handleConnect);
```

`openIcloudSetup` navigates to `IcloudSetupScreen`, prefilling email if `c.status === 'expired'`.

`confirmIcloudDisconnect` shows `Alert.alert('Frakobl iCloud?', 'Mails og kalenderbegivenheder fra iCloud forsvinder fra Zolva.', [...])`. On confirm: `clearCredential(userId)` + DELETE binding row (via service-role-callable RPC or proxy endpoint).

**Brief row variants** — existing `morning-brief` `WorkPreference` row:

| Connected providers | Sub-text | Row state |
|---|---|---|
| Google or Microsoft (with or without iCloud) | `Bruger din [Gmail/Outlook] konto` | normal — toggle works |
| iCloud only | `Kræver Gmail eller Outlook for nu` + `Læs mere` link | disabled, label dimmed |

`Læs mere` opens a **bottom sheet** (not `Alert.alert` — wrong UX for explanatory content). Use the existing modal pattern (`src/components/ArchiveModal.tsx` is a recent reference). Content:

> **Hvorfor kræver morgenbrief Gmail eller Outlook?**
>
> Apple tillader ikke den type baggrundsadgang vi har brug for til at sende dig en automatisk morgenbrief. Vi arbejder på en løsning.
>
> Indtil da: forbind Gmail eller Outlook for at få morgenbriefen, eller brug Indbakke-skærmen for at se din iCloud-mail.

Plus a **"Forbind Gmail"** primary CTA at the bottom of the sheet — the conversion goal of explaining this is to turn iCloud-only users into mixed users who get the brief. Tapping the CTA closes the sheet and triggers the standard Google OAuth flow.

### Error UX surfaces — `'expired'` state

**Inbox screen** — banner above the list, between hero and section head:
- Background: `colors.warningSoft`
- Text: `'Apple afviste adgangskoden — iCloud-mails vises ikke. Tryk for at genindtaste.'`
- Tappable → navigates to setup with prefilled email

**Today screen** — identical banner, copy: `'Apple afviste adgangskoden — iCloud-begivenheder vises ikke. Tryk for at genindtaste.'`

**Multi-provider failures stack.** iCloud expired + Google `tryWithRefresh` failure shows two banners. iCloud banner above Google banner (matches connection-row ordering in Settings).

### Re-entry flow

From expired Settings row → tap → setup screen with `prefilledEmail` set. Email field pre-populated and unfocused; password field empty and auto-focused. Validation flow identical to initial setup. Success replaces existing credential entry.

## Out of scope (v1)

- **Sending mail (SMTP)** — drafts, replies. iCloud Mail supports SMTP via `smtp.mail.me.com:587` with the same app-specific password, but read-only v1.
- **Mark-as-read writes** — IMAP UID STORE. Read-only v1. Read state still mirrors *from* IMAP via `\Seen` flag.
- **Folder support beyond INBOX** — Sent, Drafts, Trash, custom folders.
- **CalDAV writes** — creating, updating, deleting calendar events.
- **Free/busy queries.**
- **CalDAV scheduling** — REPLY/REQUEST iTIP responses to invitations.
- **Push notifications for new mail** — no equivalent of IMAP IDLE in this architecture (per-request connections, no persistent state). Server-side polling is the future path.
- **iCloud Contacts (CardDAV)** — different protocol, different surface. Not in v1.
- **Daily brief for iCloud-only users** — see Future section below.
- **Generalising to non-iCloud IMAP/CalDAV servers** (Fastmail, Yahoo, generic providers). Hardcoded to Apple's hosts. Same code shape would generalise but we are not pretending to design for it.
- **Server-side daily-brief integration with iCloud data.** Daily-brief stays Google/Microsoft-only.

## Future: brief support for iCloud-only users

Three options, increasing cost and decreasing UX compromise:

1. **On-device brief generation** — ~1-2 weeks impl. Trust model unchanged. *Degraded UX:* notification body becomes "tap to see brief" rather than the brief content itself. iOS BGAppRefreshTask is opportunistic and may not fire on schedule; Low Power Mode skips BGTasks entirely; force-quit kills BGTasks; Android OEM skins (Samsung, Xiaomi, OnePlus) aggressively kill background tasks. Reliability tail forever, ongoing maintenance every iOS/Expo bump.
   - **Trigger to revisit:** if telemetry shows >20% of new sign-ups are iCloud-only with no Google/Microsoft account.

2. **Server-side credential, plaintext at rest with standard encryption** — ~1 week impl + ongoing security review burden. Requires explicit retraction of the "credential is stored only on the device" claim. Higher blast radius secret at rest in Supabase. Unlocks daily brief AND full server-side polling (push for new mail).
   - **Trigger to revisit:** if (1) ships and reliability complaints are high, OR competitive pressure makes iCloud push notifications a must-have.

3. **Server-side credential, decrypted only inside a hardware enclave** (AWS Nitro Enclave, GCP Confidential Space) — ~4-6 weeks impl plus significant infra overhead (enclave deployment, attestation, key management, re-encryption on rotation). Preserves an honest "Zolva operators cannot read iCloud credentials" claim. DB exfiltration alone does not compromise credentials — requires DB + enclave compromise + key derivation attack.
   - **Trigger to revisit:** only at meaningful scale (10k+ active iCloud users) where engineering cost amortizes and trust posture becomes a real product/marketing differentiator.

The `icloud-credentials.ts` storage interface and the `lastSyncCursor` placeholder field in `IcloudCredentialState` are designed so migration to (2) or (3) doesn't require re-collecting passwords from existing users — only changing where they're stored and how they're decrypted at fetch time.

**Server-side polling (separate but related concern)** would need additionally:
- UIDVALIDITY tracking per folder (invalidates entire local UID-keyed state on change)
- Last-seen UID per folder
- IDLE or polling cadence + backoff
- Push-routing logic for per-user push tokens
- Cache-invalidation back to client when server pulls new mail

None of this is a one-line storage swap. Future work to size honestly when the trigger fires.

## Action items

- **Asset**: `assets/logos/` — generic `Cloud` icon already available via lucide-react-native. No Apple iCloud logo asset needed.
- **Asset (BLOCKING for setup screen v1)**: small inline screenshot of Apple's "App-Specific Passwords" settings page (~30KB PNG). Take ad-hoc if designer is unavailable; do not ship text-only fallback as default.
- **Direct message to Allan on deploy day**: *"iCloud-forbindelsen virker nu for Indbakke og I dag. Morgenbriefen bruger fortsat din Gmail. Forvent at briefen er sparsom indtil iCloud-brief-support er klar eller du bruger Gmail mere."* Don't let him discover it.
- **Localization**: copy strings inline for v1. No i18n yet.
- **`BINDING_HASH_PEPPER` env var** — generate a random 32-byte value, set in Supabase edge function env. Document in deployment runbook.

## Open verification items (handle during implementation, not deferrable to runtime)

- **Step 0 TCP probe** must be deployed and verified before writing the proxy. If it fails, fall back to Fly.io for the proxy host (architecture unchanged).
- **`CALENDAR_TIME_HORIZON`** — read `src/lib/google-calendar.ts`, extract the actual time-range constant into a shared module, apply same range to iCloud CalDAV REPORT.
- **Verify `react-native-tcp-socket` was correctly excluded from the implementation** — we deliberately do NOT use it. If anyone proposes adding it during implementation review, push back: that decision was made deliberately to avoid hand-rolling an IMAP parser and to dodge the unverified new-arch compat issue.
- **VTIMEZONE fallback** must be wired before shipping, not "we'll see if it bites users." Wrong-time events are the kind of bug people uninstall over.
- **Android manifest backup config** — confirm `android.allowBackup=false` (or appropriate `dataExtractionRules` for Android 12+) so iCloud credentials don't sync to Google Drive via Auto Backup. Document iOS Keychain vs Android Keystore behaviour difference in a code comment where the credential is stored.

## Implementation notes (improvements the implementer can adopt without re-review)

These were raised during brainstorm and judged as quality improvements that don't need a redesign — apply if convenient, defer if other work is more pressing.

- **Tighten the wrong-format password check.** The current spec says "warn if the password contains anything other than `[a-z\-\s]` after ≥8 chars." Strictly more correct: after stripping hyphens and whitespace, the result should be exactly 16 chars of `[a-z]`. Anything else triggers the warning. Catches half-pasted passwords and trailing hyphens that the looser check would miss.
- **"Forbind Gmail" CTA in the brief-row bottom sheet** — handle the case where the user's Google connection is in `expired` state (refresh token rejected). Detect the existing connection state in the sheet; render "Genforbind Gmail" + route to re-auth flow if expired, "Forbind Gmail" + standard OAuth if disconnected. Edge case (the brief row only shows when iCloud is the only provider, so Google would have to be manually disconnected for this to fire) but cheap to handle.
- **Privacy bottom-sheet copy honesty.** The `Læs mere` sheet currently says *"Apple tillader ikke den type baggrundsadgang vi har brug for…"* — diplomatic but slightly misleading. The actual reason is that we don't put iCloud credentials on our servers (a Zolva choice), not that Apple forbids it. More honest version: *"Vi sender ikke iCloud-adgangskoder til vores servere, og morgenbrief'en kræver server-side adgang til din mail. Vi arbejder på en løsning."* Slightly longer, more truthful — pick whichever the founder prefers when shipping.
- **`BINDING_HASH_PEPPER` rotation runbook** — not now, but if the pepper ever needs to rotate (suspected leak), every binding row becomes garbage and every active iCloud user re-auths on their next list-inbox call. Worth documenting the procedure in the deployment runbook even if you never use it.
