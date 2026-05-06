// supabase/functions/imap-proxy/index.ts
//
// Authenticated proxy for iCloud IMAP. Four ops:
//   - validate:      LOGIN + LOGOUT, then upsert the binding hash so a
//                    Setup-screen reconnect refreshes the bound credential.
//   - list-inbox:    hash-bind check + LOGIN + SELECT INBOX + FETCH list + LOGOUT.
//                    First successful call upserts the binding row.
//   - get-body:      hash-bind check + LOGIN + EXAMINE INBOX + FETCH bodyStructure
//                    + FETCH text part + LOGOUT. Read-only (EXAMINE) so opening
//                    mail in Zolva does NOT mark it \Seen on iCloud.
//   - clear-binding: deletes the caller's binding row so a new app-specific
//                    password can bind fresh. JWT-gated; no IMAP/Apple call.
//
// Five ops:
//   - count:         hash-bind check + LOGIN + STATUS INBOX (MESSAGES UNSEEN)
//                    + LOGOUT. Returns server-reported total + unread counts
//                    so the client can show a stable inbox total that
//                    doesn't depend on the per-fetch limit window.
//
// Hardcoded target imap.mail.me.com:993. No host param accepted.
// JWT required for all calls. Per-user rate limits enforced server-side.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// Lazy-loaded inside IMAP code paths so cold-start of the worker doesn't pay
// the npm:imapflow eval cost (~5-10s on a fresh worker, was triggering
// gateway 502s on validate). Non-IMAP ops (ping, clear-binding) never load
// it. First IMAP call after cold-start pays the load; subsequent calls reuse
// the cached module on the same worker.
import type { ImapFlow } from 'imapflow';

let _ImapFlowCtor: typeof ImapFlow | null = null;
async function getImapFlow(): Promise<typeof ImapFlow> {
  if (_ImapFlowCtor) return _ImapFlowCtor;
  const mod = await import('imapflow');
  _ImapFlowCtor = mod.ImapFlow;
  return _ImapFlowCtor;
}

// SMTP target. We speak the protocol directly via Deno.connect + Deno.startTls
// rather than pulling a denomailer / nodemailer dependency — both of those
// pushed our edge-function cold-start past Supabase's 12s gateway timeout.
const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;
const SMTP_CONNECT_TIMEOUT_MS = 5_000;
const SMTP_COMMAND_TIMEOUT_MS = 15_000;

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const RATE_LIMIT_VALIDATE = 10;       // per hour per user
const RATE_LIMIT_LIST_INBOX = 60;     // per hour per user
const RATE_LIMIT_GET_BODY = 120;      // per hour per user (one fetch per opened mail)
const RATE_LIMIT_SEND_MAIL = 30;      // per hour per user — under Apple SMTP per-account throttle
const RATE_LIMIT_APPEND_DRAFT = 60;   // per hour per user — cheap IMAP APPEND, shares list-inbox order of magnitude

type ValidateReq = { op: 'validate'; email: string; password: string };
type ListInboxReq = {
  op: 'list-inbox';
  email: string;
  password: string;
  limit?: number;
};
type GetBodyReq = {
  op: 'get-body';
  email: string;
  password: string;
  uid: number;
};
type CountReq = {
  op: 'count';
  email: string;
  password: string;
};
// clear-binding doesn't need email/password — the JWT identifies the user
// and the binding row is keyed by user_id. Email/password fields are
// optional/ignored to keep the request shape uniform with the other ops.
type ClearBindingReq = {
  op: 'clear-binding';
  email?: string;
  password?: string;
};
// Keep-warm op for pg_cron. Returns immediately with no env, DB, or IMAP
// touch — the only goal is to keep a worker from idling out, so the gateway
// doesn't 502 on the next real cold-start.
type PingReq = { op: 'ping' };
type AttachmentSpec = {
  filename: string;
  mime_type: string;
  content_b64: string;     // base64-encoded bytes
  content_id: string;      // for cid:<content_id> references in HTML
};
type ComposeBase = {
  email: string;
  password: string;
  to: string[];
  cc?: string[];
  subject: string;
  content_type: 'text' | 'html';
  content: string;
  attachments?: AttachmentSpec[];
  reply_to_uid?: number;
};
type SendMailReq = ComposeBase & { op: 'send-mail' };
type AppendDraftReq = ComposeBase & { op: 'append-draft' };
type Req =
  | ValidateReq
  | ListInboxReq
  | GetBodyReq
  | CountReq
  | ClearBindingReq
  | PingReq
  | SendMailReq
  | AppendDraftReq;

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

function err(code: ErrCode, status: number, detail?: string): Response {
  // `detail` (when set) is a short truncated error message — used by the
  // client to surface the actual IMAP failure cause for 'protocol' errors
  // without round-tripping to Supabase function logs.
  const body: Record<string, unknown> = { ok: false, error: code };
  if (detail) body.detail = detail.slice(0, 200);
  return Response.json(body, { status });
}

