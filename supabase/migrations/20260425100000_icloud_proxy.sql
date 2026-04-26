-- supabase/migrations/20260425100000_icloud_proxy.sql
--
-- Tables backing the imap-proxy edge function.
--
-- icloud_credential_bindings: user_id → HMAC of (email + ':' + password).
-- Established on the user's first successful list-inbox; verified on every
-- subsequent list-inbox. Stops a JWT from being used to relay arbitrary
-- iCloud credentials through the proxy (credential stuffing).
--
-- icloud_proxy_calls: per-call audit + sliding-window rate limiting.
--
-- Both tables are service-role only (the edge function is the only writer).
-- RLS is enabled with no policies: client cannot read.

CREATE TABLE icloud_credential_bindings (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_hash   text NOT NULL,
  last_validated_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE icloud_proxy_calls (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  op        text NOT NULL CHECK (op IN ('validate', 'list-inbox')),
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX icloud_proxy_calls_user_called
  ON icloud_proxy_calls (user_id, called_at DESC);

ALTER TABLE icloud_credential_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE icloud_proxy_calls         ENABLE ROW LEVEL SECURITY;

-- Daily cleanup. Bindings: 90 days because app-specific passwords don't
-- expire on Apple's side and refresh-on-every-list-inbox keeps active rows
-- alive. Proxy calls: 30 days for abuse investigation.
--
-- Idempotency: pg_cron 1.4+ updates an existing job when scheduling with the
-- same jobname, but earlier versions create duplicates. Defense-in-depth via
-- explicit unschedule, so this section is safe to re-run regardless of
-- pg_cron version.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'icloud-binding-sweep') THEN
    PERFORM cron.unschedule('icloud-binding-sweep');
  END IF;
END
$$;

SELECT cron.schedule(
  'icloud-binding-sweep',
  '0 4 * * *',
  $$
  DELETE FROM icloud_credential_bindings
    WHERE last_validated_at < now() - interval '90 days';
  DELETE FROM icloud_proxy_calls
    WHERE called_at < now() - interval '30 days';
  $$
);
