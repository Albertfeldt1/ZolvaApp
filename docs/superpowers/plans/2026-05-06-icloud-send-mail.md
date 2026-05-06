# iCloud Send & Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let iCloud-only users send mail and create drafts from the chat agent. The `create_draft` and `send_mail` tools accept `provider: 'icloud'` and route through new `imap-proxy` edge-function ops (`send-mail`, `append-draft`).

**Architecture:** Two new ops on `imap-proxy` use denomailer for SMTP send (`smtp.mail.me.com:587` STARTTLS) and `imapflow` for IMAP `APPEND` to the Sent / Drafts folders. Client wrappers `icloudSendMail` / `icloudAppendDraft` call `buildOutgoingBody` (existing rich-signature pipeline) before posting to the proxy. Server changes commit and deploy first; client changes ship via OTA after.

**Tech Stack:** Deno + Supabase Edge Functions, `denomailer@1.6.0`, `imapflow@1.3.2`, TypeScript (React Native / Expo), existing `mail-signature/` pipeline.

**Spec:** [docs/superpowers/specs/2026-05-06-icloud-send-mail-design.md](../specs/2026-05-06-icloud-send-mail-design.md)

**Testing reality:** This codebase has no automated test harness for the edge function or the chat-tools layer (matches existing iCloud / Gmail / Outlook code). Verification is manual E2E per the spec. Each task ends with a concrete manual check, not an automated test run.

---

## File structure

| File | Change |
|---|---|
| `supabase/functions/imap-proxy/deno.json` | modify — add `denomailer` import |
| `supabase/functions/imap-proxy/index.ts` | modify — add `send-mail` and `append-draft` ops, rate-limit constants, dispatcher branches |
| `src/lib/icloud-mail.ts` | modify — widen `call()` op union, add `icloudSendMail` / `icloudAppendDraft`, cache-invalidate on success |
| `src/lib/hooks.ts` | modify — schema enums, type widening, `mapIcloudComposeError`, iCloud branch in `runMailComposeTool`, system-prompt cleanup |

No new files. The two iCloud client functions live in the existing `icloud-mail.ts` next to `validate`, `listInbox`, `getMessageBody`, etc.

---

## Phase 1 — Server (`imap-proxy`)

Per project memory: server changes get their own commit and deploy FIRST, before client OTA. Phase 1 ends with a deployed function; client work in Phase 2/3 cannot start until Phase 1 is live.

### Task 1: Add denomailer import to deno.json

**Files:**
- Modify: `supabase/functions/imap-proxy/deno.json`

- [ ] **Step 1: Edit `deno.json` to include denomailer**

```json
{
  "imports": {
    "imapflow": "npm:imapflow@1.3.2",
    "denomailer": "https://deno.land/x/denomailer@1.6.0/mod.ts"
  }
}
```

- [ ] **Step 2: Verify deno can resolve the module**

Run from repo root:

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: any errors are about TYPE references (we haven't added the import yet) or pre-existing — no module-resolution failures for `denomailer`.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/imap-proxy/deno.json
git commit -m "feat(imap-proxy): add denomailer dependency for SMTP send"
```

---

### Task 2: Add request types and rate-limit constants

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts:39-77` (constants and types section)

- [ ] **Step 1: Add rate-limit constants below `RATE_LIMIT_GET_BODY`**

Find this block (around line 43-45):

```ts
const RATE_LIMIT_VALIDATE = 10;     // per hour per user
const RATE_LIMIT_LIST_INBOX = 60;   // per hour per user
const RATE_LIMIT_GET_BODY = 120;    // per hour per user (one fetch per opened mail)
```

Replace with:

```ts
const RATE_LIMIT_VALIDATE = 10;       // per hour per user
const RATE_LIMIT_LIST_INBOX = 60;     // per hour per user
const RATE_LIMIT_GET_BODY = 120;      // per hour per user (one fetch per opened mail)
const RATE_LIMIT_SEND_MAIL = 30;      // per hour per user — under Apple SMTP per-account throttle
const RATE_LIMIT_APPEND_DRAFT = 60;   // per hour per user — cheap IMAP APPEND, shares list-inbox order of magnitude
```

- [ ] **Step 2: Add request types after the existing `PingReq` (around line 76)**

Find:

```ts
type PingReq = { op: 'ping' };
type Req = ValidateReq | ListInboxReq | GetBodyReq | CountReq | ClearBindingReq | PingReq;
```

Insert before the `Req` union:

```ts
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
```

And widen the `Req` union:

```ts
type Req =
  | ValidateReq
  | ListInboxReq
  | GetBodyReq
  | CountReq
  | ClearBindingReq
  | PingReq
  | SendMailReq
  | AppendDraftReq;
```

- [ ] **Step 3: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: any errors are unrelated to the new types (the dispatcher in Task 7 will resolve "unhandled op" warnings).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): add send-mail and append-draft request types"
```

---

### Task 3: Implement minimal `handleSendMail` (SMTP only, no threading, no APPEND)

This task ships a working SMTP-send path. Threading and Sent-folder APPEND come in Tasks 4 and 5.

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts` — append after `handleClearBinding` (after line 889)

