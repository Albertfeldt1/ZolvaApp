// src/lib/icloud-mail.ts
//
// Client for the imap-proxy edge function. Calls validate (during setup)
// and listInbox (during inbox fetch). On auth-failed from listInbox, flips
// the stored credential to 'invalid' state.

import { supabase } from './supabase';
import { loadCredential, markInvalid } from './icloud-credentials';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  throw new Error('icloud-mail: missing EXPO_PUBLIC_SUPABASE_URL');
}
const PROXY_URL = `${SUPABASE_URL}/functions/v1/imap-proxy`;

const VALIDATE_TIMEOUT_MS = 30_000;
const LIST_INBOX_TIMEOUT_MS = 25_000;
const GET_BODY_TIMEOUT_MS = 25_000;

// Codes the edge function may return on the wire. 'network', 'not-connected'
// and 'credential-rejected' are client-synthesized and must not be accepted
// from the server side.
const KNOWN_WIRE_CODES: ReadonlySet<IcloudErrorCode> = new Set([
  'auth-failed',
  'rate-limited',
  'protocol',
  'temporarily-unavailable',
  'unauthorized',
  'timeout',
]);

export type IcloudMessage = {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  unread: boolean;
  preview: string;
};

export type IcloudMessageBody = {
  uid: number;
  from: string;
  fromEmail: string;
  subject: string;
  body: string;
  messageIdHeader: string;
};

// Action-oriented error codes — names describe what the caller should do, not
// the underlying storage state. Asymmetric reachability via the hook layer:
// hooks gate on `loadCredential().kind === 'valid'` before calling listInbox,
// so 'not-connected' is unreachable from the hot path. The hot path is
// 'credential-rejected' when a previously-valid credential was flipped to
// invalid by a prior listInbox auth-failure.
export type IcloudErrorCode =
  | 'auth-failed'
  | 'rate-limited'
  | 'protocol'
  | 'temporarily-unavailable'
  | 'gateway-unavailable'  // client-synthesized: Supabase gateway 5xx after retries exhausted
  | 'network'
  | 'timeout'
  | 'not-connected'        // credential is 'absent' — caller should suppress UI silently
  | 'credential-rejected'  // credential is 'invalid' — caller should surface re-entry banner
  | 'unauthorized';

export type IcloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IcloudErrorCode };

export async function validate(
  email: string,
  password: string,
): Promise<IcloudResult<null>> {
  return await call<null>('validate', { email, password });
}

// In-flight dedup: useMailItems has multiple consumers (useInboxWaiting,
// useInboxArchived, useInboxCleared, useObservations), each instantiating
// its own fetch effect. Without dedup, one screen render fires 4 parallel
// IMAP logins per refresh — iCloud throttles per-account and the Supabase
// gateway 502s when it can't keep up. Concurrent listInbox calls for the
// same user with the same limit share one in-flight Promise.
const inflightListInbox = new Map<string, Promise<IcloudResult<IcloudMessage[]>>>();

export async function listInbox(
  userId: string,
  limit = 12,
): Promise<IcloudResult<IcloudMessage[]>> {
  const key = `${userId}:${limit}`;
  const existing = inflightListInbox.get(key);
  if (existing) return existing;

  const promise = listInboxImpl(userId, limit).finally(() => {
    inflightListInbox.delete(key);
  });
  inflightListInbox.set(key, promise);
  return promise;
}

async function listInboxImpl(
  userId: string,
  limit: number,
): Promise<IcloudResult<IcloudMessage[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') {
    return { ok: false, error: 'not-connected' };
  }
  if (cred.kind === 'invalid') {
    return { ok: false, error: 'credential-rejected' };
  }
  const res = await call<{ messages: RawMessage[] }>('list-inbox', {
    email: cred.credential.email,
    password: cred.credential.password,
    limit,
  });
  if (!res.ok) {
    if (res.error === 'auth-failed') {
      await markInvalid(userId, 'imap-rejected');
    }
    return res;
  }
  return {
    ok: true,
    data: res.data.messages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      date: new Date(m.date),
      unread: m.unread,
      preview: m.preview,
    })),
  };
}

// Best-effort wipe of the server-side binding row so a freshly-rotated
// Apple-Specific password can bind cleanly. Failures are non-fatal — the
// 90-day cron sweep is the eventual fallback. Caller should not block the
// UI on the result.
export async function clearBinding(): Promise<IcloudResult<null>> {
  return await call<null>('clear-binding', {});
}

export async function getMessageBody(
  userId: string,
  uid: number,
): Promise<IcloudResult<IcloudMessageBody>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') {
    return { ok: false, error: 'not-connected' };
  }
  if (cred.kind === 'invalid') {
    return { ok: false, error: 'credential-rejected' };
  }
  const res = await call<{ message: IcloudMessageBody }>('get-body', {
    email: cred.credential.email,
    password: cred.credential.password,
    uid,
  });
  if (!res.ok) {
    if (res.error === 'auth-failed') {
      await markInvalid(userId, 'imap-rejected');
    }
    return res;
  }
  return { ok: true, data: res.data.message };
}

