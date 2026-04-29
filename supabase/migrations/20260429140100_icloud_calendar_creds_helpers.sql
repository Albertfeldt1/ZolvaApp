-- supabase/migrations/20260429140100_icloud_calendar_creds_helpers.sql
--
-- pgcrypto wrapper functions for user_icloud_calendar_creds.
-- Callable from edge functions via supabase-js .rpc(). The encryption key
-- is passed as a parameter at call time, never stored in the function
-- definition — same threat model as the migration that created the table.

CREATE OR REPLACE FUNCTION public.encrypt_icloud_creds(
  plaintext_json text,
  encryption_key text
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT pgp_sym_encrypt(plaintext_json, encryption_key);
$$;

CREATE OR REPLACE FUNCTION public.decrypt_icloud_creds(
  blob bytea,
  encryption_key text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT pgp_sym_decrypt(blob, encryption_key);
$$;

REVOKE ALL ON FUNCTION public.encrypt_icloud_creds(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrypt_icloud_creds(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.encrypt_icloud_creds(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_icloud_creds(bytea, text) TO service_role;

COMMENT ON FUNCTION public.encrypt_icloud_creds(text, text) IS
  'Wraps pgp_sym_encrypt. Service-role-only. Key passed at call time, never stored.';
COMMENT ON FUNCTION public.decrypt_icloud_creds(bytea, text) IS
  'Wraps pgp_sym_decrypt. Service-role-only. Key passed at call time, never stored.';