- [ ] **Step 1: Add the lazy denomailer loader near the top of the file (after `getImapFlow`, around line 37)**

```ts
let _SmtpClientCtor: typeof import('denomailer').SMTPClient | null = null;
async function getSmtpClient(): Promise<typeof import('denomailer').SMTPClient> {
  if (_SmtpClientCtor) return _SmtpClientCtor;
  const mod = await import('denomailer');
  _SmtpClientCtor = mod.SMTPClient;
  return _SmtpClientCtor;
}
const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;
```

- [ ] **Step 2: Add `decodeAttachments` and `formatAddressList` helpers near the bottom, before `handleClearBinding`**

```ts
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

// Map "Niels Hansen <niels@example.com>" or "niels@example.com" into the
// shape denomailer accepts. Bare addresses pass through unchanged.
function toAddressList(addrs: string[]): string[] {
  return addrs.map((a) => a.trim()).filter((a) => a.length > 0);
}
```

- [ ] **Step 3: Add `handleSendMail` (minimal version — no threading, no APPEND yet)**

```ts
async function handleSendMail(
  body: SendMailReq,
  userId: string,
  pepper: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
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
    console.warn('[imap-proxy] send-mail binding read failed:', bindReadErr.message);
    return err('internal', 500);
  }
  if (!existing || existing.credential_hash !== hash) {
    return err('auth-failed', 422);
  }

  // Decode signature attachments before opening SMTP — bad base64 should fail
  // fast without burning a connect-attempt to Apple.
  let attachments: ReturnType<typeof decodeAttachments>;
  try {
    attachments = decodeAttachments(body.attachments);
  } catch (e) {
    return err('bad-request', 400, e instanceof Error ? e.message : String(e));
  }

  const SMTPClient = await getSmtpClient();
  const client = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port: SMTP_PORT,
      tls: false, // STARTTLS upgrade — denomailer handles it via `tls: false` on 587
      auth: { username: email, password },
    },
  });

  try {
    const sendOpts: Parameters<typeof client.send>[0] = {
      from: email,
      to: toAddressList(body.to),
      cc: body.cc ? toAddressList(body.cc) : undefined,
      subject: body.subject,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    if (body.content_type === 'html') {
      sendOpts.html = body.content;
    } else {
      sendOpts.content = body.content;
    }
    await client.send(sendOpts);
  } catch (e) {
    return mapSmtpError(e);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }

  return Response.json({ ok: true, sent_appended: false });
}
```

- [ ] **Step 4: Add `mapSmtpError` near `mapImapError` (around line 308)**

```ts
function mapSmtpError(caughtErr: unknown): Response {
  const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
  // denomailer throws with various shapes — match by message content as it
  // doesn't expose structured error codes the way imapflow does.
  if (/535|authentication failed|auth.*failed/i.test(msg)) {
    return err('auth-failed', 422);
  }
  if (/AbortError|aborted|timeout/i.test(msg)) {
    return err('timeout', 504);
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|TLS/i.test(msg)) {
    return err('network', 503);
  }
  if (/4\d\d|5\d\d|smtp/i.test(msg)) {
    // 4xx/5xx SMTP responses — recipient rejected, message too large, etc.
    return err('protocol', 502, msg.slice(0, 200));
  }
  console.warn('[imap-proxy] unmapped smtp error:', msg);
  return err('protocol', 502, msg.slice(0, 200));
}
```

- [ ] **Step 5: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: clean (no errors related to the new code).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): add minimal SMTP send handler"
```

---

### Task 4: Add reply-threading IMAP fetch to `handleSendMail`

When `reply_to_uid` is set, fetch the original message's `Message-ID` and `References` headers via IMAP and add them to the outgoing envelope. Failure-soft: any IMAP error here logs and proceeds without threading.

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts` — `handleSendMail`

- [ ] **Step 1: Add the helper that fetches threading headers**

Insert before `handleSendMail`:

```ts
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
```

- [ ] **Step 2: Wire threading into `handleSendMail`**

Replace the `try { ... await client.send(sendOpts); ... }` block with one that adds headers when `reply_to_uid` is set:

```ts
  let threading: ThreadingHeaders = {};
  if (typeof body.reply_to_uid === 'number' && Number.isFinite(body.reply_to_uid)) {
    try {
      threading = await fetchThreadingHeaders(email, password, body.reply_to_uid);
    } catch (e) {
      console.warn('[imap-proxy] send-mail threading-header fetch failed (continuing without):', e instanceof Error ? e.message : String(e));
    }
  }

  try {
    const sendOpts: Parameters<typeof client.send>[0] = {
      from: email,
      to: toAddressList(body.to),
      cc: body.cc ? toAddressList(body.cc) : undefined,
      subject: body.subject,
      attachments: attachments.length > 0 ? attachments : undefined,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
    };
    if (body.content_type === 'html') {
      sendOpts.html = body.content;
    } else {
      sendOpts.content = body.content;
    }
    await client.send(sendOpts);
  } catch (e) {
    return mapSmtpError(e);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
```

