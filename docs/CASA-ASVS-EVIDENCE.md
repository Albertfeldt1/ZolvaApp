# CASA Tier 2 — ASVS control-mapping evidence

Purpose: the document handed to the CASA assessor. For each relevant OWASP ASVS
section, it states the control, where it lives in the code, and verification
status. Scope = the Zolva app + Supabase backend that handles Google user data
(Gmail `gmail.readonly`/send, Calendar, Drive `drive.file`).

Project ref: `sjkhfkatmeqtsrysixop` · iOS bundle `io.zolva.app` · Google Cloud
project (OAuth): `quixotic-access-454807-t8`.

Status legend: ✅ in place · 🔶 in place, pending edge-function-pass confirmation ·
⚠️ open item · ☐ owner/config action (outside codebase).

---

## V1 — Architecture & data flow

- **Trust boundaries.** Mobile client (RN/Expo) talks to Postgres only with the
  **public anon key**; all privileged work runs in Supabase edge functions with
  the `sb_secret_…` service role. Google user data (mail/calendar/drive) is
  fetched server-side in edge functions, never with client-held provider
  secrets. ✅
- **OAuth broker.** Supabase gotrue brokers Google/Microsoft OAuth; provider
  client secrets live in Supabase + edge env, never in the app bundle. Refresh
  tokens stored in `user_oauth_tokens`, refreshed server-side (`_shared/oauth.ts`). ✅

## V2 — Authentication

- **User auth** via Supabase gotrue: Sign in with Apple, Google, Microsoft, and
  email/password. Microsoft uses **PKCE** (`_shared/oauth.ts` `exchangeAuthorizationCode`). ✅
- **Edge-function authN.** User-facing functions re-validate the caller's JWT
  themselves (ES256; deployed `--no-verify-jwt` so the gateway doesn't pre-empt
  it — see `project_supabase_asymmetric_jwt`). 🔶 (pass confirms every function)
- **Token re-issue.** Provider refresh tokens persisted via SECURITY DEFINER RPC
  `persist_oauth_token` keyed on `auth.uid()` (migration `20260612120000`), so a
  caller can only write its own row. ✅

## V3 — Session management

- Supabase gotrue sessions; client tokens stored in the iOS **Keychain** via
  `expo-secure-store` (`src/lib/secure-storage.ts` → `supabaseStorageAdapter`),
  not AsyncStorage/plaintext. `autoRefreshToken`, PKCE flow (`src/lib/supabase.ts`). ✅
- `unlinkIdentity` revokes session refresh tokens on full logout; sole-identity
  logout signs out completely (`logOutProvider`, `src/lib/auth.ts`). ✅

## V4 — Access control

- **RLS owner-scoped** on all user tables (`auth.uid() = user_id`); P0 dashboard
  table RLS verified clean 2026-06-07 (`project_security_hardening`). ✅
- **IDOR** closed via atomic `UPDATE … WHERE id=? AND user_id=caller`. 🔶 (pass)
- **Secret column lockdown:** client cannot SELECT `refresh_token`
  (migration `20260607161000`); writes go through the SECURITY DEFINER RPC. ✅

## V5 — Validation, sanitization, encoding (injection)

- **SQL injection:** no raw SQL on the client; PostgREST/parameterized + RLS. 🔶 (pass)
- **SSRF:** `imap-proxy` / `drive-picker` fetch external hosts — must be
  allowlisted/validated. 🔶 (pass — priority)
- **XSS:** inbound email rendered as **plain text** (no HTML); outbound signature
  HTML sanitized (`src/lib/mail-signature/sanitize.ts`). ✅
- **Prompt injection:** native input rail (taint at `get_body`) + output
  moderation rail, fail-safe to propose (`_shared/guardrails`, `project_agent_guardrails`). ✅
- **LLM proxy:** model allowlist + `max_tokens` clamp (`_shared/model-guard.ts`). ✅

## V6 — Stored cryptography & secrets

- No server secrets in repo or app bundle (verified by sweep). Anon key in
  Info.plist/app.json is **public by design**; RLS is the control. ✅
- Provider tokens at rest in Postgres, client-unreadable; device tokens in Keychain. ✅

## V7 — Error handling & logging

- No token/secret values logged (verified by sweep — only event messages). 🔶 (pass)
- Webhook + guardrails **fail-closed**. ✅

## V8 — Data protection (incl. retention/deletion)

