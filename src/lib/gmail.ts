// Minimal Gmail client. Lists inbox messages and fetches metadata only.

import { ProviderAuthError, subscribeUserId, tryWithRefresh } from './auth';
import { fetchWithTimeout, NetworkTimeoutError } from './network-errors';
import { stripHtml } from './html-text';

// 429 (rate-limited) and 5xx are transient — worth a retry, not a silent drop.
// Listing the inbox returns ~50 ids, then EACH needs its own metadata GET;
// firing them all at once routinely trips Gmail's per-user rate limit, so a
// handful 429 on every refresh. Dropping those made the inbox count fluctuate
// between refreshes (same mailbox, a different number of mails shown each
// time). Retrying keeps the returned set complete and the count stable.
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = 1500;

// Fetch wrapper that retries transient failures (429 / 5xx / timeout) with
// linear backoff. `fetcher`/`sleep`/`backoffMs`/`retries` are injectable so the
// retry loop is unit-testable without real timers or network (see
// gmail-retry.test.ts). Auth (401/403) and other 4xx are returned as-is for the
// caller to handle — they are not transient and must not be retried.
export async function fetchGoogleWithRetry(
  url: string,
  init: RequestInit,
  opts: {
    retries?: number;
    backoffMs?: number;
    fetcher?: typeof fetchWithTimeout;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const retries = opts.retries ?? TRANSIENT_RETRIES;
  const backoffMs = opts.backoffMs ?? RETRY_BACKOFF_MS;
  const doFetch = opts.fetcher ?? fetchWithTimeout;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch('google', url, init);
      if (isTransientStatus(res.status) && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof NetworkTimeoutError && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// The list / labels / count callers want a single retry. fetchGoogleWithRetry
// now also extends that to 429 (previously only 5xx + timeout).
function fetchListWithRetry(url: string, init: RequestInit): Promise<Response> {
  return fetchGoogleWithRetry(url, init, { retries: 1 });
}

// Reset the per-session signature cache when the active user changes - the
// signature is account-specific and must not leak across accounts.
subscribeUserId(() => {
  resetGmailSignatureCache();
});

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type GmailMessage = {
  id: string;
  from: string;
  /** Bare sender address — the no-reply/marketing classifiers match on this;
   * `from` is the display name and never contains the address. */
  fromEmail: string;
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
  attachments: { id: string; name: string; mimeType: string; sizeBytes: number }[];
};

type RawHeader = { name: string; value: string };

type RawMessageList = { messages?: { id: string; threadId?: string }[] };

type RawMessagePart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: RawMessagePart[];
};

type RawMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: RawMessagePart & { headers?: RawHeader[] };
};

// Server-reported INBOX counts. Total comes from labels/INBOX
// (messagesTotal - exact, all-time inbox size). Unread is scoped to
// the past 7 days to keep the headline number actionable: long-tail
// "Venter på dig" = unread in the user's PRIMARY tab from the past 7 days.
// Two fixes vs the prior implementation:
//   1. Scope to category:primary so Promotions/Social/Updates/Forums don't
//      inflate the count - those tabs are technically in the INBOX label
//      but the user doesn't think of them as "their inbox" and never
//      opens them. Counting them produced 4013-style mystery numbers.
//   2. Page through messages.list and count the returned ids instead of
//      trusting resultSizeEstimate, which Google explicitly documents as
//      approximate and frequently inflates by 10-30x for fresh queries.
//      Capped at 4 pages * 500 = 2000 so an actual unread firehose still
//      terminates quickly.
const UNREAD_PAGE_LIMIT = 500;
const UNREAD_PAGE_CAP = 4;

async function countUnreadPrimary7d(accessToken: string): Promise<number> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const q = encodeURIComponent('is:unread newer_than:7d in:inbox category:primary');
  let total = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < UNREAD_PAGE_CAP; page += 1) {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const res = await fetchListWithRetry(
      `${BASE}/messages?q=${q}&maxResults=${UNREAD_PAGE_LIMIT}&fields=messages/id,nextPageToken${tokenParam}`,
      { headers },
    );
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail unread query failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string };
    total += data.messages?.length ?? 0;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return total;
}

