// supabase/functions/_shared/agent/tools/gmail.ts
//
// Gmail v1 write operations used by phase-2 mail-triage tools.
// The `fetch` parameter is injectable so unit tests can stub the network
// without monkey-patching globalThis.

export type GmailFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface ModifyInput {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

export interface GmailModifyReverseToken {
  kind: 'gmail.modify';
  thread_id: string;
  add_label_ids: string[];
  remove_label_ids: string[];
}

export interface GmailModifyResult {
  reverseToken: GmailModifyReverseToken;
}

export const ZOLVA_FLAGGED_LABEL = 'Zolva flaggede';

export async function gmailModifyThread(input: ModifyInput): Promise<GmailModifyResult> {
  const res = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}/modify`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        addLabelIds: input.addLabelIds,
        removeLabelIds: input.removeLabelIds,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail threads.modify ${res.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'gmail.modify',
      thread_id: input.threadId,
      // Reverse: what we added we remove, what we removed we add.
      add_label_ids: [...input.removeLabelIds],
      remove_label_ids: [...input.addLabelIds],
    },
  };
}

export interface ResolveLabelInput {
  fetch: GmailFetch;
  accessToken: string;
  name: string;
}

export async function resolveLabelId(input: ResolveLabelInput): Promise<string> {
  const listRes = await input.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!listRes.ok) throw new Error(`gmail labels.list ${listRes.status}`);
  const list = (await listRes.json()) as { labels?: Array<{ id: string; name: string }> };
  const wantLower = input.name.toLowerCase();
  const hit = (list.labels ?? []).find((l) => l.name.toLowerCase() === wantLower);
  if (hit) return hit.id;

  const createRes = await input.fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    },
  );
  if (!createRes.ok) throw new Error(`gmail labels.create ${createRes.status}`);
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

export interface GmailDraftReverseToken {
  kind: 'gmail.draft';
  draft_id: string;
}

export interface CreateDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  threadId: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId: string;
}

export interface CreateDraftResult {
  draftId: string;
  messageId: string;
  reverseToken: GmailDraftReverseToken;
}

// Build a minimal RFC822 message and base64url-encode it for the Gmail API.
function buildRfc822(input: CreateDraftInput): string {
  const lines = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `In-Reply-To: ${input.inReplyToMessageId}`,
    `References: ${input.inReplyToMessageId}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.bodyText,
  ];
  const raw = lines.join('\r\n');
  // base64url-encode (Gmail requires url-safe alphabet, no padding)
  const b64 = btoa(unescape(encodeURIComponent(raw)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailCreateDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
  const raw = buildRfc822(input);
  const res = await input.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: { threadId: input.threadId, raw } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.create ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id: string; message: { id: string } };
  return {
    draftId: j.id,
    messageId: j.message.id,
    reverseToken: { kind: 'gmail.draft', draft_id: j.id },
  };
}

export interface UpdateDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  draftId: string;
  threadId: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyToMessageId: string;
}

// Replace a draft's content (used when the user edits the reply before sending).
// Gmail drafts.update requires the full re-encoded RFC822 message, same shape as
// create — we just PUT it onto the existing draft id.
export async function gmailUpdateDraft(input: UpdateDraftInput): Promise<void> {
  const raw = buildRfc822({
    fetch: input.fetch,
    accessToken: input.accessToken,
    threadId: input.threadId,
    to: input.to,
    subject: input.subject,
    bodyText: input.bodyText,
    inReplyToMessageId: input.inReplyToMessageId,
  });
  const res = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${input.draftId}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: input.draftId, message: { threadId: input.threadId, raw } }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.update ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export interface SendDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  draftId: string;
}

export interface SendDraftResult {
  messageId: string;
}

export async function gmailSendDraft(input: SendDraftInput): Promise<SendDraftResult> {
  const res = await input.fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: input.draftId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.send ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { id: string };
  return { messageId: j.id };
}

export interface DeleteDraftInput {
  fetch: GmailFetch;
  accessToken: string;
  draftId: string;
}

export async function gmailDeleteDraft(input: DeleteDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${input.draftId}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  // 204/2xx = deleted. 404 = already gone — for an undo that's the desired
  // end state, so treat it as success (idempotent). Anything else is real.
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail drafts.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}
