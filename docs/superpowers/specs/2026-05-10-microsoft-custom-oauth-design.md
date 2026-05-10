# Microsoft OAuth — Custom Connector Flow (Bypass gotrue)

**Status:** Approved 2026-05-10
**Author:** Albert (with Claude)
**Triggered by:** `kontakt@lkag.dk` — 11 failed Outlook connect attempts on 2026-05-10. Root cause: gotrue's azure provider requires Microsoft Graph `/me` to return a `mail` claim; lkag.dk tenant returns none, so gotrue 500s before any token is persisted. Affects every Microsoft account whose tenant suppresses the email claim or whose AAD `mail` attribute is null. See `feedback_oauth_debugging.md` for the error signature.

## Problem

Today every Microsoft OAuth flow in the app routes through Supabase's gotrue layer (`supabase.auth.signInWithOAuth({provider: 'azure'})` or `supabase.auth.linkIdentity({provider: 'azure'})`). Gotrue's azure provider mandates a non-empty email claim from `graph.microsoft.com/v1.0/me`. When that claim is missing, gotrue throws `500: Error getting user email from external provider` and refuses to persist anything — no `auth.identities` row, no Supabase session change, and the app never gets a refresh token to put in `user_oauth_tokens`. Recovery is impossible until the user's AAD account exposes a mail attribute, which is outside our control.

This is a known upstream limitation in gotrue's azure provider — there is no fallback to `userPrincipalName`. We can't fix it inside Supabase.

## Goal

Replace the gotrue-mediated Microsoft OAuth flow with a custom flow that talks to `login.microsoftonline.com` directly. Skip `/me` entirely. Land the resulting refresh token in `user_oauth_tokens` ourselves so the existing `refresh-provider-token` edge function and all downstream features (mail polling, calendar reading, send/draft, OneDrive) keep working unchanged.

## Non-goals

- **Microsoft sign-in / sign-up via the LoginCard.** Microsoft is connector-only in the codebase today (verified across `LoginCard`, `OnboardingFlowScreen`, `SettingsScreen`, `InboxScreen`, `App.tsx`, `hooks.ts`, `CalendarPickerSheet`). All existing `signInWithMicrosoft` invocations happen after the user already has a Supabase session. We do not add a Microsoft sign-up path.
- **Active migration of existing gotrue-linked Microsoft identities.** Old-flow users (e.g., `986d2225-…@complira.io`) keep working off their existing `user_oauth_tokens` row. The leftover `auth.identities` row sits inert. We never delete it.
- **Refactoring Google OAuth.** Google still goes through `runOAuth` and has its own quirks (`unlinkIdentity` revokes Supabase refresh tokens; `signInWithOAuth` on already-linked identity drops `provider_refresh_token`). Merging the two is premature abstraction.
- **Microsoft sign-out / token revocation at Microsoft.** Microsoft has no clean revocation endpoint for OAuth refresh tokens. Disconnect deletes our row and lets the token expire naturally — same behavior as today.

## Architecture

```
                            ┌────────────────────────┐
   client (RN app)          │  login.microsoftonline │
                            │       .com             │
   ┌──────────────────┐     └────────┬───────────────┘
   │ microsoft-oauth  │              │
   │      .ts         │──── 1. authorize?...PKCE...&redirect_uri=zolva://
   │                  │              │
   │  - PKCE gen      │     2. user consents
   │  - openAuthSession              │
   │  - parse code    │◄─── 3. 302 zolva://oauth/microsoft/callback?code=...
   │  - POST to fn    │              │
   └────────┬─────────┘              │
            │ 4. invoke              │
            ▼                        │
   ┌────────────────────┐            │
   │  edge fn           │            │
   │  microsoft-oauth-  │── 5. POST /oauth2/v2.0/token (with secret)
   │  exchange          │            │
   │                    │◄── 6. { access_token, refresh_token }
   │  - verifyJwt       │
   │  - exchange        │     ┌──────────────────┐
   │  - upsert tokens   │────►│ user_oauth_tokens│
   │  - upsert watcher  │     │ mail_watchers    │
   └────────┬───────────┘     └──────────────────┘
            │ 7. { access_token, expires_in }
            ▼
   client persists access_token to SecureStore + broadcasts to UI
```