- **Account deletion:** in-app `DeleteAccountScreen` → `delete-account` edge fn
  (cascades user data + revokes provider grants). ✅
- **Data minimization:** Drive scoped to `drive.file` (per-file, not full-drive);
  `gmail.modify` intentionally absent. ✅
- Retention policy for cached mail/calendar — ⚠️ document explicitly for assessor.

## V9 — Communications

- TLS everywhere; iOS ATS enabled (`NSAllowsArbitraryLoads = false`); no cleartext
  in release builds (debug-only `usesCleartextTraffic`); outbound calls https. ✅

## V10 — Malicious code

- No analytics / PII-exfil SDKs in the bundle (`project_security_hardening`). ✅

## V11 — Business logic / anti-automation

- Rate limiting: `_shared/abuse-limits.ts` (500 req/day), `_shared/chat-limits.ts`
  (weekly cap). ⚠️ Known gaps: chat cap bypass via direct `claude-proxy`, and
  `agent-tick` self-trigger (hardening doc 2.6/2.7) — remediation pending.

## V12 — Files & resources

- Drive picker WebView host-restricted; photo-library access gated by usage string. 🔶 (pass)

## V13 — API & web service

- Edge functions re-validate JWT; **RevenueCat webhook** timing-safe + fail-closed
  + FK-protected (`revenuecat-webhook`). 🔶 (pass confirms per-function)

## V14 — Configuration

- **Dependency CVEs:** `npm audit` flags 1 critical + 3 high — all **Expo
  build-time tooling** (`shell-quote`, `@xmldom/xmldom`, `@expo/plist`,
  `@bacons/xcode`), absent from the runtime artifact. ⚠️ remediate or document.
- CORS / model allowlist configured. 🔶 (pass)

---

## Owner / config actions (outside codebase)

- ☐ Drive Picker GCP API key: HTTP-referrer + API restriction (hardening 2.3b).
- ☐ Android `zolva://` → HTTPS App Link (`assetlinks.json`) — PKCE mitigates meanwhile.
- ☐ Confirm legacy HS256 service-role JWT remains dead (verified 2026-06-07).

## Edge-function security pass — findings (2026-06-13)

4-way parallel ASVS review of all 31 edge functions + shared modules. **No Critical
findings.** Posture confirmed strong: every user-facing function re-validates the
JWT (`getUser` or ES256 JWKS) and scopes DB access to the token-derived user id;
the one public endpoint (admin-consent callback) gates on HMAC-signed state with
constant-time verify; `imap-proxy` has **no SSRF** (hardcoded hosts, TLS enforced);
agent mutations use atomic ownership claims; no provider token/secret is returned
to the client or logged.

| # | Sev | Function | Location | Issue | Status |
|---|-----|----------|----------|-------|--------|
| 1 | **High** | delete-account | `delete-account/index.ts:137` + `purge_tenant_data` | `claude_usage_buckets` has no FK → not cascade-deleted and not in the explicit table list → user PII survives account deletion (GDPR/V8) | ☐ fix |
| 2 | **Med** | widget-action | `widget-action/jwt.ts:17-33` | `jwtVerify` checks signature/expiry but not `aud`/`iss` — any token from the same project is accepted | ☐ fix |
| 3 | **Med** | admin-consent-callback | `microsoft-admin-consent-callback/index.ts:184-207` | `tenant_id` written from the MS query param, not the signed state → consent-record IDOR | ☐ fix |
| 4 | **Med** | admin-consent | `_shared/admin-consent.ts:15` | Signed-state TTL 30 days, no single-use nonce → long replay window | ☐ fix |
| 5 | **Med** | claude-proxy | `claude-proxy/index.ts:178` | `temperature` forwarded to Anthropic unvalidated | ☐ fix |
| 6 | **Med** | claude-proxy / chat-run | `claude-proxy:179`, `chat-run:235` | `tools` array forwarded verbatim, unbounded size | ☐ fix |
| 7 | Low | claude-proxy | (whole) | Weekly chat-cap bypassable by calling claude-proxy directly (known, doc 2.6) | ☐ |
| 8 | Low | daily-brief | `daily-brief/index.ts:97-103` | Debug log emits cron-secret length/match oracle | ☐ fix |
| 9 | Low | onboarding-backfill-start | `index.ts:172` | `force:true` re-run is an unmetered user-triggered cost amplifier | ☐ |
| 10 | Low | widget-action | `index.ts:103` | `prompt` length unbounded before Claude | ☐ fix |
| 11 | Low | microsoft-oauth-exchange / refresh-provider-token | resp bodies | Raw provider error text returned to client | ☐ fix |
| 12 | Low | reminders-fire / fact-decay-warning / poll-mail / daily-brief | cron checks | `x-cron-secret` compared non-timing-safe (server-to-server, low) | ☐ |
| 13 | Low | delete-account | `consent_events` | `ON DELETE SET NULL` retains de-identified row — confirm non-identifying | ☐ confirm |
| — | Info | icloud-creds, widget-action, others | — | Accepted/documented (TOCTOU rate-limit, MS no-revoke endpoint, RC header-secret scheme) | n/a |

