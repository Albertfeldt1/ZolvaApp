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
const RATE_LIMIT_GET_BODY = 120;    // per hour per user (one fetch per opened mail)

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
// clear-binding doesn't need email/password — the JWT identifies the user
// and the binding row is keyed by user_id. Email/password fields are
// optional/ignored to keep the request shape uniform with the other ops.
type ClearBindingReq = {
  op: 'clear-binding';
  email?: string;
  password?: string;
};
type Req = ValidateReq | ListInboxReq | GetBodyReq | ClearBindingReq;

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
    (body.op !== 'validate' && body.op !== 'list-inbox' && body.op !== 'get-body' && body.op !== 'clear-binding')
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
  if (body.op === 'clear-binding') {
    return await handleClearBinding(userId, supabaseUrl, serviceKey);
  }
  return err('bad-request', 400);
});

async function checkRateLimit(
  serviceKey: string,
  supabaseUrl: string,
  userId: string,
  op: 'validate' | 'list-inbox' | 'get-body' | 'clear-binding',
): Promise<boolean> {
  // clear-binding doesn't need rate limiting — the JWT already authorizes,
  // and a malicious user can only delete their OWN row. Skipping the check
  // also means disconnect-then-reconnect doesn't false-trigger the limit.
  if (op === 'clear-binding') return true;
  const limit =
    op === 'validate'
      ? RATE_LIMIT_VALIDATE
      : op === 'list-inbox'
      ? RATE_LIMIT_LIST_INBOX
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
    client = newImapClient(email, password);
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

function newImapClient(email: string, password: string): ImapFlow {
  return new ImapFlow({
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

  // Capture as much context as ImapFlow exposes so the next 'protocol' error
  // is diagnosable from the function logs without repro on the client.
  const errObj = caughtErr as {
    name?: string;
    code?: string;
    response?: string;
    serverResponseCode?: string;
    responseStatus?: string;
    authenticationFailed?: boolean;
  } | null;
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
    client = newImapClient(email, password);
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
    client = newImapClient(email, password);
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
