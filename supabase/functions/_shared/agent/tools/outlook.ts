// supabase/functions/_shared/agent/tools/outlook.ts
//
// Microsoft Graph write operations used by phase-3 mail-draft/send tools.
// The `fetch` parameter is injectable so unit tests can stub the network
// without monkey-patching globalThis.

export type OutlookFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface OutlookDraftReverseToken {
  kind: 'graph.draft';
  draft_id: string;
}

export interface OutlookCreateDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  inReplyToMessageId: string;
  bodyText: string;
}

export interface OutlookCreateDraftResult {
  draftId: string;
  reverseToken: OutlookDraftReverseToken;
}

export async function outlookCreateDraft(
  input: OutlookCreateDraftInput,
): Promise<OutlookCreateDraftResult> {
  // Step 1: createReply pre-fills To/Subject and threads the message.
  const replyRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.inReplyToMessageId}/createReply`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!replyRes.ok) {
    const detail = await replyRes.text().catch(() => '');
    throw new Error(`graph createReply ${replyRes.status}: ${detail.slice(0, 200)}`);
  }
  const draft = (await replyRes.json()) as { id: string };

  // Step 2: PATCH the body with the agent-written content.
  const patchRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${draft.id}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        body: { contentType: 'Text', content: input.bodyText },
      }),
    },
  );
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`graph messages.patch ${patchRes.status}: ${detail.slice(0, 200)}`);
  }
  return {
    draftId: draft.id,
    reverseToken: { kind: 'graph.draft', draft_id: draft.id },
  };
}

export interface OutlookSendDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  draftId: string;
}

export async function outlookSendDraft(input: OutlookSendDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.draftId}/send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 202) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.send ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export interface OutlookDeleteDraftInput {
  fetch: OutlookFetch;
  accessToken: string;
  draftId: string;
}

export async function outlookDeleteDraft(input: OutlookDeleteDraftInput): Promise<void> {
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.draftId}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  );
  if (!res.ok && res.status !== 204) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.delete ${res.status}: ${detail.slice(0, 200)}`);
  }
}