- [ ] **Step 3: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: clean. If `inReplyTo` / `references` fields aren't on `client.send`'s argument type, denomailer accepts them on `internalTag` / extra-headers — fall back to:

```ts
extInternalTag: undefined,
internalTag: undefined,
// fallback: pass via headers field
headers: threading.inReplyTo
  ? {
      'In-Reply-To': threading.inReplyTo,
      ...(threading.references ? { References: threading.references } : {}),
    }
  : undefined,
```

(Verify in the denomailer source which approach the `1.6.0` API supports — both shapes have shipped historically. The `headers` map fallback is always safe.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): thread iCloud replies via In-Reply-To/References"
```

---

### Task 5: Best-effort `APPEND` of sent message to Sent folder

After SMTP send succeeds, open a fresh IMAP connection, find the Sent folder, APPEND the same message. All failures here are logged and swallowed — the SMTP send is what counts.

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts`

- [ ] **Step 1: Add helper to build the raw RFC 5322 bytes**

denomailer doesn't expose its message-builder for IMAP APPEND, so we reconstruct a minimal RFC 5322 message ourselves. Insert before `handleSendMail`:

```ts
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
```

- [ ] **Step 2: Add the Sent-folder APPEND helper**

```ts
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
```

- [ ] **Step 3: Wire APPEND into `handleSendMail` after a successful SMTP send**

Replace the closing block of `handleSendMail` (the part after the `try { ... await client.send(sendOpts); ... }` finishes successfully). The full updated function body becomes:

```ts
  let threading: ThreadingHeaders = {};
  if (typeof body.reply_to_uid === 'number' && Number.isFinite(body.reply_to_uid)) {
    try {
      threading = await fetchThreadingHeaders(email, password, body.reply_to_uid);
    } catch (e) {
      console.warn('[imap-proxy] send-mail threading-header fetch failed (continuing without):', e instanceof Error ? e.message : String(e));
    }
  }

  let sendError: unknown = null;
  try {
    const sendOpts: Parameters<typeof client.send>[0] = {
      from: email,
      to: toAddressList(body.to),
      cc: body.cc ? toAddressList(body.cc) : undefined,
      subject: body.subject,
      attachments: attachments.length > 0 ? attachments : undefined,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
    };
    if (body.content_type === 'html') {
      sendOpts.html = body.content;
    } else {
      sendOpts.content = body.content;
    }
    await client.send(sendOpts);
  } catch (e) {
    sendError = e;
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
  if (sendError) return mapSmtpError(sendError);

  // Best-effort APPEND to Sent. Logged-only on failure.
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
  const append = await appendToSent(email, password, raw);
  if (!append.ok) {
    console.warn('[imap-proxy] send-mail APPEND to Sent failed:', append.reason);
  }
  return Response.json({ ok: true, sent_appended: append.ok });
```

- [ ] **Step 4: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): APPEND sent iCloud mail to Sent folder (best-effort)"
```

---

### Task 6: Implement `handleAppendDraft`

Build the same RFC 5322 message via `buildRfc5322`, but APPEND to the Drafts folder with the `\Draft` flag instead of sending via SMTP.

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts`

- [ ] **Step 1: Add `handleAppendDraft` after `handleSendMail`**

```ts
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
```

- [ ] **Step 2: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): add append-draft handler for iCloud Drafts folder"
```

---

### Task 7: Wire ops into the dispatcher, body validation, and rate limiter

**Files:**
- Modify: `supabase/functions/imap-proxy/index.ts:149-194` (dispatcher) and lines around 200 (rate-limit signature) and 159 (body validation)

- [ ] **Step 1: Widen the dispatch op-allowlist (around line 149)**

Find:

```ts
  if (
    !body ||
    (body.op !== 'validate' &&
      body.op !== 'list-inbox' &&
      body.op !== 'get-body' &&
      body.op !== 'count' &&
      body.op !== 'clear-binding')
  ) {
    return err('bad-request', 400);
  }