export async function getInboxCounts(): Promise<{ total: number; unread: number }> {
  return tryWithRefresh('google', async (accessToken) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [labelRes, unread] = await Promise.all([
      fetchListWithRetry(`${BASE}/labels/INBOX`, { headers }),
      countUnreadPrimary7d(accessToken),
    ]);
    if (labelRes.status === 401 || labelRes.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${labelRes.status}).`);
    }
    if (!labelRes.ok) {
      throw new Error(`Gmail label fetch failed: ${labelRes.status} ${await labelRes.text()}`);
    }
    const labelData = (await labelRes.json()) as { messagesTotal?: number };
    return {
      total: labelData.messagesTotal ?? 0,
      unread,
    };
  });
}

// Keep the first message of each thread, preserving order. Callers pass an
// internalDate-descending list, so "first" is the most recent message per
// conversation - mirroring Gmail's one-row-per-thread inbox grouping.
export function dedupeByThread<T extends { id: string; threadId?: string }>(
  messages: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of messages) {
    const key = m.threadId ?? m.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export type ListInboxOptions = {
  // Gmail search query. Defaults to excluding Promotions/Social noise. The chat
  // "last N mails" path overrides this with `in:inbox category:primary` so it
  // mirrors exactly what the user sees at the top of their main inbox.
  query?: string;
  // Collapse messages to one entry per conversation, keeping the most recent
  // message of each thread - matches how Gmail groups the inbox. Without it, a
  // multi-message conversation (e.g. two Google security alerts) fills several
  // slots and pushes distinct mail off the list.
  groupByThread?: boolean;
};

export async function listInboxMessages(
  maxResults = 12,
  opts: ListInboxOptions = {},
): Promise<GmailMessage[]> {
  const q = encodeURIComponent(opts.query ?? 'in:inbox -category:promotions -category:social');
  // When grouping by thread, over-fetch so de-duping still yields ~maxResults
  // distinct conversations. The list call is a single cheap request; only the
  // surviving ids get a metadata fetch.
  const fetchCount = opts.groupByThread
    ? Math.min(Math.max(maxResults * 5, 25), 100)
    : maxResults;
  return tryWithRefresh('google', async (accessToken) => {
    const listRes = await fetchListWithRetry(
      `${BASE}/messages?q=${q}&maxResults=${fetchCount}`,
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

    // The list is internalDate-descending, so the first message seen for a
    // thread is its most recent one - exactly the entry Gmail shows for that row.
    const picked = opts.groupByThread
      ? dedupeByThread(list.messages).slice(0, maxResults)
      : list.messages;

    // allSettled, not all: one transient metadata failure (timeout, 5xx)
    // shouldn't blank the other 49 mails. Auth errors still propagate so
    // tryWithRefresh can refresh the token and retry the whole batch.
    const settled = await Promise.allSettled(
      picked.map((m) => fetchMessageMeta(accessToken, m.id)),
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
  // Retry transient failures (429 from the concurrent-fetch burst, 5xx,
  // timeout) instead of dropping the message — silent drops here made the
  // inbox count fluctuate between refreshes.
  const res = await fetchGoogleWithRetry(url, {
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
    fromEmail: extractEmail(get('From')),
    subject: get('Subject') || '(intet emne)',
    date: parseGmailDate(get('Date'), data.internalDate),
    snippet: data.snippet ?? '',
    unread: (data.labelIds ?? []).includes('UNREAD'),
  };
}

// internalDate is Gmail's authoritative receive timestamp - the same field
// that orders the inbox. The `Date:` header is sender-controlled and routinely
// wrong on marketing/cold-outreach mail (bad clocks, timezone games, or
// deliberate top-of-inbox inflation), so trusting it floats old mail above
// genuinely recent mail once callers sort by this value. Prefer internalDate;
// fall back to the header only when Gmail omits internalDate.
export function parseGmailDate(header: string, internalDate?: string): Date {
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

// Pull a small batch of the user's recent sent mails - body text only,
// for the style-summary analyzer. Skips threads where the user is just
// quoting a previous reply (heuristic: body shorter than 30 chars after
// trimming) since those add no style signal. Returns plain text bodies
// trimmed to ~600 chars each so the combined prompt fits comfortably
// inside Claude's context for a Sonnet style call.
export async function listSentSamples(maxResults = 12): Promise<string[]> {
  return tryWithRefresh('google', async (accessToken) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const listRes = await fetchListWithRetry(
      `${BASE}/messages?q=${encodeURIComponent('in:sent -in:chats')}&maxResults=${maxResults}`,
      { headers },
    );
    if (listRes.status === 401 || listRes.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${listRes.status}).`);
    }
    if (!listRes.ok) return [];
    const list = (await listRes.json()) as RawMessageList;
    const ids = (list.messages ?? []).map((m) => m.id);
    if (ids.length === 0) return [];
    const settled = await Promise.allSettled(
      ids.map(async (id) => {
        const res = await fetchWithTimeout('google', `${BASE}/messages/${id}?format=full`, {
          headers,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as RawMessage;
        const body = extractBody(data.payload) ?? data.snippet ?? '';
        return body.trim().slice(0, 600);
      }),
    );
    return settled
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((b): b is string => !!b && b.length >= 30);
  });
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
      attachments: collectAttachments(data.payload),
    };
  });
}

