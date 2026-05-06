// src/lib/icloud-mail.ts
//
// Client for the imap-proxy edge function. Calls validate (during setup)
// and listInbox (during inbox fetch). On auth-failed from listInbox, flips
// the stored credential to 'invalid' state.
//
// Stale-while-revalidate cache for listInbox:
// iCloud goes through IMAP via Supabase edge functions, both of which are
// shakier than the Google/Microsoft REST APIs (IMAP login latency, edge
// cold-start 502/503 storms, Apple-side throttling on parallel logins).
// Without a cache, every gateway flake produces an empty inbox until the
// next user-initiated refresh.
//
// Strategy:
//   1. Module-level Map keyed by `${userId}:${limit}` holds the last
//      successful response per (user, page-size).
//   2. AsyncStorage backs it so cache survives cold start.
//   3. listInbox returns cached data IMMEDIATELY when present and fires a
//      background revalidation. Subscribers (useMailItems) bump their
//      refresh tick on cache update so the UI re-paints once fresh data
//      arrives without user interaction.
//   4. Revalidation failures keep the cache intact — we never blank the
//      inbox just because the gateway hiccuped. The credential-rejected
//      banner still surfaces for true auth-failed responses, so users see
//      both their cached mails AND know to re-enter their ASP.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { loadCredential, markInvalid } from './icloud-credentials';
import { parseFromHeader } from './gmail';
import { buildOutgoingBody } from './mail-signature';
import type { InlineAttachmentSpec } from './mail-signature';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
if (!SUPABASE_URL) {
  throw new Error('icloud-mail: missing EXPO_PUBLIC_SUPABASE_URL');
}
const PROXY_URL = `${SUPABASE_URL}/functions/v1/imap-proxy`;

const VALIDATE_TIMEOUT_MS = 30_000;
const LIST_INBOX_TIMEOUT_MS = 25_000;
const GET_BODY_TIMEOUT_MS = 25_000;
const SEND_MAIL_TIMEOUT_MS = 35_000;     // SMTP connect+send + IMAP APPEND headroom
const APPEND_DRAFT_TIMEOUT_MS = 25_000;

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
// Dedup map shared by fetchAndStore and revalidate so concurrent calls
// for the same (user, limit) — including a foreground fetch overlapping
// a background revalidation — never produce parallel IMAP logins. The
// foreground variant resolves to IcloudResult; the background variant
// resolves to void, hence the union.
const inflightListInbox = new Map<string, Promise<IcloudResult<IcloudMessage[]> | void>>();

// ─── Stale-while-revalidate cache ──────────────────────────────────────────

type SwrEntry = {
  // Stored as ISO strings on disk so JSON.parse/stringify roundtrip is
  // lossless; rehydrated to Date objects in memory before handing to
  // callers (IcloudMessage.date is a Date).
  data: IcloudMessage[];
  cachedAt: number;
};

// Sanity ceiling. If a cache entry is somehow ancient (laptop closed
// for weeks, app went unused), surface fresh data on next call rather
// than serving year-old mails as "current". The 7-day window is long
// enough that any reasonable user comes back to recent data.
const SWR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const swrCache = new Map<string, SwrEntry>();
const swrSubscribers = new Set<(key: string) => void>();
let swrHydratedForUser: string | null = null;
let swrHydrationPromise: Promise<void> | null = null;

const swrStorageKey = (userId: string) => `zolva.icloud.inbox.swr.${userId}`;

async function hydrateSwrCache(userId: string): Promise<void> {
  // Hydrate per-user. If user changes (sign out / sign in), reset and
  // re-hydrate the new user's cache. Avoids cross-account leakage.
  if (swrHydratedForUser === userId && swrHydrationPromise) {
    return swrHydrationPromise;
  }
  if (swrHydratedForUser !== userId) {
    swrCache.clear();
    swrHydratedForUser = userId;
  }
  swrHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(swrStorageKey(userId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { data: Array<Omit<IcloudMessage, 'date'> & { date: string }>; cachedAt: number }>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (
          !entry ||
          !Array.isArray(entry.data) ||
          typeof entry.cachedAt !== 'number'
        ) continue;
        if (now - entry.cachedAt > SWR_MAX_AGE_MS) continue;
        swrCache.set(key, {
          cachedAt: entry.cachedAt,
          data: entry.data.map((m) => ({ ...m, date: new Date(m.date) })),
        });
      }
    } catch {
      // Swallow — corrupted cache shouldn't block fresh fetches.
    }
  })();
  return swrHydrationPromise;
}

let swrPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistSwrSoon(userId: string): void {
  // Debounce — multiple updates in the same render tick collapse into
  // one storage write.
  if (swrPersistTimer) clearTimeout(swrPersistTimer);
  swrPersistTimer = setTimeout(() => {
    swrPersistTimer = null;
    if (swrHydratedForUser !== userId) return;
    const snapshot: Record<string, SwrEntry> = {};
    for (const [key, entry] of swrCache.entries()) {
      if (key.startsWith(`${userId}:`)) snapshot[key] = entry;
    }
    AsyncStorage.setItem(swrStorageKey(userId), JSON.stringify(snapshot)).catch(() => {});
  }, 250);
}

function notifySwrUpdate(key: string): void {
  for (const cb of swrSubscribers) cb(key);
}

// Subscribe to cache updates. Used by useMailItems to bump its refresh
// tick when background revalidation lands fresh data, so the UI repaints
// without user action.
export function subscribeToIcloudInboxCache(cb: (key: string) => void): () => void {
  swrSubscribers.add(cb);
  return () => {
    swrSubscribers.delete(cb);
  };
}

// Cheap signature for change detection — only the top 12 message uids +
// unread state. Misses preview/subject edits but catches the cases that
// matter (new mail, mail read elsewhere, mail deleted).
function signatureOf(messages: IcloudMessage[]): string {
  return messages
    .slice(0, 12)
    .map((m) => `${m.uid}|${m.unread ? '1' : '0'}`)
    .join(',');
}

// Public: drop cached inbox for a user. Called when iCloud is fully
// disconnected (clearCredential) so a different Apple ID on the same
// device doesn't inherit the prior account's mails.
export async function clearInboxCache(userId: string): Promise<void> {
  for (const key of [...swrCache.keys()]) {
    if (key.startsWith(`${userId}:`)) swrCache.delete(key);
  }
  if (swrHydratedForUser === userId) {
    swrHydratedForUser = null;
    swrHydrationPromise = null;
  }
  try {
    await AsyncStorage.removeItem(swrStorageKey(userId));
  } catch {
    // best-effort
  }
}

// ─── listInbox ────────────────────────────────────────────────────────────

export async function listInbox(
  userId: string,
  limit = 12,
): Promise<IcloudResult<IcloudMessage[]>> {
  const key = `${userId}:${limit}`;
  await hydrateSwrCache(userId);

  const cached = swrCache.get(key);
  if (cached) {
    // Stale-while-revalidate: hand back cache instantly, refresh in the
    // background. Subscribers re-render once fresh data lands.
    void revalidate(userId, limit, key, cached.data);
    return { ok: true, data: cached.data };
  }

  // No cache yet — fall through to a synchronous fetch and cache it.
  return fetchAndStore(userId, limit, key);
}

async function fetchAndStore(
  userId: string,
  limit: number,
  key: string,
): Promise<IcloudResult<IcloudMessage[]>> {
  const existing = inflightListInbox.get(key);
  if (existing) {
    // Could be a foreground fetch (returns IcloudResult) or a background
    // revalidate (returns void). Wait for it either way; afterward, an
    // IcloudResult is the foreground caller's result, while void means
    // the revalidate either cached fresh data or failed silently. Check
    // the cache before falling through to a fresh fetch.
    const r = await existing;
    if (r && typeof r === 'object' && 'ok' in r) return r;
    const cached = swrCache.get(key);
    if (cached) return { ok: true, data: cached.data };
    // Revalidate finished without populating cache → it failed. Fall
    // through to our own fetch so the caller gets a real error.
  }

  const promise = listInboxImpl(userId, limit)
    .then((res) => {
      if (res.ok) {
        swrCache.set(key, { data: res.data, cachedAt: Date.now() });
        persistSwrSoon(userId);
        // First-fetch case: subscribers fire so any UI listening gets
        // notified the cache now exists for this key.
        notifySwrUpdate(key);
      }
      return res;
    })
    .finally(() => {
      inflightListInbox.delete(key);
    });
  inflightListInbox.set(key, promise);
  return promise;
}

async function revalidate(
  userId: string,
  limit: number,
  key: string,
  prevData: IcloudMessage[],
): Promise<void> {
  // Don't pile revalidations on top of an in-flight fetch — let the in-
  // flight one settle, callers will pick up the new cache on next call.
  if (inflightListInbox.has(key)) return;

  const promise = listInboxImpl(userId, limit)
    .then((res) => {
      if (!res.ok) {
        // Revalidation failure: keep the cache. The error propagates to
        // its own caller (the fetchAndStore path triggered by a forced
        // refresh) but background revalidation never blanks the inbox.
        // auth-failed already flipped credential to invalid via
        // listInboxImpl, so the credential-rejected banner surfaces
        // independently.
        return;
      }
      const prevSig = signatureOf(prevData);
      const nextSig = signatureOf(res.data);
      swrCache.set(key, { data: res.data, cachedAt: Date.now() });
      persistSwrSoon(userId);
      if (prevSig !== nextSig) {
        notifySwrUpdate(key);
      }
    })
    .finally(() => {
      inflightListInbox.delete(key);
    });
  inflightListInbox.set(key, promise);
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
      // imap-proxy returns the raw RFC-2822 From header ("Name <addr>"
      // or just "addr"). Strip the bracketed address so the inbox row
      // shows just the display name, matching Gmail/Graph behavior.
      from: parseFromHeader(m.from),
      subject: m.subject,
      date: new Date(m.date),
      unread: m.unread,
      preview: m.preview,
    })),
  };
}