serve(async (req) => {
  if (req.method !== 'POST') return err('bad-request', 405);

  // --- JWT gate (precedes env-guard so unauthenticated callers always get
  //     401, never a 500 leaking the env-misconfig signal).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return err('unauthorized', 401);
  }

  // --- Body parse (early so ping can skip env/createClient/getUser) ---
  let body: Req;
  try {
    body = (await req.json()) as Req;
  } catch {
    return err('bad-request', 400);
  }

  // Keep-warm fast path: bearer presence is gate enough (Supabase gateway
  // already requires an apikey to reach the function). Ping returns before
  // env lookup, supabase-js getUser(), and rate-limit DB write — so a
  // per-minute pg_cron tick keeps the worker hot for ~tens of ms each.
  if (body && body.op === 'ping') {
    return Response.json({ ok: true });
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

  if (
    !body ||
    (body.op !== 'validate' &&
      body.op !== 'list-inbox' &&
      body.op !== 'get-body' &&
      body.op !== 'count' &&
      body.op !== 'clear-binding' &&
      body.op !== 'send-mail' &&
      body.op !== 'append-draft')
  ) {
    return err('bad-request', 400);
  }
  // Email/password required for IMAP-touching ops; clear-binding is JWT-only.
  if (body.op !== 'clear-binding') {
    if (
      typeof body.email !== 'string' ||
      typeof body.password !== 'string' ||
      body.email.length === 0 ||
      body.password.length === 0
    ) {
      return err('bad-request', 400);
    }
  }
  if (body.op === 'get-body' && (typeof body.uid !== 'number' || !Number.isFinite(body.uid))) {
    return err('bad-request', 400);
  }
  if (body.op === 'send-mail' || body.op === 'append-draft') {
    const composeBody = body as ComposeBase;
    if (!Array.isArray(composeBody.to) || composeBody.to.length === 0 ||
        !composeBody.to.every((s) => typeof s === 'string' && s.length > 0)) {
      return err('bad-request', 400, 'invalid `to`');
    }
    if (composeBody.cc !== undefined && !Array.isArray(composeBody.cc)) {
      return err('bad-request', 400, 'invalid `cc`');
    }
    if (typeof composeBody.subject !== 'string' || composeBody.subject.length === 0) {
      return err('bad-request', 400, 'invalid `subject`');
    }
    if (composeBody.content_type !== 'text' && composeBody.content_type !== 'html') {
      return err('bad-request', 400, 'invalid `content_type`');
    }
    if (typeof composeBody.content !== 'string' || composeBody.content.length === 0) {
      return err('bad-request', 400, 'invalid `content`');
    }
    if (composeBody.attachments !== undefined && !Array.isArray(composeBody.attachments)) {
      return err('bad-request', 400, 'invalid `attachments`');
    }
  }

  // --- Rate limit ---
  const rateOk = await checkRateLimit(serviceKey, supabaseUrl, userId, body.op);
  if (!rateOk) return err('rate-limited', 429);

  if (body.op === 'validate') {
    return await handleValidate(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'list-inbox') {
    return await handleListInbox(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'get-body') {
    return await handleGetBody(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'count') {
    return await handleCount(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'clear-binding') {
    return await handleClearBinding(userId, supabaseUrl, serviceKey);
  }
  if (body.op === 'send-mail') {
    return await handleSendMail(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'append-draft') {
    return await handleAppendDraft(body, userId, pepper, supabaseUrl, serviceKey);
  }
  return err('bad-request', 400);
});

async function checkRateLimit(
  serviceKey: string,
  supabaseUrl: string,
  userId: string,
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
): Promise<boolean> {
  // clear-binding doesn't need rate limiting — the JWT already authorizes,
  // and a malicious user can only delete their OWN row. Skipping the check
  // also means disconnect-then-reconnect doesn't false-trigger the limit.
  if (op === 'clear-binding') return true;
  // count piggy-backs on the list-inbox bucket — both are read-only INBOX
  // taps, and the count call is meaningfully cheaper (STATUS vs FETCH), so
  // sharing the limit prevents a polling client from exhausting either.
  const limit =
    op === 'validate'
      ? RATE_LIMIT_VALIDATE
      : op === 'list-inbox' || op === 'count'
      ? RATE_LIMIT_LIST_INBOX
      : op === 'send-mail'
      ? RATE_LIMIT_SEND_MAIL
      : op === 'append-draft'
      ? RATE_LIMIT_APPEND_DRAFT
      : RATE_LIMIT_GET_BODY;
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await svc
    .from('icloud_proxy_calls')
    .select('id', { head: true, count: 'exact' })
    .eq('user_id', userId)
    .eq('op', op)
    .gte('called_at', since);
  if (error) {
    console.warn('[imap-proxy] rate-limit check failed:', error.message);
    return true; // fail open on infrastructure errors; don't block legit users
  }
  if ((count ?? 0) >= limit) return false;
  // Await the insert — Supabase edge runtime can terminate the request
  // context before fire-and-forget promises complete, which silently breaks
  // rate-limit accounting (every call sees count=0 because no inserts ever
  // land). Adds ~10-30ms but makes the limit actually enforce.
  const { error: insertErr } = await svc
    .from('icloud_proxy_calls')
    .insert({ user_id: userId, op });
  if (insertErr) {
    console.warn('[imap-proxy] rate-limit insert failed:', insertErr.message);
  }
  return true;
}

async function handleValidate(
  body: ValidateReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();

  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    await client.logout();
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  // Validate is the explicit "use these credentials going forward" call from
  // the Setup screen — upsert the binding hash so subsequent list-inbox /
  // get-body calls don't get rejected by a stale hash from the previous
  // password. Without this, reconnecting via Setup (without a full disconnect
  // first) leaves the old binding in place and every fetch 422s.
  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { error: bindWriteErr } = await svc
    .from('icloud_credential_bindings')
    .upsert(
      {
        user_id: userId,
        credential_hash: hash,
        last_validated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  if (bindWriteErr) {
    console.warn('[imap-proxy] validate binding write failed:', bindWriteErr.message);
  }
  return Response.json({ ok: true });
}

async function newImapClient(email: string, password: string): Promise<ImapFlow> {
  const Ctor = await getImapFlow();
  return new Ctor({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,                  // never log credentials
    socketTimeout: COMMAND_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
}

function normalizePassword(input: string): string {
  return input.replace(/[\s-]/g, '');
}

function mapImapError(caughtErr: unknown): Response {
  const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
  // imapflow throws structured errors with serverResponseCode
  const code =
    (caughtErr as { serverResponseCode?: string })?.serverResponseCode ?? '';

  // Structured IMAP response codes are authoritative. Check them first so a
  // transient like `NO [UNAVAILABLE] LOGIN failed - try again` (code=UNAVAILABLE,
  // msg contains "LOGIN failed") routes to temporarily-unavailable rather than
  // being misclassified as auth-failed and triggering a re-enter loop.
  if (code === 'AUTHENTICATIONFAILED') return err('auth-failed', 422);
  if (code === 'INUSE' || code === 'UNAVAILABLE' || code === 'ALERT') {
    return err('temporarily-unavailable', 503);
  }

  // Fall back to message-text patterns ONLY when no structured code is present.
  if (!code) {
    if (
      /AUTHENTICATIONFAILED/i.test(msg) ||
      /\bLOGIN failed\b/i.test(msg)
    ) {
      return err('auth-failed', 422);
    }
    if (/^NO\b/i.test(msg)) {
      return err('temporarily-unavailable', 503);
    }
  }

  // Transport-level errors don't carry an IMAP code regardless.
  if (/AbortError|aborted/i.test(msg) || /timeout/i.test(msg)) {
    return err('timeout', 504);
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(msg)) {
    return err('network', 503);
  }

  const errObj = caughtErr as {
    name?: string;
    code?: string;
    response?: string;
    serverResponseCode?: string;
    responseStatus?: string;
    authenticationFailed?: boolean;
  } | null;

  // imapflow's `ClosedAfterConnectTLS` / `ClosedAfterConnect` codes — TCP+TLS
  // handshake completed, then the server (Apple) closed the socket before
  // sending the IMAP greeting. We've seen this when Apple's anti-abuse system
  // throttles connections from Supabase's edge egress IPs. Functionally
  // equivalent to a transient unavailable from Apple's side, not a protocol
  // bug — surface it so the client banner reads "iCloud svarer ikke" instead
  // of a generic protocol error.
  if (
    errObj?.code === 'ClosedAfterConnectTLS' ||
    errObj?.code === 'ClosedAfterConnect' ||
    /ClosedAfterConnect/i.test(msg)
  ) {
    return err('temporarily-unavailable', 503);
  }

  // Capture as much context as ImapFlow exposes so the next 'protocol' error
  // is diagnosable from the function logs without repro on the client.
  const ctx = JSON.stringify({
    msg,
    name: errObj?.name,
    code: errObj?.code,
    serverResponseCode: errObj?.serverResponseCode,
    responseStatus: errObj?.responseStatus,
    response: typeof errObj?.response === 'string' ? errObj.response.slice(0, 300) : undefined,
    authenticationFailed: errObj?.authenticationFailed,
  });
  console.warn('[imap-proxy] unmapped imap error:', ctx);
  // Return the truncated context to the client so __DEV__ logs reveal the
  // actual IMAP failure without a function-logs dive.
  return err('protocol', 502, ctx);
}

// Hand-rolled SMTP outcome codes mirror the public IcloudErrorCode set
// (auth-failed for 535 LOGIN-failed, network/timeout/protocol for the
// transport flavors). The `detail` is forwarded to the client and shown in
// the chat error string.
type SmtpFailCode = 'auth-failed' | 'network' | 'timeout' | 'protocol';
type SmtpResult =
  | { ok: true }
  | { ok: false; code: SmtpFailCode; detail?: string };

function smtpResultToResponse(r: SmtpResult & { ok: false }): Response {
  if (r.code === 'auth-failed') return err('auth-failed', 422, r.detail);
  if (r.code === 'timeout') return err('timeout', 504, r.detail);
  if (r.code === 'network') return err('network', 503, r.detail);
  return err('protocol', 502, r.detail);
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 12;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

// Pepper is consumed as UTF-8 bytes of its string representation — NOT
// hex-decoded. The runbook stores it as a 64-char hex string and the function
// must keep treating it that way; switching to hex-decoded raw bytes would
// produce different key material and invalidate every existing binding row.
async function hashCredential(pepper: string, email: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${email}:${password}`));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pickMessageDate(internalDate: unknown, envelopeDate: unknown): string {
  // ImapFlow returns these as Date objects when populated. Coerce defensively
  // because some servers occasionally hand back strings.
  const isoOf = (v: unknown): string | null => {
    if (!v) return null;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    if (typeof v === 'string' || typeof v === 'number') {
      const t = new Date(v).getTime();
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    return null;
  };
  return isoOf(internalDate) ?? isoOf(envelopeDate) ?? new Date().toISOString();
}

function formatFrom(from: Array<{ name?: string; address?: string }> | undefined | null): string {
  if (!from || from.length === 0) return '';
  const f = from[0];
  if (f.name && f.address) return `${f.name} <${f.address}>`;
  return f.address ?? f.name ?? '';
}

// Naive tag stripper — does not handle attributes containing ">", CDATA,
// HTML comments, or HTML-like text that starts after the first 100 chars.
// Decodes only five entities (&amp; &lt; &gt; &nbsp; and numeric &#NNN;).
// Lossy by design — full BODYSTRUCTURE parsing is future work.
function extractPreview(part: Uint8Array | undefined): string {
  if (!part) return '';
  const text = new TextDecoder().decode(part);
  if (text.length === 0) return '';
  const looksHtml = text.slice(0, 100).includes('<');
  const stripped = looksHtml
    ? text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    : text;
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 140);
}

async function handleListInbox(
  body: ListInboxReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();
  const limit = clampLimit(body.limit);

  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Binding check: if a row exists, hash MUST match. If absent, this is the
  // first call — proceed and create the row on success.
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[imap-proxy] binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (existing && existing.credential_hash !== hash) {
    // Not a perfect oracle: response time distinguishes mismatch (~10ms DB)
    // from a real Apple rejection (~500ms IMAP roundtrip). With 60/hr rate
    // limit, an attacker who already holds the JWT learns only "this guess
    // doesn't match the binding" — not the bound credential itself.
    return err('auth-failed', 422);
  }

  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    // readOnly: true makes the server open INBOX with EXAMINE rather than
    // SELECT, so the BODY[1] fetch below does not implicitly set \Seen on
    // unread messages. Without this, every list-inbox would mark mail as
    // read in the user's iCloud account.
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const messages: Array<{
      uid: number;
      from: string;
      subject: string;
      date: string;
      unread: boolean;
      preview: string;
    }> = [];
    try {
      const mbox = client.mailbox;
      if (!mbox || typeof mbox === 'boolean') throw new Error('mailbox not open');
      const total = mbox.exists;
      if (total > 0) {
        const lo = Math.max(1, total - limit + 1);
        const range = `${lo}:${total}`;
        for await (const m of client.fetch(range, {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyParts: ['1'],
        })) {
          const env = m.envelope;
          if (!env) continue;
          // Prefer internalDate (when the IMAP server received the message)
          // over envelope.date (the Date: header from the sender). The header
          // can be missing, malformed, or in the sender's local timezone —
          // we've seen Apple-noreply messages where the parsed envelope date
          // fell on the wrong hour. internalDate is always a server-stamped
          // UTC moment, so the "received at" the user sees in the inbox
          // matches when iCloud actually delivered the message.
          const dateIso = pickMessageDate(m.internalDate, env.date);
          messages.push({
            uid: m.uid,
            from: formatFrom(env.from),
            subject: env.subject ?? '(uden emne)',
            date: dateIso,
            unread: !(m.flags && m.flags.has('\\Seen')),
            preview: extractPreview(m.bodyParts?.get('1')),
          });
        }
      }
    } finally {
      // Guard release so a release-time error doesn't shadow the original
      // fetch-loop error on its way to the outer catch.
      try { lock.release(); } catch { /* release errors are secondary */ }
    }
    await client.logout();

    // Bind on first-success / refresh on subsequent
    const { error: bindWriteErr } = await svc
      .from('icloud_credential_bindings')
      .upsert(
        {
          user_id: userId,
          credential_hash: hash,
          last_validated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (bindWriteErr) {
      console.warn('[imap-proxy] binding write failed:', bindWriteErr.message);
      // don't fail the request — user got their data; binding can repair next call
    }

    return Response.json({ ok: true, messages });
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

// --- get-body ---------------------------------------------------------------
//
// Walks the BODYSTRUCTURE to find the best text part (text/plain preferred;
// text/html stripped to plain as fallback), fetches just that part with
// readOnly INBOX so iCloud doesn't flip the \Seen flag, decodes the transfer
// encoding (base64 / quoted-printable / 7bit / 8bit), then converts charset
// via TextDecoder. HTML stripping is the same lossy approach used for inbox
// previews — full BODYSTRUCTURE traversal w/ inline image handling is later.

type BodyNode = {
  type?: string;            // e.g. 'text/plain', 'multipart/alternative'
  part?: string;            // IMAP part designator: '1', '1.1', etc.
  encoding?: string;        // '7bit' | '8bit' | 'base64' | 'quoted-printable' | 'binary'
  parameters?: { charset?: string };
  childNodes?: BodyNode[];
};

type TextPartSpec = {
  part: string;
  isHtml: boolean;
  encoding: string;
  charset: string;
};

// Returns every text/* part in the message in preference order: text/plain
// first, text/html next, any other text/* last. The caller fetches each in
// turn until one yields meaningful content — Apple often ships a stub
// text/plain ("View this email in HTML") with the real content in text/html,
// and the previous "first plain wins" picker rendered those as blank bodies.
function pickTextParts(node: BodyNode | undefined): TextPartSpec[] {
  if (!node) return [];
  const flat: BodyNode[] = [];
  if (node.childNodes && node.childNodes.length > 0) {
    const stack: BodyNode[] = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.childNodes && n.childNodes.length > 0) stack.push(...n.childNodes);
      else flat.push(n);
    }
  } else {
    // Single-part message — the root IS the leaf. iCloud expects part '1'.
    flat.push({ ...node, part: node.part ?? '1' });
  }
  const textNodes = flat.filter((n) => n.type && /^text\//i.test(n.type) && n.part);
  const score = (n: BodyNode): number => {
    if (/text\/plain/i.test(n.type ?? '')) return 0;
    if (/text\/html/i.test(n.type ?? '')) return 1;
    return 2;
  };
  textNodes.sort((a, b) => score(a) - score(b));
  return textNodes.map((n) => ({
    part: n.part!,
    isHtml: /text\/html/i.test(n.type ?? ''),
    encoding: (n.encoding ?? '7bit').toLowerCase(),
    charset: n.parameters?.charset ?? 'utf-8',
  }));
}

// Heuristic: a plain part shorter than this is almost certainly a stub
// ("Please view in an HTML-capable mail client"), and the real content
// lives in text/html. Tuned to keep short legitimate replies (like
// "OK, talk later") while skipping single-line stubs.
const PLAIN_STUB_THRESHOLD = 40;

function decodeContent(buf: Uint8Array, encoding: string, charset: string): string {
  let bytes = buf;
  if (encoding === 'base64') {
    const ascii = new TextDecoder('ascii').decode(buf).replace(/\s+/g, '');
    try {
      const bin = atob(ascii);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch { /* fall through with raw bytes — better than throwing */ }
  } else if (encoding === 'quoted-printable') {
    const ascii = new TextDecoder('ascii').decode(buf);
    const decoded = ascii
      .replace(/=\r?\n/g, '')
      .replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  }
  // 7bit / 8bit / binary: raw bytes are already what we want.
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // Unknown charset — fall back to UTF-8 (most common).
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function handleGetBody(
  body: GetBodyReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();
  const uid = body.uid;

  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Same binding-check posture as list-inbox.
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[imap-proxy] get-body binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (existing && existing.credential_hash !== hash) {
    return err('auth-failed', 422);
  }
  // No binding row yet means the user hasn't validated/list-inboxed this
  // credential. Don't bind here — get-body shouldn't be the first call.
  if (!existing) {
    return err('auth-failed', 422);
  }

  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    let envelope: { from?: Array<{ name?: string; address?: string }>; subject?: string; messageId?: string } | undefined;
    try {
      const meta = await client.fetchOne(
        String(uid),
        { envelope: true, bodyStructure: true },
        { uid: true },
      );
      if (!meta) {
        return err('protocol', 502);
      }
      envelope = meta.envelope as typeof envelope;
      const textParts = pickTextParts(meta.bodyStructure as BodyNode | undefined);

      // Try each text part in preference order, stopping on the first one
      // that yields meaningful content. Stub plain parts (Apple, Outlook
      // bouncebacks, transactional senders) are kept only as a last-resort
      // fallback if every richer alternative also failed.
      let bodyText = '';
      let stubFallback = '';
      for (const tp of textParts) {
        const partFetch = await client.fetchOne(
          String(uid),
          { bodyParts: [tp.part] },
          { uid: true },
        );
        const buf = partFetch?.bodyParts?.get(tp.part);
        if (!buf) continue;
        const raw = decodeContent(buf, tp.encoding, tp.charset);
        const decoded = tp.isHtml ? stripHtmlToText(raw) : raw.trim();
        if (decoded.length === 0) continue;
        if (!tp.isHtml && decoded.length < PLAIN_STUB_THRESHOLD && textParts.some((p) => p !== tp && p.isHtml)) {
          // Hold the short plain part as fallback in case the html also fails.
          if (!stubFallback) stubFallback = decoded;
          continue;
        }
        bodyText = decoded;
        break;
      }
      if (!bodyText) bodyText = stubFallback;
      if (!bodyText) {
        // Surface the structure so we can diagnose which Apple/MIME shape
        // confused the picker. Don't bail — return the empty body so the
        // detail screen still shows headers + "no readable body".
        console.warn(
          '[imap-proxy] get-body returned empty for uid',
          uid,
          'bodyStructure:',
          JSON.stringify(meta.bodyStructure),
        );
      }

      await client.logout();
      return Response.json({
        ok: true,
        message: {
          uid,
          from: formatFrom(envelope?.from),
          fromEmail: envelope?.from?.[0]?.address ?? '',
          subject: envelope?.subject ?? '(uden emne)',
          body: bodyText,
          messageIdHeader: envelope?.messageId ?? '',
        },
      });
    } finally {
      try { lock.release(); } catch { /* secondary error */ }
    }
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}

// --- count -----------------------------------------------------------------
//
// Returns server-reported INBOX message and unseen counts. Uses IMAP STATUS,
// which is much cheaper than SELECT+FETCH and lets the client display a
// stable inbox total that doesn't depend on the per-fetch limit window.
async function handleCount(
  body: CountReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();
  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  // Mirror handleListInbox's binding check — count is a read-only op but
  // still needs to refuse if the bound password has rotated.
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[imap-proxy] binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (existing && existing.credential_hash !== hash) {
    return err('auth-failed', 422);
  }

  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    // STATUS gives the all-time INBOX total cheaply (no lock, no \Seen
    // change). For unread we want only mail received in the past 7
    // days — STATUS can't filter by date, so we EXAMINE (read-only)
    // and run SEARCH UNSEEN SINCE. EXAMINE matches list-inbox's
    // readOnly behavior, so opening INBOX here doesn't mark anything
    // \Seen.
    const status = await client.status('INBOX', { messages: true });
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    let recentUnreadCount = 0;
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ unseen: true, since }, { uid: true });
      recentUnreadCount = Array.isArray(uids) ? uids.length : 0;
    } finally {
      lock.release();
    }
    return Response.json({
      ok: true,
      total: status.messages ?? 0,
      unread: recentUnreadCount,
    });
  } catch (e) {
    return mapImapError(e);
  } finally {
    try {
      await client?.logout();
    } catch {
      /* noop */
    }
  }
}

function decodeAttachments(specs: AttachmentSpec[] | undefined): Array<{
  filename: string;
  contentType: string;
  content: Uint8Array;
  encoding: 'base64';
  contentDisposition: 'inline';
  contentID: string;
}> {
  if (!specs || specs.length === 0) return [];
  const out: ReturnType<typeof decodeAttachments> = [];
  for (const a of specs) {
    let bin: string;
    try {
      bin = atob(a.content_b64);
    } catch {
      throw new Error(`attachment ${a.filename} has invalid base64`);
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.push({
      filename: a.filename,
      contentType: a.mime_type,
      content: bytes,
      encoding: 'base64',
      contentDisposition: 'inline',
      contentID: a.content_id,
    });
  }
  return out;
}

// --- Hand-rolled SMTP -------------------------------------------------------
//
// We speak SMTP over Deno.connect + Deno.startTls instead of pulling
// denomailer or nodemailer. Adding a third-party SMTP library to the
// edge-function bundle pushed cold-start past Supabase's 12s gateway
// timeout and produced sporadic 503s on first send. Hand-rolling keeps
// cold-start at zero added cost and keeps the auth path readable.
//
// Flow: connect → read greeting (220) → EHLO → STARTTLS → upgrade TLS
// → EHLO (again) → AUTH PLAIN → MAIL FROM → RCPT TO (each) → DATA →
// payload → "." → QUIT. Per-command timeout via AbortSignal.

function readLineFromBuffer(buf: Uint8Array): { line: string; rest: Uint8Array } | null {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      const line = new TextDecoder('latin1').decode(buf.slice(0, i));
      const rest = buf.slice(i + 2);
      return { line, rest };
    }
  }
  return null;
}

// Race a promise against a wall-clock timeout. Deno's Conn read/write/connect
// don't accept AbortSignal, so this is the only way to bound an operation.
// On timeout, the underlying conn is left dangling — caller must close().
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

class SmtpConnection {
  private buffer: Uint8Array = new Uint8Array(0);
  constructor(
    private conn: Deno.Conn,
    private timeoutMs: number,
  ) {}

  static async connect(host: string, port: number, timeoutMs: number): Promise<SmtpConnection> {
    const conn = await withTimeout(
      Deno.connect({ hostname: host, port }),
      timeoutMs,
      'smtp connect',
    );
    return new SmtpConnection(conn, SMTP_COMMAND_TIMEOUT_MS);
  }

  async upgradeTls(host: string): Promise<void> {
    // RFC 3207: after STARTTLS, the buffer must be flushed and a fresh
    // TLS handshake performed. We discard any bytes pipelined past the
    // STARTTLS response — Apple doesn't pipeline, but defensively this
    // closes a known TLS-stripping vector.
    this.buffer = new Uint8Array(0);
    this.conn = await withTimeout(
      Deno.startTls(this.conn as Deno.TcpConn, { hostname: host }),
      this.timeoutMs,
      'starttls',
    );
  }

  async write(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let off = 0;
    while (off < bytes.length) {
      const n = await withTimeout(
        this.conn.write(bytes.subarray(off)),
        this.timeoutMs,
        'smtp write',
      );
      if (n <= 0) throw new Error('socket closed during write');
      off += n;
    }
  }

  async readLine(): Promise<string> {
    while (true) {
      const got = readLineFromBuffer(this.buffer);
      if (got) {
        this.buffer = got.rest;
        return got.line;
      }
      const chunk = new Uint8Array(4096);
      const n = await withTimeout(this.conn.read(chunk), this.timeoutMs, 'smtp read');
      if (n === null) throw new Error('connection closed by server');
      const next = new Uint8Array(this.buffer.length + n);
      next.set(this.buffer, 0);
      next.set(chunk.subarray(0, n), this.buffer.length);
      this.buffer = next;
    }
  }

  // SMTP responses can be multi-line: intermediate lines start with
  // "<code>-", the final line with "<code> ". Returns the numeric code and
  // the joined message text (last line wins for the textual payload, but
  // keeping all lines makes errors more diagnosable).
  async readResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      // First three chars are the numeric code; char 4 is '-' (continuation)
      // or ' ' (final line).
      if (line.length < 4) throw new Error(`malformed smtp response: ${line}`);
      const sep = line.charAt(3);
      if (sep === ' ') {
        const code = parseInt(line.slice(0, 3), 10);
        if (!Number.isFinite(code)) throw new Error(`malformed smtp code: ${line}`);
        return { code, lines };
      }
      if (sep !== '-') throw new Error(`malformed smtp response: ${line}`);
    }
  }

  async close(): Promise<void> {
    try { this.conn.close(); } catch { /* ignore */ }
  }
}

async function sendViaSmtp(args: {
  email: string;
  password: string;
  rcptTo: string[];   // envelope recipients (to + cc, deduplicated)
  rfc5322: Uint8Array;
}): Promise<SmtpResult> {
  const t0 = Date.now();
  let conn: SmtpConnection | null = null;
  try {
    console.log('[smtp] connect start');
    try {
      conn = await SmtpConnection.connect(SMTP_HOST, SMTP_PORT, SMTP_CONNECT_TIMEOUT_MS);
      console.log('[smtp] connected', { elapsed_ms: Date.now() - t0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[smtp] connect failed', msg);
      if (/abort|timeout/i.test(msg)) return { ok: false, code: 'timeout', detail: msg };
      return { ok: false, code: 'network', detail: msg };
    }

    const expect = async (
      okCodes: number[],
    ): Promise<{ ok: true; code: number; lines: string[] } | { ok: false; result: SmtpResult }> => {
      try {
        const r = await conn!.readResponse();
        if (okCodes.includes(r.code)) return { ok: true, code: r.code, lines: r.lines };
        // Auth failures are 535 (or sometimes 530/534/538). Treat anything
        // 5xx during AUTH PLAIN as auth-failed — the caller knows context.
        if (r.code === 535 || r.code === 534 || r.code === 538 || r.code === 530) {
          return { ok: false, result: { ok: false, code: 'auth-failed', detail: r.lines.join(' | ') } };
        }
        return { ok: false, result: { ok: false, code: 'protocol', detail: `${r.code} ${r.lines.join(' | ')}`.slice(0, 200) } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/abort|timeout/i.test(msg)) return { ok: false, result: { ok: false, code: 'timeout', detail: msg } };
        return { ok: false, result: { ok: false, code: 'network', detail: msg } };
      }
    };

    // Greeting
    const greet = await expect([220]);
    if (!greet.ok) { console.warn('[smtp] greeting failed', greet.result); return greet.result; }
    console.log('[smtp] greeting ok', { elapsed_ms: Date.now() - t0 });

    // EHLO. The hostname Zolva announces is informational; Apple doesn't
    // verify it. "zolva.io" matches the org domain in case anyone audits.
    await conn.write('EHLO zolva.io\r\n');
    const ehlo1 = await expect([250]);
    if (!ehlo1.ok) { console.warn('[smtp] EHLO1 failed', ehlo1.result); return ehlo1.result; }

    // STARTTLS — only attempt if the server advertised it (it always
    // does on 587 for Apple, but check defensively).
    if (!ehlo1.lines.some((l) => /STARTTLS/i.test(l))) {
      console.warn('[smtp] STARTTLS not advertised', ehlo1.lines);
      return { ok: false, code: 'protocol', detail: 'server does not support STARTTLS' };
    }
    await conn.write('STARTTLS\r\n');
    const startTlsResp = await expect([220]);
    if (!startTlsResp.ok) { console.warn('[smtp] STARTTLS rejected', startTlsResp.result); return startTlsResp.result; }
    try {
      await conn.upgradeTls(SMTP_HOST);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[smtp] TLS upgrade failed', msg);
      return { ok: false, code: 'network', detail: `STARTTLS upgrade failed: ${msg.slice(0, 150)}` };
    }
    console.log('[smtp] tls upgraded', { elapsed_ms: Date.now() - t0 });

    // EHLO again on the encrypted channel. Required by the spec; some
    // servers reject auth without it.
    await conn.write('EHLO zolva.io\r\n');
    const ehlo2 = await expect([250]);
    if (!ehlo2.ok) { console.warn('[smtp] EHLO2 failed', ehlo2.result); return ehlo2.result; }

    // AUTH PLAIN — payload is base64 of "\0username\0password". This is
    // the standard mechanism Apple's iCloud SMTP accepts for app-specific
    // passwords.
    const authBlob = btoa(`\0${args.email}\0${args.password}`);
    await conn.write(`AUTH PLAIN ${authBlob}\r\n`);
    const auth = await expect([235]);
    if (!auth.ok) { console.warn('[smtp] AUTH failed', auth.result); return auth.result; }
    console.log('[smtp] auth ok', { elapsed_ms: Date.now() - t0 });

    // MAIL FROM. Apple requires the envelope sender to match the
    // authenticated user (or one of their aliases). v1 always uses the
    // auth email.
    await conn.write(`MAIL FROM:<${args.email}>\r\n`);
    const mailFrom = await expect([250]);
    if (!mailFrom.ok) { console.warn('[smtp] MAIL FROM rejected', mailFrom.result); return mailFrom.result; }

    // RCPT TO — once per recipient. If any one is rejected, the whole
    // send fails — partial-recipient acceptance produces a confusing UX
    // (some recipients get the mail, some don't, and the user sees only
    // a single status string).
    for (const rcpt of args.rcptTo) {
      await conn.write(`RCPT TO:<${rcpt}>\r\n`);
      const r = await expect([250, 251]);
      if (!r.ok) { console.warn('[smtp] RCPT rejected', { rcpt, result: r.result }); return r.result; }
    }

    // DATA — server replies 354, then we send the message followed by
    // the bare-line "." terminator. We must dot-stuff: any line in the
    // payload that starts with "." gets an extra "." prepended (the
    // server strips one back off when delivering).
    await conn.write('DATA\r\n');
    const dataResp = await expect([354]);
    if (!dataResp.ok) { console.warn('[smtp] DATA rejected', dataResp.result); return dataResp.result; }

    const payload = dotStuffMessage(args.rfc5322);
    await conn.write(payload);
    await conn.write('\r\n.\r\n');
    const sent = await expect([250]);
    if (!sent.ok) { console.warn('[smtp] DATA payload rejected', sent.result); return sent.result; }
    console.log('[smtp] payload accepted', { elapsed_ms: Date.now() - t0 });

    // Best-effort QUIT. We ignore the response — message is already
    // delivered at this point.
    try {
      await conn.write('QUIT\r\n');
      await conn.readResponse();
    } catch { /* ignore */ }

    return { ok: true };
  } finally {
    if (conn) await conn.close();
  }
}

// Dot-stuff per RFC 5321 §4.5.2: any line in the message body that begins
// with a "." gets an extra "." prepended so the standalone "." terminator
// stays unambiguous. Operates on the raw RFC 5322 bytes.
function dotStuffMessage(bytes: Uint8Array): Uint8Array {
  // Walk byte-by-byte, look for "\r\n." and insert "." after the CRLF.
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (
      bytes[i] === 0x0a && // LF
      i >= 1 && bytes[i - 1] === 0x0d && // CR before
      i + 1 < bytes.length && bytes[i + 1] === 0x2e // dot after
    ) {
      out.push(0x2e); // extra dot
    }
  }
  // Edge: if the very first byte is '.', dot-stuff that too.
  if (bytes.length > 0 && bytes[0] === 0x2e) {
    out.unshift(0x2e);
  }
  return new Uint8Array(out);
}

// --- clear-binding ----------------------------------------------------------
//
// Lets the user wipe their own binding row so a fresh app-specific password
// can bind on the next list-inbox call. Without this, rotating the password
// on Apple's side leaves the user locked out (the new password's hash
// mismatches the bound hash → auth-failed) until the 90-day cron sweep.
async function handleClearBinding(
  userId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { error } = await svc
    .from('icloud_credential_bindings')
    .delete()
    .eq('user_id', userId);
  if (error) {
    console.warn('[imap-proxy] clear-binding delete failed:', error.message);
    return err('internal', 500);
  }
  return Response.json({ ok: true });
}

type ThreadingHeaders = {
  inReplyTo?: string;
  references?: string;
};

async function fetchThreadingHeaders(
  email: string,
  password: string,
  uid: number,
): Promise<ThreadingHeaders> {
  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const meta = await client.fetchOne(
        String(uid),
        { envelope: true, headers: ['references'] },
        { uid: true },
      );
      const messageId = (meta?.envelope as { messageId?: string } | undefined)?.messageId ?? '';
      // imapflow returns headers as a Map<string, string[]> when requested by name.
      const refsHeader = meta?.headers
        ? (meta.headers as Map<string, string[]>).get('references')?.join(' ').trim() ?? ''
        : '';
      const inReplyTo = messageId || undefined;
      const references = refsHeader
        ? `${refsHeader}${messageId ? ' ' + messageId : ''}`.trim()
        : (messageId || undefined);
      return { inReplyTo, references };
    } finally {
      try { lock.release(); } catch { /* secondary */ }
    }
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
      if (client.usable) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }
}

// --- RFC 5322 builder helpers -----------------------------------------------
//
// Single source of truth for the wire-format bytes. Same output goes to
// SMTP DATA and the post-success Sent-folder APPEND, so the recipient's
// inbox copy and the sender's Sent copy are guaranteed byte-identical.

type AppendableMessage = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  contentType: 'text' | 'html';
  content: string;
  attachments: ReturnType<typeof decodeAttachments>;
  threading: ThreadingHeaders;
  date: Date;
};

function encodeMimeWord(s: string): string {
  // RFC 2047 Q-encoded mime word. Only encodes when non-ASCII bytes are
  // present; ASCII-only strings pass through to keep the wire format clean.
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  let out = '=?UTF-8?Q?';
  for (const b of bytes) {
    if (b === 0x20) out += '_';
    else if (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f) out += String.fromCharCode(b);
    else out += '=' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out + '?=';
}

function rfc5322Date(d: Date): string {
  // Sun, 06 May 2026 18:32:00 +0000
  return d.toUTCString().replace(/GMT$/, '+0000');
}

function buildBoundary(): string {
  return '----=_zolva_' + crypto.randomUUID().replace(/-/g, '');
}

function quotedPrintable(s: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  let out = '';
  let lineLen = 0;
  for (const b of bytes) {
    let token: string;
    if (b === 0x0a) { out += '\r\n'; lineLen = 0; continue; }
    if (b === 0x0d) continue; // strip lone CR
    if (b === 0x20 || b === 0x09) {
      // Space/tab — needs encoding only at line end; simplest correct
      // implementation: leave as-is here, soft-line-break rules below
      // ensure we never end a line on whitespace.
      token = String.fromCharCode(b);
    } else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) {
      token = String.fromCharCode(b);
    } else {
      token = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (lineLen + token.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += token;
    lineLen += token.length;
  }
  return out;
}

function base64Wrap(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildRfc5322(msg: AppendableMessage): Uint8Array {
  const headers: string[] = [];
  headers.push(`From: ${msg.from}`);
  headers.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc && msg.cc.length > 0) headers.push(`Cc: ${msg.cc.join(', ')}`);
  headers.push(`Subject: ${encodeMimeWord(msg.subject)}`);
  headers.push(`Date: ${rfc5322Date(msg.date)}`);
  headers.push(`MIME-Version: 1.0`);
  if (msg.threading.inReplyTo) headers.push(`In-Reply-To: ${msg.threading.inReplyTo}`);
  if (msg.threading.references) headers.push(`References: ${msg.threading.references}`);

  const bodyType = msg.contentType === 'html' ? 'text/html' : 'text/plain';
  if (msg.attachments.length === 0) {
    // Single-part message
    headers.push(`Content-Type: ${bodyType}; charset=UTF-8`);
    headers.push(`Content-Transfer-Encoding: quoted-printable`);
    const body = quotedPrintable(msg.content);
    return new TextEncoder().encode(headers.join('\r\n') + '\r\n\r\n' + body);
  }

  // multipart/related so Apple Mail renders cid: images inline
  const boundary = buildBoundary();
  headers.push(`Content-Type: multipart/related; boundary="${boundary}"; type="${bodyType}"`);

  let body = '';
  body += `--${boundary}\r\n`;
  body += `Content-Type: ${bodyType}; charset=UTF-8\r\n`;
  body += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
  body += quotedPrintable(msg.content) + '\r\n';

  for (const a of msg.attachments) {
    body += `--${boundary}\r\n`;
    body += `Content-Type: ${a.contentType}\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n`;
    body += `Content-ID: <${a.contentID}>\r\n`;
    body += `Content-Disposition: inline; filename="${a.filename}"\r\n\r\n`;
    body += base64Wrap(bytesToBase64(a.content)) + '\r\n';
  }
  body += `--${boundary}--\r\n`;

  return new TextEncoder().encode(headers.join('\r\n') + '\r\n\r\n' + body);
}

// --- appendToSent -----------------------------------------------------------
//
// Opens a fresh IMAP connection, resolves the Sent folder, and APPENDs the
// raw RFC 5322 message with the \Seen flag. All failures are logged and
// swallowed — the SMTP send is what counts.
async function appendToSent(
  email: string,
  password: string,
  rawMessage: Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    // Resolve the Sent folder. iCloud uses 'Sent Messages'; some accounts
    // localize. Try the Apple default first, then standard 'Sent', then
    // any folder reported with the \Sent special-use flag.
    const candidates = ['Sent Messages', 'Sent'];
    let sentPath: string | null = null;
    for (const name of candidates) {
      try {
        const status = await client.status(name, { messages: true });
        if (status) { sentPath = name; break; }
      } catch { /* not present, try next */ }
    }
    if (!sentPath) {
      const list = await client.list();
      for (const f of list) {
        const flags = (f as { specialUse?: string }).specialUse;
        if (flags === '\\Sent') { sentPath = f.path; break; }
      }
    }
    if (!sentPath) {
      return { ok: false, reason: 'sent-folder-not-found' };
    }
    await client.append(sentPath, rawMessage, ['\\Seen']);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* ignore */ }
      if (client.usable) {
        try { await client.close(); } catch { /* ignore */ }
      }
    }
  }
}

async function handleSendMail(
  body: SendMailReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  try {
    return await handleSendMailInner(body, userId, pepper, supabaseUrl, serviceKey);
  } catch (e) {
    const stack = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    console.error('[send-mail] UNCAUGHT', stack);
    return err('protocol', 502, `uncaught: ${stack.slice(0, 240)}`);
  }
}

async function handleSendMailInner(
  body: SendMailReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const t0 = Date.now();
  console.log('[send-mail] start', { user: userId.slice(0, 8), to_count: body.to?.length ?? 0, has_cc: !!body.cc, ct: body.content_type, has_reply: typeof body.reply_to_uid === 'number' });
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();

  // Same binding-check posture as list-inbox: row must exist and hash must match.
  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[send-mail] binding read failed', bindReadErr.message);
    return err('internal', 500);
  }
  if (!existing || existing.credential_hash !== hash) {
    console.warn('[send-mail] binding mismatch — auth-failed');
    return err('auth-failed', 422);
  }
  console.log('[send-mail] binding ok', `+${Date.now() - t0}ms`);

  // Decode signature attachments before opening SMTP — bad base64 should fail
  // fast without burning a connect-attempt to Apple.
  let attachments: ReturnType<typeof decodeAttachments>;
  try {
    attachments = decodeAttachments(body.attachments);
  } catch (e) {
    return err('bad-request', 400, e instanceof Error ? e.message : String(e));
  }
  console.log('[send-mail] attachments decoded', { count: attachments.length });

  let threading: ThreadingHeaders = {};
  if (typeof body.reply_to_uid === 'number' && Number.isFinite(body.reply_to_uid)) {
    try {
      threading = await fetchThreadingHeaders(email, password, body.reply_to_uid);
    } catch (e) {
      console.warn('[send-mail] threading-header fetch failed (continuing without):', e instanceof Error ? e.message : String(e));
    }
  }

  // Build the RFC 5322 message ONCE — same bytes go to SMTP DATA and the
  // post-success Sent-folder APPEND. Guarantees the recipient and the
  // sender's Sent copy are byte-identical.
  const raw = buildRfc5322({
    from: email,
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    contentType: body.content_type,
    content: body.content,
    attachments,
    threading,
    date: new Date(),
  });
  console.log('[send-mail] rfc5322 built', { bytes: raw.length, elapsed_ms: Date.now() - t0 });

  // Envelope recipients = to + cc (deduplicated, normalized). Bcc is
  // explicitly out of scope for v1.
  const rcptTo = Array.from(new Set([
    ...toAddressList(body.to),
    ...(body.cc ? toAddressList(body.cc) : []),
  ]));

  console.log('[send-mail] starting smtp', { rcpt_count: rcptTo.length, elapsed_ms: Date.now() - t0 });
  const smtpResult = await sendViaSmtp({ email, password, rcptTo, rfc5322: raw });
  console.log('[send-mail] smtp done', {
    ok: smtpResult.ok,
    code: smtpResult.ok ? null : smtpResult.code,
    detail: smtpResult.ok ? null : smtpResult.detail?.slice(0, 200),
    elapsed_ms: Date.now() - t0,
  });
  if (!smtpResult.ok) return smtpResultToResponse(smtpResult);

  // Best-effort APPEND to Sent. Logged-only on failure.
  const append = await appendToSent(email, password, raw);
  if (!append.ok) {
    console.warn('[imap-proxy] send-mail APPEND to Sent failed:', append.reason);
  }
  return Response.json({ ok: true, sent_appended: append.ok });
}

async function handleAppendDraft(
  body: AppendDraftReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const password = normalizePassword(body.password);
  const email = body.email.trim().toLowerCase();

  const hash = await hashCredential(pepper, email, password);
  const svc = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: existing, error: bindReadErr } = await svc
    .from('icloud_credential_bindings')
    .select('credential_hash')
    .eq('user_id', userId)
    .maybeSingle();
  if (bindReadErr) {
    console.warn('[imap-proxy] append-draft binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (!existing || existing.credential_hash !== hash) {
    return err('auth-failed', 422);
  }

  let attachments: ReturnType<typeof decodeAttachments>;
  try {
    attachments = decodeAttachments(body.attachments);
  } catch (e) {
    return err('bad-request', 400, e instanceof Error ? e.message : String(e));
  }

  let threading: ThreadingHeaders = {};
  if (typeof body.reply_to_uid === 'number' && Number.isFinite(body.reply_to_uid)) {
    try {
      threading = await fetchThreadingHeaders(email, password, body.reply_to_uid);
    } catch (e) {
      console.warn('[imap-proxy] append-draft threading-header fetch failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const raw = buildRfc5322({
    from: email,
    to: body.to,
    cc: body.cc,
    subject: body.subject,
    contentType: body.content_type,
    content: body.content,
    attachments,
    threading,
    date: new Date(),
  });

  let client: ImapFlow | null = null;
  try {
    client = await newImapClient(email, password);
    await client.connect();
    // Resolve Drafts folder. iCloud's standard is 'Drafts'.
    let draftsPath: string | null = null;
    try {
      await client.status('Drafts', { messages: true });
      draftsPath = 'Drafts';
    } catch { /* not present, try special-use */ }
    if (!draftsPath) {
      const list = await client.list();
      for (const f of list) {
        const flags = (f as { specialUse?: string }).specialUse;
        if (flags === '\\Drafts') { draftsPath = f.path; break; }
      }
    }
    if (!draftsPath) {
      return err('protocol', 502, 'drafts-folder-not-found');
    }
    await client.append(draftsPath, raw, ['\\Draft']);
    await client.logout();
    return Response.json({ ok: true });
  } catch (caughtErr) {
    return mapImapError(caughtErr);
  } finally {
    if (client && client.usable) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
