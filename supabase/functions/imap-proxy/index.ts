// supabase/functions/imap-proxy/index.ts
//
// Authenticated proxy for iCloud IMAP. Two ops:
//   - validate:   LOGIN + LOGOUT only. No DB writes.
//   - list-inbox: hash-bind check + LOGIN + SELECT INBOX + FETCH + LOGOUT.
//                 First successful call upserts the binding row.
//
// Hardcoded target imap.mail.me.com:993. No host param accepted.
// JWT required for all calls. Per-user rate limits enforced server-side.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ImapFlow } from 'imapflow';

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const RATE_LIMIT_VALIDATE = 10;     // per hour per user
const RATE_LIMIT_LIST_INBOX = 60;   // per hour per user

type ValidateReq = { op: 'validate'; email: string; password: string };
type ListInboxReq = {
  op: 'list-inbox';
  email: string;
  password: string;
  limit?: number;
};
type Req = ValidateReq | ListInboxReq;

type ErrCode =
  | 'unauthorized'
  | 'auth-failed'
  | 'rate-limited'
  | 'protocol'
  | 'temporarily-unavailable'
  | 'network'
  | 'timeout'
  | 'internal'
  | 'bad-request';

function err(code: ErrCode, status: number): Response {
  return Response.json({ ok: false, error: code }, { status });
}

serve(async (req) => {
  if (req.method !== 'POST') return err('bad-request', 405);

  // --- JWT gate (precedes env-guard so unauthenticated callers always get
  //     401, never a 500 leaking the env-misconfig signal).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return err('unauthorized', 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const pepper = Deno.env.get('BINDING_HASH_PEPPER');
  if (
    !supabaseUrl ||
    !anonKey ||
    !serviceKey ||
    !pepper ||
    pepper.length < 32
  ) {
    return err('internal', 500);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData.user) {
    return err('unauthorized', 401);
  }
  const userId = userData.user.id;

  // --- Body parse ---
  let body: Req;
  try {
    body = (await req.json()) as Req;
  } catch {
    return err('bad-request', 400);
  }
  if (
    !body ||
    (body.op !== 'validate' && body.op !== 'list-inbox') ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string' ||
    body.email.length === 0 ||
    body.password.length === 0
  ) {
    return err('bad-request', 400);
  }

  // (rate limit + per-op handling added in subsequent tasks)
  return Response.json({ ok: false, error: 'internal' }, { status: 501 });
});