```

Replace with:

```ts
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
```

- [ ] **Step 2: Widen the email/password requirement check (around line 159)**

Find:

```ts
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
```

Body-shape validation for the new ops needs more — add right after the existing block:

```ts
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
```

- [ ] **Step 3: Update `checkRateLimit` signature and implementation**

Find (around line 200):

```ts
async function checkRateLimit(
  serviceKey: string,
  supabaseUrl: string,
  userId: string,
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding',
): Promise<boolean> {
```

Replace with:

```ts
async function checkRateLimit(
  serviceKey: string,
  supabaseUrl: string,
  userId: string,
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
): Promise<boolean> {
```

Inside the function, replace the limit selection:

```ts
  const limit =
    op === 'validate'
      ? RATE_LIMIT_VALIDATE
      : op === 'list-inbox' || op === 'count'
      ? RATE_LIMIT_LIST_INBOX
      : RATE_LIMIT_GET_BODY;
```

with:

```ts
  let limit: number;
  if (op === 'validate') limit = RATE_LIMIT_VALIDATE;
  else if (op === 'list-inbox' || op === 'count') limit = RATE_LIMIT_LIST_INBOX;
  else if (op === 'get-body') limit = RATE_LIMIT_GET_BODY;
  else if (op === 'send-mail') limit = RATE_LIMIT_SEND_MAIL;
  else if (op === 'append-draft') limit = RATE_LIMIT_APPEND_DRAFT;
  else limit = RATE_LIMIT_GET_BODY; // default safety net
```

- [ ] **Step 4: Add dispatcher branches**

Find (around line 178):

```ts
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
  return err('bad-request', 400);
```

Insert before the trailing `return err('bad-request', 400);`:

```ts
  if (body.op === 'send-mail') {
    return await handleSendMail(body, userId, pepper, supabaseUrl, serviceKey);
  }
  if (body.op === 'append-draft') {
    return await handleAppendDraft(body, userId, pepper, supabaseUrl, serviceKey);
  }
```

- [ ] **Step 5: Verify types compile**

```bash
cd supabase/functions/imap-proxy && deno check --no-lock index.ts
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/imap-proxy/index.ts
git commit -m "feat(imap-proxy): wire send-mail and append-draft into dispatcher"
```

---

### Task 8: Deploy and smoke-test

Per project memory: server changes deploy first, before any client work.

- [ ] **Step 1: Deploy**

```bash
supabase functions deploy imap-proxy --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt
```

Expected: deploy succeeds; function URL printed.

- [ ] **Step 2: Smoke-test `send-mail` from the Supabase dashboard**

In the Supabase dashboard, open the function logs in one tab. In another, send a test request (replace `<JWT>` with a fresh token from the running app — log it from `IcloudSetupScreen` if needed, or copy from `useAuth().session.access_token`):

```bash
curl -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/imap-proxy" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  --data '{
    "op": "send-mail",
    "email": "feldten@me.com",
    "password": "<ASP>",
    "to": ["feldten@me.com"],
    "subject": "Zolva test — æ ø å",
    "content_type": "text",
    "content": "Test fra Zolva edge-function. Æbler. Øl. Åbenhed.\n\n— Zolva"
  }'
```

Expected: `{"ok": true, "sent_appended": true}`. Open Apple Mail; the test message should appear in INBOX (since you sent to yourself) and a copy in Sent Messages.

- [ ] **Step 3: Smoke-test `append-draft`**

```bash
curl -X POST "https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/imap-proxy" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  --data '{
    "op": "append-draft",
    "email": "feldten@me.com",
    "password": "<ASP>",
    "to": ["test@example.com"],
    "subject": "Udkast fra Zolva",
    "content_type": "text",
    "content": "Dette er et udkast."
  }'
