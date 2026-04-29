-- supabase/migrations/20260429140000_icloud_calendar_creds.sql
--
-- Server-side encrypted storage for iCloud calendar (CalDAV) credentials.
-- Backs the icloud-creds-link / icloud-creds-revoke edge functions, and is
-- read by widget-action when the voice path needs to write to iCloud.
--
-- Why server-side at all:
--   The voice AppIntent runs without the app being open. The user is not
--   present to re-supply credentials. This mirrors how user_oauth_tokens
--   already stores Google/Microsoft refresh tokens server-side.
--
-- Why NOT shared with imap-proxy yet:
--   imap-proxy is a passthrough — client ships creds in every body, server
--   only stores an HMAC binding. Voice path needs the actual creds. Two
--   patterns coexist intentionally for v2; unification tracked in
--   docs/decisions/2026-04-29-imap-proxy-cred-unification.md.
--
-- Threat model (be honest):
--   pgcrypto with a key held by the edge function protects against:
--     - Database backup leaks (encrypted blob is gibberish without key).
--     - Read-only Postgres compromise (e.g. SQL-injection-via-RLS-bypass).
--   pgcrypto does NOT protect against:
--     - Compromise of the edge function runtime — the function has the key
--       by definition and decrypts on every read.
--     - Compromise of Supabase platform secrets storage.
--     - Compromise of the Supabase service role key.
--   This is the same threat model as user_oauth_tokens. For real defense
--   in depth, the upgrade is Supabase Vault with key rotation, not
--   pgcrypto. v2 uses pgcrypto for consistency with existing patterns.
--
-- Reauth gate (icloud-creds-link):
--   The edge function checks JWT iat-recency (≤5min) + per-user rate limit
--   to gate writes to this table. iat-recency is "recent session activity,"
--   not "fresh password" — Supabase's session refresh produces a new iat,
--   so a long-lived session with auto-refresh always satisfies the check.
--   Real step-up auth would require a separate challenge endpoint. v2
--   accepts this limitation; revisit if the threat model changes.
--
-- Wire format (cleartext) for the encrypted_blob, before encryption:
--   {
--     "email": "user@example.com",
--     "password": "abcd-efgh-ijkl-mnop",         // app-specific, not Apple ID
--     "calendar_home_url": "https://p123-caldav.icloud.com/12345/calendars/"
--   }
--   JSON-encoded UTF-8 bytes, fed to pgp_sym_encrypt with the
--   ICLOUD_CREDS_ENCRYPTION_KEY edge-function secret.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE public.user_icloud_calendar_creds (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_blob bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_icloud_calendar_creds ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (edge functions) reads/writes.
-- Clients calling via anon/authenticated keys see zero rows.

COMMENT ON TABLE public.user_icloud_calendar_creds IS
  'iCloud CalDAV credentials, pgcrypto-encrypted. Read by widget-action on voice writes; written by icloud-creds-link; deleted by icloud-creds-revoke. See migration header for threat model.';

-- Audit log for link / revoke events. Never logs the payload.
CREATE TABLE public.icloud_calendar_creds_audit (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event     text NOT NULL CHECK (event IN ('link', 'revoke', 'reauth_required', 'rate_limited')),
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX icloud_calendar_creds_audit_user_called
  ON public.icloud_calendar_creds_audit (user_id, called_at DESC);

ALTER TABLE public.icloud_calendar_creds_audit ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only.

COMMENT ON TABLE public.icloud_calendar_creds_audit IS
  'Audit log for iCloud creds link/revoke attempts. Used for rate limit window checks and incident review. Never contains the payload (email/password) or any HMAC of it.';

-- Updated-at trigger so we know when the latest cred replacement happened
-- without depending on the audit log alone.
CREATE OR REPLACE FUNCTION public.set_user_icloud_calendar_creds_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_user_icloud_calendar_creds_updated_at
  BEFORE UPDATE ON public.user_icloud_calendar_creds
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_icloud_calendar_creds_updated_at();
