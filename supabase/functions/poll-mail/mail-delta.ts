// Provider "what's new since the watermark" readers, extracted from index.ts
// so the pagination is unit-testable (index.ts calls serve() at module load).
//
// Both providers paginate: Gmail history via nextPageToken, Microsoft Graph
// delta via @odata.nextLink. Following every page is mandatory — stopping at
// page 1 silently drops inbound mail (no push, no agent event) and advances
// the watermark past the dropped messages so they are never recovered.

import { isInboundGmailMessage } from './emit.ts';

export type NewMessage = {
  messageId: string;
  threadId?: string;
  subject: string;
  from: string;
};

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// Safety bounds so a misbehaving server can't spin us forever. A page is up to
// ~100 changes (Gmail) / messages (Graph), so these cover large catch-ups.
const MAX_GMAIL_HISTORY_PAGES = 25;
const MAX_GRAPH_DELTA_PAGES = 50;

export async function fetchGmailSince(
  accessToken: string,
  lastHistoryId: string | null,
  fetchFn: FetchFn = fetch,
): Promise<{ messages: NewMessage[]; nextHistoryId: string | null; nextDeltaLink: null }> {
  if (!lastHistoryId) {
    const profileRes = await fetchFn('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) throw new Error(`gmail profile ${profileRes.status}`);
    const profile = (await profileRes.json()) as { historyId?: string };
    return { messages: [], nextHistoryId: profile.historyId ?? null, nextDeltaLink: null };
  }

  const added: Array<{ id: string; threadId?: string }> = [];
  let nextHistoryId = lastHistoryId;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_GMAIL_HISTORY_PAGES; page++) {
    const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    u.searchParams.set('startHistoryId', lastHistoryId);
    u.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const historyRes = await fetchFn(u.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!historyRes.ok) throw new Error(`gmail history ${historyRes.status}`);
    const history = (await historyRes.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId?: string } }> }>;
      historyId?: string;
      nextPageToken?: string;
    };
    for (const h of history.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        added.push({ id: m.message.id, threadId: m.message.threadId });
      }
    }
    if (history.historyId) nextHistoryId = history.historyId;
    if (!history.nextPageToken) break;
    pageToken = history.nextPageToken;
  }

  const messages: NewMessage[] = [];
  for (const m of added) {
    const metaRes = await fetchFn(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!metaRes.ok) continue;
    const meta = (await metaRes.json()) as {
      labelIds?: string[];
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    // Skip the agent's own drafts/sends and any non-inbox message — emitting
    // for those would re-trigger the agent on a thread it just handled.
    if (!isInboundGmailMessage(meta.labelIds)) continue;
    const headers = meta.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)';
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    messages.push({ messageId: m.id, threadId: m.threadId, subject, from });
  }

  return { messages, nextHistoryId, nextDeltaLink: null };
}

export async function fetchGraphSince(
  accessToken: string,
  lastDeltaLink: string | null,
  fetchFn: FetchFn = fetch,
): Promise<{ messages: NewMessage[]; nextHistoryId: null; nextDeltaLink: string | null }> {
  const isBaseline = !lastDeltaLink;
  let url =
    lastDeltaLink ??
    'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from';
  const collected: NewMessage[] = [];
  let deltaLink: string | null = null;

  for (let page = 0; page < MAX_GRAPH_DELTA_PAGES; page++) {
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`graph delta ${res.status}`);
    const j = (await res.json()) as {
      value?: Array<{
        id: string;
        subject?: string;
        from?: { emailAddress?: { address?: string; name?: string } };
      }>;
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };
    // On the baseline run (no prior deltaLink) we only want to establish a
    // watermark, not emit a push for every existing inbox message.
    if (!isBaseline) {
      for (const m of j.value ?? []) {
        collected.push({
          messageId: m.id,
          subject: m.subject ?? '(uden emne)',
          from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? '',
        });
      }
    }
    if (j['@odata.deltaLink']) {
      deltaLink = j['@odata.deltaLink'];
      break;
    }
    if (j['@odata.nextLink']) {
      url = j['@odata.nextLink'];
      continue;
    }
    break; // neither link — nothing more to page
  }

  return { messages: collected, nextHistoryId: null, nextDeltaLink: deltaLink ?? lastDeltaLink };
}
