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
