// Minimal Gmail client. Lists inbox messages and fetches metadata only.

import { ProviderAuthError, tryWithRefresh } from './auth';

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
    const listRes = await fetch(
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

    const detailed = await Promise.all(
      list.messages.map((m) => fetchMessageMeta(accessToken, m.id)),
    );
    return detailed.filter((m): m is GmailMessage => m !== null);
  });
}

async function fetchMessageMeta(
  accessToken: string,
  id: string,
): Promise<GmailMessage | null> {
  const url = `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
  }
  if (!res.ok) return null;
  const data = (await res.json()) as RawMessage;
  const headers = data.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  return {
    id: data.id,
    from: parseFromHeader(get('From')),
    subject: get('Subject') || '(intet emne)',
    date: new Date(get('Date')),
    snippet: data.snippet ?? '',
    unread: (data.labelIds ?? []).includes('UNREAD'),
  };
}

export async function getMessageBody(id: string): Promise<GmailMessageBody> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetch(`${BASE}/messages/${id}?format=full`, {
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

    const headerLines = [
      `To: ${ctx.to}`,
      `Subject: ${encodeHeader(subject)}`,
      ctx.inReplyTo ? `In-Reply-To: ${ctx.inReplyTo}` : '',
      refs ? `References: ${refs}` : '',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
    ].filter((l) => l !== '');

    const message = `${headerLines.join('\r\n')}\r\n\r\n${ctx.body}`;
    const raw = base64UrlEncode(message);

    const res = await fetch(`${BASE}/messages/send`, {
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

export async function archiveMessage(id: string): Promise<void> {
  return tryWithRefresh('google', async (accessToken) => {
    const res = await fetch(`${BASE}/messages/${id}/modify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Gmail afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Gmail archive failed: ${res.status} ${await res.text()}`);
    }
  });
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
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