Gotrue is bypassed entirely. The Azure app registration adds `zolva://oauth/microsoft/callback` as a Mobile-and-desktop platform redirect URI; the existing Web platform redirect for gotrue stays untouched. Same `client_id`, same `client_secret`, two redirect URIs.

## Components

### New

| File | Purpose |
|---|---|
| `src/lib/microsoft-oauth.ts` | Client OAuth driver. Generates PKCE, opens `WebBrowser.openAuthSessionAsync`, parses the deep-link callback, posts to the exchange edge fn, broadcasts the access token. Replaces the Microsoft branch of `runOAuth`. |
| `src/lib/microsoft-oauth.test.ts` | Unit tests for PKCE generation, callback parsing, state validation, verifier-Map lifecycle. |
| `supabase/functions/microsoft-oauth-exchange/index.ts` | Edge function. Verifies user JWT, POSTs to Microsoft `/oauth2/v2.0/token` with `client_secret` + `code_verifier`, upserts `user_oauth_tokens` and `mail_watchers` via service role, returns `{access_token, expires_in}`. |
| `supabase/functions/microsoft-oauth-exchange/index.test.ts` | Edge function tests with mocked Microsoft endpoint. |
| `src/lib/hooks.ts` (addition) | New `useMicrosoftLinked()` hook that reads `user_oauth_tokens` row presence rather than `auth.identities`. |

### Changed

| File | Change |
|---|---|
| `src/lib/auth.ts` | `signInWithMicrosoft` becomes a one-line wrapper around `runMicrosoftOAuth` from `src/lib/microsoft-oauth.ts`. Microsoft branch of `runOAuth` is deleted (Google still uses it). `MICROSOFT_SCOPES` constant moves to `microsoft-oauth.ts`. |
| `src/lib/auth.ts` `disconnectProvider('microsoft')` | The `unlinkIdentity` call is wrapped in try/catch so it tolerates the "single_identity_not_deletable" 422 (new-flow users have no Microsoft identity to unlink) and any "not found" condition. Token deletion proceeds regardless. |
| `src/screens/SettingsScreen.tsx` | `microsoftLinked = !!authUser?.identities?.some(i => i.provider === 'azure')` → `microsoftLinked = useMicrosoftLinked()`. |
| `src/screens/OnboardingFlowScreen.tsx` | Same swap (line 1104). |
| `src/lib/hooks.ts` `useConnections` | Same swap (line 2771). |
| `App.tsx` | Same swap if needed (line 116). |
| `src/components/CalendarPickerSheet.tsx` | Same swap if needed. |

### Unchanged

- `supabase/functions/refresh-provider-token/` — already operates on `user_oauth_tokens.refresh_token` regardless of provenance. No change.
- `supabase/functions/poll-mail/`, `imap-proxy`, `chat-jobs`, calendar aggregator, all Graph callers — use the access token from `microsoftAccessToken` broadcast, source-agnostic.
- `microsoft-admin-consent-link` and `microsoft-admin-consent-callback` edge functions — still relevant when a tenant returns AADSTS90094 / consent_required during the new flow.
- All Google OAuth code.

## Data flow (happy path)

1. User taps "Forbind Outlook" (Settings, Onboarding step 06, or Inbox re-auth banner).
2. `runMicrosoftOAuth` generates a `code_verifier` (43–128 char base64url random) and `code_challenge = base64url(sha256(verifier))`. Generates a `state` UUID. Stores `{state → verifier}` in a module-scoped `Map`.
3. Builds authURL:
   ```
   https://login.microsoftonline.com/common/oauth2/v2.0/authorize?
     client_id=<MICROSOFT_CLIENT_ID>
     &response_type=code
     &redirect_uri=zolva://oauth/microsoft/callback
     &scope=Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.Read offline_access openid
     &code_challenge=<challenge>&code_challenge_method=S256
     &state=<state>
     &prompt=consent
   ```
