// supabase/functions/_shared/icloud-creds.ts
//
// Shared loader for the encrypted iCloud CalDAV credentials stored in
// user_icloud_calendar_creds. Decrypts via the pgcrypto helper using the
// edge-function secret ICLOUD_CREDS_ENCRYPTION_KEY.
//
// Used by:
//   - widget-action/icloud-write.ts  → voice-path event writes
//   - _shared/icloud-calendar.ts     → daily-brief event reads
//
// The wire format inside the encrypted blob is documented in
// migrations/20260429140000_icloud_calendar_creds.sql.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type IcloudCredsBlob = {
  email: string;
  password: string;
  calendar_home_url: string;
};

export async function loadIcloudCreds(
  client: SupabaseClient,
  userId: string,
  encryptionKey: string,
): Promise<IcloudCredsBlob | null> {
  const { data: row, error } = await client
    .from('user_icloud_calendar_creds')
    .select('encrypted_blob')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[icloud-creds] row read failed:', error.message);
    return null;
  }
  if (!row) return null;

  const { data: plaintext, error: decErr } = await client.rpc('decrypt_icloud_creds', {
    blob: row.encrypted_blob,
    encryption_key: encryptionKey,
  });
  if (decErr || typeof plaintext !== 'string') {
    console.warn('[icloud-creds] decrypt failed:', decErr?.message);
    return null;
  }
  try {
    const parsed = JSON.parse(plaintext) as IcloudCredsBlob;
    if (!parsed.email || !parsed.password || !parsed.calendar_home_url) return null;
    return parsed;
  } catch {
    return null;
  }
}