### Remediation log (2026-06-14)

**Fixed:**
- #1 High — `delete-account` now explicitly deletes `claude_usage_buckets` (the only user table with no FK cascade; verified against `pg_constraint` — all others cascade via auth.users/profiles). `purge_tenant_data` already covered it.
- #2 Med — `widget-action/jwt.ts` now verifies `issuer` (canonical supabase.co URL, confirmed via openid-config) + `audience: 'authenticated'`.
- #3 Med — admin-consent `tenant_id` bound into the signed state; callback rejects a mismatched `tenant` param ('common'/legacy links handled).
- #4 Med — admin-consent state TTL 30d → 7d.
- #5/#6 Med — `claude-proxy` clamps `temperature` to [0,1] and bounds `tools` (≤64/≤32KB, 400 on excess); `chat-run` bounds `tools` (drops oversized, no orphan job).
- #8 Low — removed `daily-brief` cron-secret debug log.
- #10 Low — `widget-action` prompt truncated to 2000 chars.
- #11 Low — `microsoft-oauth-exchange` (incl. persist-failed path) + `refresh-provider-token` no longer return raw provider/DB error text to the client (kept in server logs).

**Deferred (documented, low risk):**
- #7 chat-cap bypass via direct `claude-proxy` — billing-integrity, not data security; needs care not to throttle legit tool-continuation rounds. Bounded today by the model allowlist + 8192 max-tokens clamp.
- #9 backfill `force` re-run — user's own cost/data, JWT-gated; rate-limit is a nicety.
- #12 non-timing-safe `x-cron-secret` compares — server-to-server header; no remotely-measurable timing channel. Not worth churning 8 cron functions.
- #13 `consent_events` `ON DELETE SET NULL` — confirmed de-identified audit retention; acceptable.

Verification: no new `deno check` type errors (3 pre-existing lib-type errors unchanged); affected Deno tests pass (5 pre-existing widget-action failures are a broken JWT-bypass harness, present at HEAD). ⚠️ widget JWT iss/aud not unit-testable via that harness → smoke-test a widget action after deploy.

### Confirmed controls (assessor evidence — verbatim from the pass)
- **AuthN:** all user-facing fns re-validate JWT (`auth.getUser` or `jose` ES256 JWKS); cron fns require `x-cron-secret` + fail-closed on missing env; webhook uses timing-safe fail-closed shared secret.
- **Access control / IDOR:** no function acts on a client-supplied `user_id`; agent mutations use atomic `UPDATE … WHERE id=? AND user_id=caller AND status=?`; `agent_revert_action` is SECURITY DEFINER, execute granted to service_role only.
- **SSRF (V5):** `imap-proxy` connects only to hardcoded `imap/smtp.mail.me.com` with `secure:true` (no host param, no plaintext path); all LLM egress is hardcoded `api.anthropic.com`; provider hosts hardcoded.
- **Injection:** model allowlist + `max_tokens` clamp (`model-guard.ts`); inbound mail rendered plain text; outbound signature HTML sanitized; prompt-injection rails fail-safe to propose; IMAP SEARCH uses structured args.
- **Secrets/tokens (V6/V8):** all secrets from `Deno.env`; refresh_token/client_secret never returned to client or logged; iCloud app-password HMAC-peppered at rest + pgcrypto-encrypted; device tokens in Keychain.
- **Data deletion:** `delete-account` cascades ~30 user tables (verified against live `pg_constraint`) + revokes Google grant (MS has no revoke endpoint — token deleted). One gap: finding #1.
- **Entitlement integrity:** tier written only by the server-trusted RevenueCat webhook; read paths fail-closed to `free`; no client self-grant path.