4. `WebBrowser.openAuthSessionAsync(authURL, "zolva://oauth/microsoft/callback")`.
5. User authenticates with Microsoft and consents. Microsoft 302s to `zolva://oauth/microsoft/callback?code=...&state=...`.
6. Client parses `code` and `state`. Looks up the verifier by `state`; verifies state was issued by us; deletes the entry from the Map.
7. Client calls `supabase.functions.invoke('microsoft-oauth-exchange', { body: { code, code_verifier, redirect_uri: 'zolva://oauth/microsoft/callback', mail_watcher_enabled: getNotificationSettings().newMail } })`. (Same source the existing `bootstrapMailWatcher` reads — preserves user intent.)
8. Edge function: `verifyJwt(req)` → `uid`. Returns 401 if missing/invalid.
9. Edge function POSTs to `https://login.microsoftonline.com/common/oauth2/v2.0/token`:
   ```
   client_id=<MICROSOFT_CLIENT_ID>
   client_secret=<MICROSOFT_CLIENT_SECRET>
   code=<code>
   code_verifier=<code_verifier>
   redirect_uri=<redirect_uri>
   grant_type=authorization_code
   ```
10. On `200 { access_token, refresh_token, expires_in, ... }`:
    - `upsert public.user_oauth_tokens(user_id, provider='microsoft', refresh_token, updated_at=now())` (service role, on conflict (user_id, provider))
    - `upsert public.mail_watchers(user_id, provider='microsoft', enabled=<from request>, updated_at=now())`
    - Return `200 { access_token, expires_in }` to client.
11. Client `secureStorage.setItem(tokenKey('microsoft', uid), access_token)` and `broadcastMicrosoft(access_token)`.

## Azure app registration delta

| Setting | Today | Change |
|---|---|---|
| Web platform redirect URIs | `https://auth.zolva.io/auth/v1/callback` | none |
| Mobile and desktop apps platform redirect URIs | none | **add** `zolva://oauth/microsoft/callback` |
| Client secret | exists | none (reused by new edge fn) |
| API permissions | Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, Files.Read, offline_access, User.Read, openid, email, profile | none — keep email/profile/User.Read in to avoid forcing existing users to re-consent |
| Allow public client flows | off | unchanged — confidential client mode stays |

PKCE-with-secret on a confidential client is supported by Azure AD since 2022.

## Edge function env vars

Reuses existing secrets:
- `MICROSOFT_CLIENT_ID` (already set, used by `refresh-provider-token`)
- `MICROSOFT_CLIENT_SECRET` (already set)

No new secrets to provision.

## "Linked" signal change

`useMicrosoftLinked()` reads `user_oauth_tokens` row presence:

```ts
export function useMicrosoftLinked(): boolean {
  const userId = useUserId();
  const [linked, setLinked] = useState<boolean>(false);
  useEffect(() => {
    if (!userId) { setLinked(false); return; }
    let cancelled = false;
    const check = async () => {
      const { data } = await supabase
        .from('user_oauth_tokens')
        .select('user_id', { head: true, count: 'exact' })
        .eq('user_id', userId)
        .eq('provider', 'microsoft');
      if (!cancelled) setLinked((data as unknown as { count?: number } | null)?.count ? true : false);
    };
    void check();
    // refetch on app focus + on broadcast (broadcast fires from runMicrosoftOAuth + disconnectProvider)
    const sub = subscribeMicrosoftToken(() => { void check(); });
    return () => { cancelled = true; sub(); };
  }, [userId]);
  return linked;
}
```

(Final implementation may use the existing realtime subscription pattern instead of polling — `microsoftAccessToken` broadcasts already fire on every connect/disconnect.)

This works for both old-flow users (their `user_oauth_tokens` row was written by `persistProviderRefreshToken` after the old `runOAuth`) and new-flow users (written by the new edge function). Residual `auth.identities` rows from old-flow users have no functional role and are ignored.

## Error handling

| Failure | Where | Result |
|---|---|---|
| `WebBrowser` returns `cancel` | client | `{ cancelled: true }`; caller silently re-renders |
| Microsoft `?error=...&error_description=...` in redirect | client `parseCallback` | surface as `ProviderAuthError`. `detectAdminConsentRequired` keeps catching `AADSTS\d+` / `consent_required` / `interaction_required` and routing to MicrosoftAdminConsentScreen — no change |
| State mismatch | client | `ProviderAuthError('OAuth state mismatch')` |
| Edge fn invoked without valid Supabase JWT | edge fn | `401` |
| Microsoft `/token` 4xx | edge fn | bubble `error_description` to client; `translateProviderError` already handles AADSTS strings |
| Microsoft 200 with no `refresh_token` | edge fn | `502 'Microsoft did not return a refresh token — try reconnecting'` (means `offline_access` not granted) |
| `user_oauth_tokens` upsert fails | edge fn | `500` with sanitized error |
| Network failure invoking edge fn | client | falls through to `translateProviderError`'s network branch |
| App killed mid-flow (verifier Map empty on callback) | client | `ProviderAuthError('Forbindelsen blev afbrudt — prøv igen')` |
| `disconnectProvider('microsoft')` on user with leftover gotrue identity | `unlinkIdentity` succeeds; rest of teardown unchanged |
| `disconnectProvider('microsoft')` on user with no gotrue identity (new-flow) | `unlinkIdentity` 422 caught + ignored; token row deleted |
| Anders's original "Error getting user email" | not reachable — gotrue isn't in the path |