/** Ikke-inline vedhæftninger fra message-payloadens part-træ (M12): en part
 * med filnavn + attachmentId er en rigtig vedhæftning; inline-billeder uden
 * filnavn springes over. */
function collectAttachments(
  part: RawMessagePart | undefined,
): { id: string; name: string; mimeType: string; sizeBytes: number }[] {
  if (!part) return [];
  const out: { id: string; name: string; mimeType: string; sizeBytes: number }[] = [];
  const walk = (p: RawMessagePart) => {
    if (p.filename && p.body?.attachmentId) {
      out.push({
        id: p.body.attachmentId,
        name: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        sizeBytes: p.body.size ?? 0,
      });
    }
    p.parts?.forEach(walk);
  };
  walk(part);
  return out;
}

/** Hent en vedhæftnings bytes som standard-base64 (klar til fil-skrivning). */
export async function downloadAttachment(messageId: string, attachmentId: string): Promise<string> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetchWithTimeout(
      'google',
      `${BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail attachment fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as { data?: string };
    // Gmail leverer base64url — konvertér til standard-base64 til FileSystem.
    return (data.data ?? '').replace(/-/g, '+').replace(/_/g, '/');
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

// Sends an existing draft by id (POST /drafts/send). Gmail moves the message
// out of Drafts and delivers it, so nothing is left behind - unlike re-sending
// the body, which would orphan the original draft. The draft already carries
// the appended signature and threading headers from createDraft.
export async function sendDraft(draftId: string): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetchWithTimeout('google', `${BASE}/drafts/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: draftId }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail draft send failed: ${res.status} ${await res.text()}`);
    }
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
// as HTML - we strip to plain text since outgoing mail goes out as
// text/plain (matching the existing send pipeline).

type SendAs = {
  sendAsEmail: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  signature?: string;
};

let cachedSignature: string | null | undefined;
let cachedSignatureFetchedAt = 0;
const SIGNATURE_TTL_MS = 6 * 60 * 60 * 1000; // 6h - refreshes once per day-ish without paying for it on every send

// Raw sendAs signature HTML - used by the signature editor's
// "Hent fra Gmail" import. The send pipeline below strips to plain text.
export async function fetchGmailSignatureHtml(): Promise<string | null> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetchWithTimeout('google', `${BASE}/settings/sendAs`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      // Don't throw - a missing signature shouldn't block the send. Log and
      // fall through to no-signature.
      if (__DEV__) console.warn(`[gmail] sendAs fetch failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { sendAs?: SendAs[] };
    const list = data.sendAs ?? [];
    const primary =
      list.find((s) => s.isPrimary) ?? list.find((s) => s.isDefault) ?? list[0];
    return primary?.signature?.trim() || null;
  });
}

async function fetchPrimarySignature(): Promise<string | null> {
  const html = await fetchGmailSignatureHtml();
  if (!html) return null;
  return stripHtml(html).trim() || null;
}

// Exported for the reply editor's signature preview - shows the user what
// appendGmailSignature will add at send time (plain text, 6h cache).
export async function getGmailSignature(): Promise<string | null> {
  const now = Date.now();
  // Only cache POSITIVE hits. A null result means "no signature found right
  // now" - could be a fresh account that hasn't configured one yet, or a
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


function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${globalThis.btoa(bin)}?=`;
}

export function extractEmail(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return raw.trim();
}

export function parseFromHeader(raw: string): string {
  if (!raw) return '(ukendt afsender)';
  // "Display Name <email@example.com>" or just "email@example.com"
  const named = raw.match(/^"?([^"<]+?)"?\s*<.+>$/);
  if (named) return named[1].trim();
  if (raw.includes('@')) return raw.split('@')[0];
  return raw;
}

export function initialsOf(name: string): string {
  // Strip MIME-encoding artefacts (<, >, ", quoted-printable markers) and
  // anything that isn't a letter/digit before splitting on whitespace -
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
