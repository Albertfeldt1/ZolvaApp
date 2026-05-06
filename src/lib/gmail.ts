// Minimal Gmail client. Lists inbox messages and fetches metadata only.

import { ProviderAuthError, subscribeUserId, tryWithRefresh } from './auth';
import { fetchWithTimeout, NetworkTimeoutError } from './network-errors';

// One retry on transient failures (timeout, 5xx) before giving up. Mirrors
// iCloud's first-retry delay (1.5s). Without this, a brief network blip
// during the list fetch took Gmail offline until the user pulled to refresh.
async function fetchListWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetchWithTimeout('google', url, init);
    if (res.status >= 500 && res.status < 600) {
      await new Promise((r) => setTimeout(r, 1500));
      return await fetchWithTimeout('google', url, init);
    }
    return res;
  } catch (err) {
    if (err instanceof NetworkTimeoutError) {
      await new Promise((r) => setTimeout(r, 1500));
      return await fetchWithTimeout('google', url, init);
    }
    throw err;
  }
}

// Reset the per-session signature cache when the active user changes — the
// signature is account-specific and must not leak across accounts.
subscribeUserId(() => {
  resetGmailSignatureCache();
});

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailMessage = {
  id: string;
  from: string;
  subject: string;
  date: Date;
  snippet: string;
  unread: boolean;
};

export type GmailMessageBody = {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  text: string;
  messageIdHeader: string;
  references: string;
};

type RawHeader = { name: string; value: string };

type RawMessageList = { messages?: { id: string }[] };

type RawMessagePart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: RawMessagePart[];
};

type RawMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: RawMessagePart & { headers?: RawHeader[] };
};

export async function listInboxMessages(maxResults = 12): Promise<GmailMessage[]> {
  return tryWithRefresh('google', async (accessToken) => {
    const listRes = await fetchListWithRetry(
      `${BASE}/messages?q=in:inbox&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (listRes.status === 401 || listRes.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${listRes.status}).`);
    }
    if (!listRes.ok) {
      throw new Error(`Gmail list failed: ${listRes.status} ${await listRes.text()}`);
    }
    const list = (await listRes.json()) as RawMessageList;
    if (!list.messages?.length) return [];

    // allSettled, not all: one transient metadata failure (timeout, 5xx)
    // shouldn't blank the other 49 mails. Auth errors still propagate so
    // tryWithRefresh can refresh the token and retry the whole batch.
    const settled = await Promise.allSettled(
      list.messages.map((m) => fetchMessageMeta(accessToken, m.id)),
    );
    const authErr = settled.find(
      (r): r is PromiseRejectedResult =>
        r.status === 'rejected' && r.reason instanceof ProviderAuthError,
    );
    if (authErr) throw authErr.reason;
    if (__DEV__) {
      const rejected = settled.filter((r) => r.status === 'rejected').length;
      if (rejected > 0) {
        console.warn(`[gmail] ${rejected}/${settled.length} metadata fetches failed transiently`);
      }
    }
    return settled
      .filter((r): r is PromiseFulfilledResult<GmailMessage | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((m): m is GmailMessage => m !== null);
  });
}

async function fetchMessageMeta(
  accessToken: string,
  id: string,
): Promise<GmailMessage | null> {
  const url = `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetchWithTimeout('google', url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
  }
  if (!res.ok) return null;
  const data = (await res.json()) as RawMessage & { internalDate?: string };
  const headers = data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  return {
    id: data.id,
    from: parseFromHeader(get('From')),
    subject: get('Subject') || '(intet emne)',
    date: parseGmailDate(get('Date'), data.internalDate),
    snippet: data.snippet ?? '',
    unread: (data.labelIds ?? []).includes('UNREAD'),
  };
}

function parseGmailDate(header: string, internalDate?: string): Date {
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

export async function getMessageBody(id: string): Promise<GmailMessageBody> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetchWithTimeout('google', `${BASE}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail body fetch failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as RawMessage;
    const headers = data.payload?.headers ?? [];
    const get = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

    const fromRaw = get('From');
    return {
      id: data.id,
      threadId: data.threadId ?? data.id,
      from: parseFromHeader(fromRaw),
      fromEmail: extractEmail(fromRaw),
      subject: get('Subject') || '(intet emne)',
      text: extractBody(data.payload) || data.snippet || '',
      messageIdHeader: get('Message-ID') || get('Message-Id'),
      references: get('References'),
    };
  });
}