The recently-shipped `external provider` branch in `translateProviderError` (commit `edfee2d`) stays in place as a defense-in-depth message. After ~2 weeks of new flow being live, if the gateway logs show no more `/callback` 500s with that error string, the branch can be removed. Optional cleanup, not required.

## Testing

**Unit (`src/lib/microsoft-oauth.test.ts`):**
- PKCE: verifier length 43–128 chars, base64url alphabet only
- Challenge equals `base64url(sha256(verifier))` byte-for-byte
- `parseMicrosoftCallback` extracts code/state from query string and from URL fragment
- `parseMicrosoftCallback` extracts `error_description` and `error` correctly
- State mismatch returns `ProviderAuthError`
- Verifier `Map` entry deleted after consumption (no leak)

**Edge function (`supabase/functions/microsoft-oauth-exchange/index.test.ts`):**
- Missing JWT → 401
- Malformed body (no `code` or no `code_verifier`) → 400
- Mock Microsoft `/token` returning 4xx with `error_description` → 4xx with `error_description` bubbled
- Mock Microsoft 200 with no `refresh_token` → 502
- Mock Microsoft 200 with `refresh_token` → upsert into both tables, return access_token
- Service-role write succeeds (no RLS interference)

**Manual smoke (the actual confidence path):**
1. **Anders's class:** test Microsoft account on a `.onmicrosoft.com` UPN-only tenant where `mail` attribute is null. Tap "Forbind Outlook" → expect success, `user_oauth_tokens` row, inbox loads.
2. **Happy path:** own Microsoft account, full disconnect → reconnect → mail polls.
3. **Cancelled consent:** back out of Microsoft consent screen → no token, no error dialog, button returns to "Forbind".
4. **Admin-consent tenant:** Microsoft account on tenant with `User.Read` admin-consent block → MicrosoftAdminConsentScreen opens (existing detector still catches the AADSTS code).
5. **Old-flow regression:** sign in as the complira user (or equivalent), confirm mail polls (refresh-provider-token uses existing token row), confirm `useMicrosoftLinked()` reports `true`.
6. **Disconnect old-flow user:** verify `unlinkIdentity` 422 swallowed; token row deleted; UI flips to "Forbind".
7. **Reconnect old-flow user after disconnect:** goes through new flow → no new gotrue identity created → still works → `useMicrosoftLinked()` true again.

## Rollout

1. Add `zolva://oauth/microsoft/callback` to Azure app registration (no code shipped — safe).
2. Deploy `microsoft-oauth-exchange` edge function with `--no-verify-jwt` flag (per Supabase ES256 JWT memory).
3. Merge client change to main.
4. EAS OTA to production channel.
5. Monitor:
   - new auth-log entries to `microsoft-oauth-exchange` should appear; new `user_oauth_tokens` rows for Microsoft look identical in shape to old ones
   - gotrue `/callback` 500s with "Error getting user email" should drop to ~zero (only old clients without OTA pickup will still hit them)
   - Sentry / dev logs for the new error paths
6. After ~2 weeks: if the `external provider` branch in `translateProviderError` is no longer firing, remove it. Optional.

## Out of scope

- Microsoft sign-up path (Microsoft remains connector-only).
- Active migration of existing gotrue identities (left inert; harmless).
- Refactoring `runOAuth` to share code between Google and Microsoft (premature; Google has its own quirks).
- Token revocation at Microsoft on disconnect (no clean endpoint exists).
- Replacing Google with a similar custom flow (Google's `signInWithOAuth` works correctly today; no driver to change it).
