// Read-only mail body lookup for the agent. Gmail uses thread.list → message.get;
// Outlook uses message.get with $select. Both decode the body to plain text and
// truncate to keep prompts cheap.

export type GmailFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;
export type OutlookFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface MailBodyResult {
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  body_text: string;
}

function stripHtml(s: string): string {
  // Outlook HTML bodies always carry <style>/<script>/<head> blocks with raw
  // CSS rules and meta tags inside. A bare /<[^>]+>/g strip leaves their
  // TEXT CONTENT verbatim, eating the body_text budget with CSS noise.
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_BODY_CHARS = 8000;

function decodeBase64Url(s: string): string {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function findHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function walkForText(part: {
  mimeType?: string;
  body?: { data?: string };
  parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }>;
}): string {
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const found = walkForText(sub as Parameters<typeof walkForText>[0]);
      if (found) return found;
    }
  }
  return '';
}

export async function gmailGetBody(input: {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
}): Promise<MailBodyResult> {
  const threadRes = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}?format=metadata`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!threadRes.ok) {
    const detail = await threadRes.text().catch(() => '');
    throw new Error(`gmail threads.get ${threadRes.status}: ${detail.slice(0, 200)}`);
  }
  const thread = (await threadRes.json()) as { id: string; messages?: Array<{ id: string }> };
  const lastMessageId = thread.messages?.[thread.messages.length - 1]?.id;
  if (!lastMessageId) throw new Error('gmail thread has no messages');

  const msgRes = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${lastMessageId}?format=full`,
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!msgRes.ok) {
    const detail = await msgRes.text().catch(() => '');
    throw new Error(`gmail messages.get ${msgRes.status}: ${detail.slice(0, 200)}`);
  }
  const msg = (await msgRes.json()) as {
    id: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      mimeType?: string;
      parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
    };
  };
  const headers = msg.payload?.headers ?? [];
  const rawBody = msg.payload?.body?.data
    ? decodeBase64Url(msg.payload.body.data)
    : walkForText(msg.payload ?? {});
  const body_text = rawBody.slice(0, MAX_BODY_CHARS);
  return {
    thread_id: input.threadId,
    from: findHeader(headers, 'From'),
    to: findHeader(headers, 'To'),
    subject: findHeader(headers, 'Subject'),
    sent_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    body_text,
  };
}

export async function outlookGetBody(input: {
  fetch: OutlookFetch;
  accessToken: string;
  threadId: string; // conversationId
}): Promise<MailBodyResult> {
  const url =
    `https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId eq '${input.threadId}'` +
    `&$orderby=sentDateTime desc&$top=1` +
    `&$select=id,from,toRecipients,subject,sentDateTime,uniqueBody`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
      subject?: string;
      sentDateTime?: string;
      uniqueBody?: { content?: string; contentType?: string };
      body?: { content?: string; contentType?: string };
    }>;
  };
  const msg = json.value?.[0];
  if (!msg) throw new Error('graph: conversation has no messages');
  const fromAddr = msg.from?.emailAddress;
  const toAddr = msg.toRecipients?.[0]?.emailAddress;
  const rawBody = msg.uniqueBody?.content ?? msg.body?.content ?? '';
  const body_text = (msg.uniqueBody?.contentType === 'html' || msg.body?.contentType === 'html')
    ? stripHtml(rawBody)
    : rawBody;
  const truncated = body_text.slice(0, MAX_BODY_CHARS);
  return {
    thread_id: input.threadId,
    from: fromAddr ? `${fromAddr.name ?? ''} <${fromAddr.address ?? ''}>`.trim() : '',
    to: toAddr ? `${toAddr.name ?? ''} <${toAddr.address ?? ''}>`.trim() : '',
    subject: msg.subject ?? '',
    sent_at: msg.sentDateTime ?? new Date().toISOString(),
    body_text: truncated,
  };
}