export async function sendReply(ctx: {
  threadId: string;
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string;
}): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    const subject = ctx.subject.toLowerCase().startsWith('re:')
      ? ctx.subject
      : `Re: ${ctx.subject}`;
    const refs = ctx.references
      ? `${ctx.references} ${ctx.inReplyTo}`.trim()
      : ctx.inReplyTo;
    const signedBody = await appendGmailSignature(ctx.body);

    const message = buildMime({
      to: ctx.to,
      subject,
      body: signedBody,
      inReplyTo: ctx.inReplyTo,
      references: refs,
    });
    const raw = base64UrlEncode(message);

    const res = await fetchWithTimeout('google', `${BASE}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw, threadId: ctx.threadId }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
    }
  });
}

export type GmailComposeInput = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  // For reply drafts/sends. If supplied, the message is posted into the same
  // thread so Gmail's UI threads it correctly.
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};

// Creates a Gmail draft. Body gets the user's sendAs signature appended.
// Returns the draft id so callers (e.g. UI) can navigate to it.
export async function createDraft(input: GmailComposeInput): Promise<{ id: string }> {
  return tryWithRefresh('google', async (accessToken) => {
    const signedBody = await appendGmailSignature(input.body);
    const message = buildMime({
      to: input.to.join(', '),
      cc: input.cc && input.cc.length > 0 ? input.cc.join(', ') : undefined,
      subject: input.subject,
      body: signedBody,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    const raw = base64UrlEncode(message);
    const body: Record<string, unknown> = { message: { raw } };
    if (input.threadId) (body.message as Record<string, unknown>).threadId = input.threadId;

    const res = await fetchWithTimeout('google', `${BASE}/drafts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail draft create failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id?: string };
    return { id: data.id ?? '' };
  });
}

// Sends a fresh email (not a reply to an existing thread). For replies, use
// sendReply so threading headers are set correctly.
export async function sendMail(input: GmailComposeInput): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    const signedBody = await appendGmailSignature(input.body);
    const message = buildMime({
      to: input.to.join(', '),
      cc: input.cc && input.cc.length > 0 ? input.cc.join(', ') : undefined,
      subject: input.subject,
      body: signedBody,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    const raw = base64UrlEncode(message);
    const body: Record<string, unknown> = { raw };
    if (input.threadId) body.threadId = input.threadId;

    const res = await fetchWithTimeout('google', `${BASE}/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
    }
  });
}

// ─── Signatures ──────────────────────────────────────────────────────────
//
// Reads the user's primary sendAs signature from Gmail settings and caches
// it in-memory for the session. The endpoint is covered by the existing
// `gmail.readonly` scope, so no scope bump is required. Signatures arrive
// as HTML — we strip to plain text since outgoing mail goes out as
// text/plain (matching the existing send pipeline).

type SendAs = {
  sendAsEmail: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  signature?: string;
};

let cachedSignature: string | null | undefined;
let cachedSignatureFetchedAt = 0;
const SIGNATURE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — refreshes once per day-ish without paying for it on every send

async function fetchPrimarySignature(): Promise<string | null> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetchWithTimeout('google', `${BASE}/settings/sendAs`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      // Don't throw — a missing signature shouldn't block the send. Log and
      // fall through to no-signature.
      if (__DEV__) console.warn(`[gmail] sendAs fetch failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { sendAs?: SendAs[] };
    const list = data.sendAs ?? [];
    const primary =
      list.find((s) => s.isPrimary) ?? list.find((s) => s.isDefault) ?? list[0];
    const html = primary?.signature?.trim();
    if (!html) return null;
    return stripHtml(html).trim() || null;
  });
}