// Server-reported INBOX counts via IMAP STATUS. Cheaper than list-inbox
// (no FETCH) and stable across reloads — the displayed total/unread don't
// drift with the per-fetch limit window.
export async function getInboxCounts(
  userId: string,
): Promise<IcloudResult<{ total: number; unread: number }>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') {
    return { ok: false, error: 'not-connected' };
  }
  if (cred.kind === 'invalid') {
    return { ok: false, error: 'credential-rejected' };
  }
  const res = await call<{ total: number; unread: number }>('count', {
    email: cred.credential.email,
    password: cred.credential.password,
  });
  if (!res.ok) {
    if (res.error === 'auth-failed') {
      await markInvalid(userId, 'imap-rejected');
    }
    return res;
  }
  return { ok: true, data: { total: res.data.total, unread: res.data.unread } };
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
  return {
    ok: true,
    data: { ...res.data.message, from: parseFromHeader(res.data.message.from) },
  };
}

export type IcloudComposeInput = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;          // raw user body — signature is applied below
  replyToUid?: number;   // IMAP UID of original mail when replying
};

function attachmentsToWire(specs: InlineAttachmentSpec[]): Array<{
  filename: string;
  mime_type: string;
  content_b64: string;
  content_id: string;
}> {
  return specs.map((s) => ({
    filename: s.filename,
    mime_type: s.mimeType,
    content_b64: s.contentBytes,
    content_id: s.contentId,
  }));
}

export async function icloudSendMail(
  userId: string,
  input: IcloudComposeInput,
): Promise<IcloudResult<null>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };

  const built = await buildOutgoingBody(input.body);
  const reqBody: Record<string, unknown> = {
    email: cred.credential.email,
    password: cred.credential.password,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    content_type: built.contentType,
    content: built.content,
    attachments: built.attachments.length > 0 ? attachmentsToWire(built.attachments) : undefined,
  };
  if (typeof input.replyToUid === 'number' && Number.isFinite(input.replyToUid)) {
    reqBody.reply_to_uid = input.replyToUid;
  }

  const res = await call<null>('send-mail', reqBody);
  if (!res.ok && res.error === 'auth-failed') {
    await markInvalid(userId, 'imap-rejected');
  }
  return res;
}

export async function icloudAppendDraft(
  userId: string,
  input: IcloudComposeInput,
): Promise<IcloudResult<null>> {
  const cred = await loadCredential(userId);
  if (cred.kind === 'absent') return { ok: false, error: 'not-connected' };
  if (cred.kind === 'invalid') return { ok: false, error: 'credential-rejected' };

  const built = await buildOutgoingBody(input.body);
  const reqBody: Record<string, unknown> = {
    email: cred.credential.email,
    password: cred.credential.password,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    content_type: built.contentType,
    content: built.content,
    attachments: built.attachments.length > 0 ? attachmentsToWire(built.attachments) : undefined,
  };
  if (typeof input.replyToUid === 'number' && Number.isFinite(input.replyToUid)) {
    reqBody.reply_to_uid = input.replyToUid;
  }

  const res = await call<null>('append-draft', reqBody);
  if (!res.ok && res.error === 'auth-failed') {
    await markInvalid(userId, 'imap-rejected');
  }
  return res;
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
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
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
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
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
    : op === 'send-mail' ? SEND_MAIL_TIMEOUT_MS
    : op === 'append-draft' ? APPEND_DRAFT_TIMEOUT_MS
    : VALIDATE_TIMEOUT_MS;
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
    // validate + clear-binding + send-mail + append-draft return only `{ok: true, ...}`
    // — caller doesn't consume any payload field.
    if (
      op === 'validate' ||
      op === 'clear-binding' ||
      op === 'send-mail' ||
      op === 'append-draft'
    ) {
      return { ok: true, data: null as T };
    }
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
  // Two shapes seen in the wild:
  //   1. HTML error page (Cloudflare/Supabase classic gateway error)
  //   2. Empty body — happens on edge-runtime worker spawn failure / cold-start
  //      timeout, where the gateway gives up before the function emits anything
  // Function-emitted 5xx (502 protocol) carries JSON, so the parse below will
  // succeed and gatewayFlake stays false either way.
  const trimmed = bodyText.trim();
  const isHtml = trimmed.startsWith('<');
  const isEmpty = trimmed.length === 0;
  const gatewayFlake = (res.status === 502 || res.status === 503) && (isHtml || isEmpty);
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