type RawMessage = {
  uid: number;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  preview: string;
};

// Backoff schedule (ms) for gateway 5xx retries. The edge runtime can take
// up to ~12s to cold-start a fresh imap-proxy worker after a deploy or idle
// period; one retry at 800ms wasn't enough to outlast that. The first retry
// at 1.5s catches normal blips, the second at 4s catches deploy-fresh cold
// starts. Total worst-case added latency: ~5.5s + two extra round-trips.
const GATEWAY_RETRY_BACKOFF_MS = [1_500, 4_000];

async function call<T>(
  op: 'validate' | 'list-inbox' | 'get-body' | 'clear-binding',
  body: Record<string, unknown>,
): Promise<IcloudResult<T>> {
  // Retry on Supabase gateway 5xx — cold-start contention on the edge
  // runtime occasionally returns 502/503 with an HTML body before our
  // function ever boots. All four ops are idempotent server-side, so the
  // retry is safe.
  let last = await callOnce<T>(op, body);
  if (last.ok) return last;
  for (const delay of GATEWAY_RETRY_BACKOFF_MS) {
    if (last.ok || last.error !== 'protocol' || !last.gatewayFlake) break;
    await new Promise((r) => setTimeout(r, delay));
    if (__DEV__) console.warn(`[icloud-mail] ${op} retrying after gateway flake (waited ${delay}ms)`);
    last = await callOnce<T>(op, body);
  }
  // Retries exhausted on a gateway flake — promote to a distinct code so the
  // UI can blame the right party (us, not Apple).
  if (!last.ok && last.error === 'protocol' && last.gatewayFlake) {
    return { ok: false, error: 'gateway-unavailable' };
  }
  return last;
}

// Internal envelope: gatewayFlake distinguishes "Supabase gateway returned
// 5xx with HTML body" from a real protocol error reported by our function.
// Only the former is worth retrying.
type CallOnceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IcloudErrorCode; gatewayFlake?: boolean };

async function callOnce<T>(
  op: 'validate' | 'list-inbox' | 'get-body' | 'clear-binding',
  body: Record<string, unknown>,
): Promise<CallOnceResult<T>> {
  const session = await supabase.auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'unauthorized' };
  }
  const timeoutMs =
    op === 'validate' ? VALIDATE_TIMEOUT_MS
    : op === 'list-inbox' ? LIST_INBOX_TIMEOUT_MS
    : op === 'get-body' ? GET_BODY_TIMEOUT_MS
    : VALIDATE_TIMEOUT_MS; // clear-binding: same 30s ceiling as validate
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ op, ...body }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'timeout' };
    }
    if (__DEV__) {
      const e = err as { name?: string; message?: string };
      console.warn(`[icloud-mail] ${op} fetch threw:`, e?.name, e?.message);
    }
    return { ok: false, error: 'network' };
  }
  clearTimeout(timer);
  if (res.status === 200) {
    // validate + clear-binding return only `{ok: true}` — no payload.
    if (op === 'validate' || op === 'clear-binding') return { ok: true, data: null as T };
    const j = (await res.json()) as Record<string, unknown>;
    // Strip the wire envelope's `ok` so it doesn't leak into IcloudResult.data.
    const { ok: _wire, ...payload } = j;
    return { ok: true, data: payload as T };
  }
  let errCode: IcloudErrorCode;
  // Read body as text first so we can log it raw if JSON.parse fails or the
  // server didn't include the expected fields. Supabase gateway 502s during
  // cold-start return HTML, not JSON — without this we'd just see 'protocol'.
  const bodyText = await res.text();
  if (__DEV__) {
    console.warn(`[icloud-mail] ${op} non-200: status=${res.status} body=${bodyText.slice(0, 400)}`);
  }
  // Gateway 5xx with non-JSON body = upstream contention, worth retrying.
  // Function-emitted 5xx (502 protocol) carries JSON, so JSON.parse below
  // will succeed and gatewayFlake stays false.
  const isHtml = bodyText.trimStart().startsWith('<');
  const gatewayFlake = (res.status === 502 || res.status === 503) && isHtml;
  try {
    const j = JSON.parse(bodyText) as { error?: string; detail?: string };
    const raw = j.error;
    errCode = typeof raw === 'string' && KNOWN_WIRE_CODES.has(raw as IcloudErrorCode)
      ? (raw as IcloudErrorCode)
      : 'protocol';
    if (__DEV__ && errCode === 'protocol' && j.detail) {
      console.warn(`[icloud-mail] ${op} protocol detail:`, j.detail);
    }
  } catch {
    errCode = 'protocol';
  }
  return { ok: false, error: errCode, gatewayFlake };
}