async function getGmailSignature(): Promise<string | null> {
  const now = Date.now();
  // Only cache POSITIVE hits. A null result means "no signature found right
  // now" — could be a fresh account that hasn't configured one yet, or a
  // transient empty response. Caching null for hours would mean the user's
  // newly-set signature wouldn't appear until the TTL expires. Re-fetching
  // on every send when there's no signature is cheap (one Gmail API call).
  if (
    cachedSignature !== undefined &&
    cachedSignature !== null &&
    now - cachedSignatureFetchedAt < SIGNATURE_TTL_MS
  ) {
    return cachedSignature;
  }
  let result: string | null = null;
  try {
    result = await fetchPrimarySignature();
  } catch (err) {
    if (__DEV__) console.warn('[gmail] signature fetch threw:', err);
    result = null;
  }
  if (result) {
    cachedSignature = result;
    cachedSignatureFetchedAt = now;
  }
  return result;
}

async function appendGmailSignature(body: string): Promise<string> {
  const sig = await getGmailSignature();
  if (!sig) return body;
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n${sig}\n`;
}

// Test/debug hook: clear the in-memory signature cache. Used when the user
// changes Gmail accounts or signs out so we don't append a stale signature.
export function resetGmailSignatureCache(): void {
  cachedSignature = undefined;
  cachedSignatureFetchedAt = 0;
}

function buildMime(opts: {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const subject = opts.subject;
  const headerLines = [
    `To: ${opts.to}`,
    opts.cc ? `Cc: ${opts.cc}` : '',
    `Subject: ${encodeHeader(subject)}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : '',
    opts.references ? `References: ${opts.references}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter((l) => l !== '');
  return `${headerLines.join('\r\n')}\r\n\r\n${opts.body}`;
}

function extractBody(part: RawMessagePart | undefined): string {
  if (!part) return '';
  const plain = findPart(part, 'text/plain');
  const plainText = plain?.body?.data ? decodeBase64Url(plain.body.data) : '';
  const html = findPart(part, 'text/html');
  const htmlText = html?.body?.data ? stripHtml(decodeBase64Url(html.body.data)) : '';

  // Prefer whichever actually carries the message. Marketing emails often have
  // a near-empty plain-text alternative with just the CTA link, while the real
  // content lives in HTML.
  if (htmlText && htmlText.length > plainText.length * 1.3) return htmlText;
  if (plainText) return plainText;
  if (htmlText) return htmlText;
  if (part.body?.data) return decodeBase64Url(part.body.data);
  return '';
}

function findPart(part: RawMessagePart, mime: string): RawMessagePart | null {
  if (part.mimeType === mime && part.body?.data) return part;
  if (part.parts) {
    for (const p of part.parts) {
      const hit = findPart(p, mime);
      if (hit) return hit;
    }
  }
  return null;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = globalThis.atob(b64);
    // Decode UTF-8 bytes
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return globalThis
    .btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|td|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${globalThis.btoa(bin)}?=`;
}

function extractEmail(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return raw.trim();
}

function parseFromHeader(raw: string): string {
  if (!raw) return '(ukendt afsender)';
  // "Display Name <email@example.com>" or just "email@example.com"
  const named = raw.match(/^"?([^"<]+?)"?\s*<.+>$/);
  if (named) return named[1].trim();
  if (raw.includes('@')) return raw.split('@')[0];
  return raw;
}

export function initialsOf(name: string): string {
  // Strip MIME-encoding artefacts (<, >, ", quoted-printable markers) and
  // anything that isn't a letter/digit before splitting on whitespace —
  // otherwise senders like 'Lars <lars@x.com>' that slip past the From-
  // header parser surface as initials like "L<".
  const cleaned = name
    .replace(/[<>"'`]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