```

Expected: `{"ok": true}`. Open Apple Mail; the message should appear in Drafts.

- [ ] **Step 4: Smoke-test `auth-failed` mapping**

Send a `send-mail` request with a wrong ASP. Expected: 422 status, `{"ok": false, "error": "auth-failed"}`.

- [ ] **Step 5: If any smoke test fails, debug from function logs**

Common issues:
- denomailer EHLO rejected by Apple → switch to `tls: true` or check denomailer version compat (try `1.6.0` → `1.6.1` → master)
- IMAP APPEND silently failing → check `client.list()` output in logs to see actual folder names
- Threading header not appearing in recipient → confirm the `inReplyTo` / `references` field name denomailer expects in the installed version

Iterate on the code as needed; recommit and redeploy until all smoke tests pass.

- [ ] **Step 6: Tag the deployed state**

After all smoke tests pass:

```bash
git log -1 --oneline
# verify HEAD matches the deployed function commit
```

Phase 1 complete — server is live.

---

## Phase 2 — Client wrapper (`src/lib/icloud-mail.ts`)

### Task 9: Widen `call()` op union and helper signatures

**Files:**
- Modify: `src/lib/icloud-mail.ts:440-441` and 471-472

- [ ] **Step 1: Update both `call` and `callOnce` op-union signatures**

Find:

```ts
async function call<T>(
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding',
  body: Record<string, unknown>,
): Promise<IcloudResult<T>> {
```

Replace with:

```ts
async function call<T>(
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
  body: Record<string, unknown>,
): Promise<IcloudResult<T>> {
```

Same change to `callOnce`:

```ts
async function callOnce<T>(
  op: 'validate' | 'list-inbox' | 'get-body' | 'count' | 'clear-binding' | 'send-mail' | 'append-draft',
  body: Record<string, unknown>,
): Promise<CallOnceResult<T>> {
```

- [ ] **Step 2: Update the `payload-stripping` branch in `callOnce` (around line 510-512)**

Find:

```ts
  if (res.status === 200) {
    // validate + clear-binding return only `{ok: true}` — no payload.
    if (op === 'validate' || op === 'clear-binding') return { ok: true, data: null as T };
```

Replace with:

```ts
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
```

- [ ] **Step 3: Update timeout selector (around line 480)**

Find:

```ts
  const timeoutMs =
    op === 'validate' ? VALIDATE_TIMEOUT_MS
    : op === 'list-inbox' ? LIST_INBOX_TIMEOUT_MS
    : op === 'get-body' ? GET_BODY_TIMEOUT_MS
    : VALIDATE_TIMEOUT_MS; // clear-binding: same 30s ceiling as validate
```

Replace with:

```ts
  const timeoutMs =
    op === 'validate' ? VALIDATE_TIMEOUT_MS
    : op === 'list-inbox' ? LIST_INBOX_TIMEOUT_MS
    : op === 'get-body' ? GET_BODY_TIMEOUT_MS
    : op === 'send-mail' ? SEND_MAIL_TIMEOUT_MS
    : op === 'append-draft' ? APPEND_DRAFT_TIMEOUT_MS
    : VALIDATE_TIMEOUT_MS;
```

And add the constants near the existing timeout block (around line 38-40):

```ts
const VALIDATE_TIMEOUT_MS = 30_000;
const LIST_INBOX_TIMEOUT_MS = 25_000;
const GET_BODY_TIMEOUT_MS = 25_000;
const SEND_MAIL_TIMEOUT_MS = 35_000;     // SMTP connect+send + IMAP APPEND headroom
const APPEND_DRAFT_TIMEOUT_MS = 25_000;
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no new errors. (Pre-existing errors unrelated to icloud-mail.ts can remain.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/icloud-mail.ts
git commit -m "feat(icloud-mail): widen proxy call() to support send-mail and append-draft ops"
```

---

### Task 10: Add `icloudSendMail` and `icloudAppendDraft`

**Files:**
- Modify: `src/lib/icloud-mail.ts` (after `getMessageBody`, around line 422)

- [ ] **Step 1: Add the import**

At the top of the file (alongside `import { parseFromHeader } from './gmail';`):

```ts
import { buildOutgoingBody } from './mail-signature';
import type { InlineAttachmentSpec } from './mail-signature';
```

- [ ] **Step 2: Add the public type and the two functions**

Insert after `getMessageBody` (around line 422):

```ts
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
    content_b64: bytesToBase64(s.contentBytes),
    content_id: s.contentId,
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // RN runtime: btoa is on global; safe in Hermes.
  return btoa(bin);
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
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/icloud-mail.ts
git commit -m "feat(icloud-mail): add icloudSendMail and icloudAppendDraft"
```

---

### Task 11: Invalidate the inbox cache on successful send

**Files:**
- Modify: `src/lib/icloud-mail.ts` — `icloudSendMail`

- [ ] **Step 1: Find the existing cache-invalidation API**

Confirm the public name. Look at the file for `clearInboxCache` (line 215) — it takes `userId: string`. That's the right hook.

- [ ] **Step 2: Wire `clearInboxCache` after a successful send**

In `icloudSendMail`, replace the `return res;` at the end with:

```ts
  if (res.ok) {
    // The sent message is now in Sent (best-effort) and may also have been
    // delivered back to INBOX (when sending to self). Drop the cached inbox
    // so the next listInbox call sees the fresh state. Failure to clear the
    // cache is not actionable — log and continue.
    try { await clearInboxCache(userId); } catch (e) {
      if (__DEV__) console.warn('[icloud-mail] post-send cache clear failed:', e);
    }
  }
  return res;
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/icloud-mail.ts
git commit -m "feat(icloud-mail): invalidate inbox cache after successful send"
```

---

## Phase 3 — Chat tools wiring (`src/lib/hooks.ts`)

### Task 12: Update `MAIL_COMPOSE_SCHEMA` enums and tool descriptions

**Files:**
- Modify: `src/lib/hooks.ts:3422-3463` (the two tool definitions)

- [ ] **Step 1: Update `create_draft`**

Find (line 3422-3446):

```ts
  {
    name: 'create_draft',
    description:
      'Opret et udkast til en mail. Brug når brugeren siger "lav et udkast", "skriv en mail", "udarbejd et svar" eller lignende. Udkastet gemmes i brugerens mailkonto (Gmail eller Outlook) — det bliver IKKE sendt. BEKRÆFT ALTID modtager, emne og indhold med brugeren før du kalder værktøjet. Brugerens signatur tilføjes automatisk. Hvis udkastet er et svar på en eksisterende mail, send det fulde unified-ID i `reply_to_id` (fx "google:abc" eller "microsoft:abc") — så bevares tråden. iCloud understøttes ikke.',
    input_schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['google', 'microsoft'],
          description: 'Hvilken konto udkastet lægges på. Vælg ud fra hvor brugeren har konteksten.',
        },
```

Replace with:

```ts
  {
    name: 'create_draft',
    description:
      'Opret et udkast til en mail. Brug når brugeren siger "lav et udkast", "skriv en mail", "udarbejd et svar" eller lignende. Udkastet gemmes i brugerens mailkonto (Gmail, Outlook eller iCloud) — det bliver IKKE sendt. BEKRÆFT ALTID modtager, emne og indhold med brugeren før du kalder værktøjet. Brugerens signatur tilføjes automatisk. Hvis udkastet er et svar på en eksisterende mail, send det fulde unified-ID i `reply_to_id` (fx "google:abc", "microsoft:abc" eller "icloud:123") — så bevares tråden.',
    input_schema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['google', 'microsoft', 'icloud'],
          description: 'Hvilken konto udkastet lægges på. Vælg ud fra hvor brugeren har konteksten.',
        },
```

- [ ] **Step 2: Update `send_mail`**

Find (line 3447-3463):

```ts
  {
    name: 'send_mail',
    description:
      'Send en mail med det samme. Brug KUN når brugeren udtrykkeligt siger "send", "afsend" eller "send afsted" — IKKE ved "udkast", "skriv", eller "lav et svar". Når i tvivl, brug create_draft. BEKRÆFT ALTID modtager, emne og indhold med brugeren før du kalder værktøjet. Brugerens signatur tilføjes automatisk. iCloud understøttes ikke.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['google', 'microsoft'] },
```

Replace with:

```ts
  {
    name: 'send_mail',
    description:
      'Send en mail med det samme. Brug KUN når brugeren udtrykkeligt siger "send", "afsend" eller "send afsted" — IKKE ved "udkast", "skriv", eller "lav et svar". Når i tvivl, brug create_draft. BEKRÆFT ALTID modtager, emne og indhold med brugeren før du kalder værktøjet. Brugerens signatur tilføjes automatisk.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['google', 'microsoft', 'icloud'] },
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: this introduces a type error in `parseMailComposeInput` since it still rejects iCloud — Task 13 fixes that.

- [ ] **Step 4: Don't commit yet — Task 13 closes the parser gap**

---

### Task 13: Update `MailComposeProvider` and `parseMailComposeInput`

**Files:**
- Modify: `src/lib/hooks.ts:3529-3576`

- [ ] **Step 1: Widen the type alias**

Find (line 3529):

```ts
type MailComposeProvider = 'google' | 'microsoft';
```

Replace with:

```ts
type MailComposeProvider = 'google' | 'microsoft' | 'icloud';
```

- [ ] **Step 2: Update `parseMailComposeInput`**

Find (line 3550-3576):

```ts
function parseMailComposeInput(input: Record<string, unknown>): ParseResult<MailComposeParsed> {
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft') {
    return {
      ok: false,
      reason: '`provider` skal være "google" eller "microsoft". iCloud-mail kan ikke sendes fra Zolva endnu.',
    };
  }
```

Replace with:

```ts
function parseMailComposeInput(input: Record<string, unknown>): ParseResult<MailComposeParsed> {
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft' && provider !== 'icloud') {
    return {
      ok: false,
      reason: '`provider` skal være "google", "microsoft" eller "icloud".',
    };
  }
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: errors in `runMailComposeTool` because it doesn't handle the new provider value yet — Task 15 fixes that.

- [ ] **Step 4: Don't commit yet — bundling with Task 14/15**

---

### Task 14: Add `mapIcloudComposeError` helper

**Files:**
- Modify: `src/lib/hooks.ts` — insert before `runMailComposeTool` (around line 3585)

- [ ] **Step 1: Add the import**

If not already imported, add `IcloudErrorCode` to the existing icloud-mail import block at the top of `hooks.ts`. Search for the existing icloud-mail import. Add or extend:

```ts
import {
  icloudSendMail,
  icloudAppendDraft,
  type IcloudErrorCode,
} from './icloud-mail';
```

- [ ] **Step 2: Add the helper**

Insert before `runMailComposeTool` (around line 3585, just after the `splitUnifiedId` function):

```ts
function mapIcloudComposeError(code: IcloudErrorCode): string {
  switch (code) {
    case 'auth-failed':
    case 'credential-rejected':
      return 'Apple afviste login. Din app-specific password er måske udløbet — opdater under Indstillinger.';
    case 'rate-limited':
      return 'For mange iCloud-mails sendt fra Zolva i dag. Prøv igen om en time.';
    case 'network':
    case 'timeout':
    case 'temporarily-unavailable':
    case 'gateway-unavailable':
      return 'iCloud kunne ikke nås. Prøv igen om lidt.';
    case 'not-connected':
      return 'Brugeren har ikke forbundet en iCloud-konto. Foreslå at forbinde iCloud under Indstillinger.';
    case 'unauthorized':
      return 'Bruger-session udløbet. Log ind igen.';
    case 'protocol':
    default:
      return 'iCloud afviste afsendelsen.';
  }
}
```

- [ ] **Step 3: Don't commit yet**

---

### Task 15: Add iCloud branch to `runMailComposeTool`

**Files:**
- Modify: `src/lib/hooks.ts:3586-3675`

- [ ] **Step 1: Add the iCloud `ctx` readiness check**

Find (around line 3601-3606):

```ts
  if (provider === 'microsoft' && !ctx.outlookMail) {
    return {
      text: 'Brugeren har ikke forbundet en Outlook-konto. Foreslå at forbinde Outlook under Indstillinger, eller brug "google" hvis Gmail er forbundet.',
      isError: true,
    };
  }
```

Add right after:

```ts
  if (provider === 'icloud' && !ctx.icloud) {
    return {
      text: 'Brugeren har ikke forbundet en iCloud-konto. Foreslå at forbinde iCloud under Indstillinger.',
      isError: true,
    };
  }
```

- [ ] **Step 2: Update the reply-id provider-mismatch guard**

The existing guard at lines 3611-3622 doesn't need changes — it already handles arbitrary providers. But we need to derive `providerReplyIdNum` for iCloud. Find:

```ts
  let providerReplyId: string | undefined;
  if (replyToUnifiedId) {
    const split = splitUnifiedId(replyToUnifiedId);
    const replyProvider = split?.provider ?? provider;
    if (replyProvider !== provider) {
      return {
        text: `\`reply_to_id\` peger på ${replyProvider}, men provider er ${provider}. Brug samme provider som mailen blev modtaget på.`,
        isError: true,
      };
    }
    providerReplyId = split?.id ?? replyToUnifiedId;
  }
```

Add right after, deriving the iCloud-specific UID:

```ts
  let providerReplyIdNum: number | undefined;
  if (provider === 'icloud' && providerReplyId !== undefined) {
    const n = Number(providerReplyId);
    if (!Number.isFinite(n)) {
      return { text: 'Ugyldigt iCloud reply-ID.', isError: true };
    }
    providerReplyIdNum = n;
  }
```

- [ ] **Step 3: Add the dispatch branch**

Find the closing `}` of the `// Microsoft` block (around line 3674, just before the `} catch (err) { ... }`). Insert before it:

```ts
    if (provider === 'icloud') {
      if (!ctx.userId) {
        return { text: 'Ingen bruger-session.', isError: true };
      }
      if (name === 'create_draft') {
        const r = await icloudAppendDraft(ctx.userId, {
          to,
          cc,
          subject,
          body,
          replyToUid: providerReplyIdNum,
        });
        if (!r.ok) return { text: mapIcloudComposeError(r.error), isError: true };
        return { text: 'Udkast oprettet i iCloud.', isError: false };
      }
      const r = await icloudSendMail(ctx.userId, {
        to,
        cc,
        subject,
        body,
        replyToUid: providerReplyIdNum,
      });
      if (!r.ok) return { text: mapIcloudComposeError(r.error), isError: true };
      return {
        text: providerReplyIdNum
          ? 'Svaret er sendt fra iCloud.'
          : 'Mailen er sendt fra iCloud.',
        isError: false,
      };
    }
```

- [ ] **Step 4: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: clean (other than any pre-existing errors elsewhere in the codebase).

- [ ] **Step 5: Commit Tasks 12–15 together**

```bash
git add src/lib/hooks.ts
git commit -m "feat(chat-tools): wire iCloud through create_draft and send_mail tools"
```

---

### Task 16: Search and remove "iCloud cannot send" guidance from system prompt

**Files:**
- Modify: `src/lib/hooks.ts` (system prompt, exact location depends on the search result)

- [ ] **Step 1: Search for the guidance**

```bash
grep -n -i "icloud.*ikke.*send\|icloud.*kan ikke\|icloud.*understøttes ikke" src/lib/hooks.ts
```

Each match is a candidate string in the system prompt that hints the model to avoid iCloud for compose. The Task-12 changes already removed two — verify nothing else remains.

- [ ] **Step 2: For each remaining match, decide**

Some hits may be unrelated (e.g. iCloud calendar attendee restrictions are still valid — see chat-tools.ts:454). Match what's on the line:
- If the line is about COMPOSE (drafts/sends): remove the iCloud carve-out.
- If the line is about CALENDAR ATTENDEES: leave it — that restriction is still real.

For example, if you find a line in the system prompt like `'iCloud-mail kan ikke sendes fra Zolva endnu.'`, remove just that sentence.

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "feat(chat): remove iCloud-cannot-send guidance from system prompt"
```

(If `grep` returned no remaining matches, skip commit and the task is a no-op.)

---

### Task 17: Manual end-to-end test in app

The full surface — schema, parser, runtime branch, signature pipeline, edge function — is now live. Verify by exercising the chat agent on a dev build.

- [ ] **Step 1: Refresh the dev build**

```bash
cd /Users/albertfeldt/ZolvaApp && npx expo start --clear
```

Open on a device with iCloud connected as the only mail provider (use Allan's account). If Gmail/Outlook are also connected on this device, disconnect them in Settings to avoid the agent silently picking one of them.

- [ ] **Step 2: Send a plain mail**

In chat, type: `Send en mail til feldten@me.com med emnet "iCloud test 1" og teksten "Hej fra Zolva — æ ø å"`

Confirm the agent calls `send_mail` with `provider: 'icloud'` (look in dev console). Confirm the chat reply: `"Mailen er sendt fra iCloud."` Open Apple Mail on iPhone — message should be in Inbox AND Sent Messages with correct Danish characters.

- [ ] **Step 3: Send with rich signature**

If a signature is configured for Allan, repeat Step 2. Confirm the recipient (Allan himself) sees the inline image, not a `cid:` reference or a separate attachment.

If no signature is configured, configure one via `SettingsScreen` (use the screenshot import or structured form), then resend.

- [ ] **Step 4: Reply to an iCloud mail**

In chat: open an iCloud mail, then ask `Svar på den med "Tak — modtaget."`. Confirm `reply_to_id` is `"icloud:<uid>"` in the tool call (dev console). Open Apple Mail; the reply should appear in the same thread as the original (not a new conversation).

- [ ] **Step 5: Create a draft**

In chat: `Lav et udkast til feldten@me.com med emnet "Udkast" og teksten "I'm working on it"`. Confirm `create_draft` (not `send_mail`) fires. Open Apple Mail Drafts — message should appear, editable.

- [ ] **Step 6: Disconnect-then-attempt-send**

In Settings, disconnect iCloud. Try sending. Confirm the chat reply mentions "Brugeren har ikke forbundet en iCloud-konto."

- [ ] **Step 7: Wrong-password flow**

Reconnect iCloud with a deliberately invalid ASP. Try sending. Confirm the chat reply mentions "Apple afviste login" and that the iCloud integration row in Settings shows the expired-credential UI.

- [ ] **Step 8: If anything fails, debug and recommit**

Mark task complete only after all eight steps pass.

---

### Task 18: Final commit + OTA

- [ ] **Step 1: Confirm working tree is clean**

```bash
git status
```

If the working tree has uncommitted client-side changes from the earlier tasks (Tasks 9–16), they should already be committed via individual task commits.

- [ ] **Step 2: Push and OTA per project memory**

Per CLAUDE.md memory `[Builds and OTA ship from main]`: merge to main first, then `eas update`. If you've been working on a feature branch:

```bash
git checkout main
git merge --no-ff <feature-branch>
git push origin main
eas update --channel production --message "iCloud send and draft via chat agent"
```

(If you've been working directly on `main`, the merge step is a no-op.)

- [ ] **Step 3: Verify OTA reaches the production build**

In the production app on Allan's device, force-quit and reopen. Run one final smoke test (send to himself). Confirm it works.

- [ ] **Step 4: Done.**

---

## Self-review

Going through the spec section by section, verifying coverage:

- ✅ **Goal** — Tasks 12–17 cover the schema/runtime/test surface.
- ✅ **Architecture summary — `send-mail` op** — Tasks 3–5.
- ✅ **Architecture summary — `append-draft` op** — Task 6.
- ✅ **Body format (rich HTML + inline attachments)** — Task 10 (`buildOutgoingBody` call), Task 5 (`buildRfc5322` multipart construction).
- ✅ **Surface changes (schema enums, type, parser)** — Tasks 12, 13.
- ✅ **Server: rate limits** — Tasks 2, 7.
- ✅ **Server: cold-start** — Task 3 (lazy denomailer load).
- ✅ **Client: `IcloudComposeInput` type, two new exports** — Tasks 9, 10.
- ✅ **Client: cache invalidation** — Task 11.
- ✅ **Error handling: client-side mapping** — Task 14.
- ✅ **Error handling: server-side mapping** — Tasks 3, 4.
- ✅ **Error handling: auth-failed → expired-credential UI** — Task 10 (`markInvalid` call).
- ✅ **System prompt cleanup** — Task 16.
- ✅ **Testing** — Tasks 8 (server smoke) and 17 (client E2E).
- ✅ **Rollout (server first, then client)** — phase split between Phase 1 and Phase 2/3.

No spec requirement without a task. No placeholders, "TBD", or "implement later" phrases in the plan. Type names align across tasks (`IcloudComposeInput`, `AttachmentSpec`, `ComposeBase`, `ThreadingHeaders`, `mapIcloudComposeError`).

---

## Execution

When ready, choose:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between, fast iteration.
2. **Inline Execution** — execute in this session via `superpowers:executing-plans`.
