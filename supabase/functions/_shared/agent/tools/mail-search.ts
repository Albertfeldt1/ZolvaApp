// supabase/functions/_shared/agent/tools/mail-search.ts
//
// Read-only mailbox search for the reflect path. Returns one row per thread
// (deduped) so the agent can pick a related thread to read with mail_get_body.
import type { GmailFetch } from './gmail.ts';
import type { OutlookFetch } from './outlook.ts';

export interface MailSearchHit {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

function gmailHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function gmailSearch(input: {
  fetch: GmailFetch; accessToken: string; query: string; limit: number;
}): Promise<MailSearchHit[]> {
  const listUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${input.limit}&q=${encodeURIComponent(input.query)}`;
  const listRes = await input.fetch(listUrl, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!listRes.ok) throw new Error(`gmailSearch list ${listRes.status}`);
  const list = (await listRes.json()) as { messages?: Array<{ id: string; threadId: string }> };
  const seen = new Set<string>();
  const hits: MailSearchHit[] = [];
  for (const m of list.messages ?? []) {
    if (seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    const getRes = await input.fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    if (!getRes.ok) continue;
    const msg = (await getRes.json()) as {
      threadId: string; snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = msg.payload?.headers ?? [];
    hits.push({
      thread_id: msg.threadId,
      from: gmailHeader(headers, 'From'),
      subject: gmailHeader(headers, 'Subject'),
      snippet: msg.snippet ?? '',
      date: gmailHeader(headers, 'Date'),
    });
  }
  return hits;
}

export async function outlookSearch(input: {
  fetch: OutlookFetch; accessToken: string; query: string; limit: number;
}): Promise<MailSearchHit[]> {
  const url =
    `https://graph.microsoft.com/v1.0/me/messages?$top=${input.limit}&$search=${encodeURIComponent(`"${input.query}"`)}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) throw new Error(`outlookSearch ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{
      conversationId: string; subject?: string; bodyPreview?: string; receivedDateTime?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
    }>;
  };
  const seen = new Set<string>();
  const hits: MailSearchHit[] = [];
  for (const m of data.value ?? []) {
    if (seen.has(m.conversationId)) continue;
    seen.add(m.conversationId);
    const name = m.from?.emailAddress?.name ?? '';
    const addr = m.from?.emailAddress?.address ?? '';
    hits.push({
      thread_id: m.conversationId,
      from: name ? `${name} <${addr}>` : addr,
      subject: m.subject ?? '',
      snippet: m.bodyPreview ?? '',
      date: m.receivedDateTime ?? '',
    });
  }
  return hits;
}
