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

export interface OutlookMoveReverseToken {
  kind: 'graph.move';
  new_message_id: string;
  original_folder_id: string | null;
}

export interface OutlookMoveMessageInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  destinationFolderId: string;
  originalFolderId?: string | null;
}

export interface OutlookMoveMessageResult {
  newMessageId: string;
  reverseToken: OutlookMoveReverseToken;
}

export async function outlookMoveMessage(
  input: OutlookMoveMessageInput,
): Promise<OutlookMoveMessageResult> {
  // Look up the current folder BEFORE moving so the reverse token
  // can drive an "Undo archive" later. Caller may pass originalFolderId
  // to skip the pre-fetch.
  let originalFolderId = input.originalFolderId ?? null;
  if (originalFolderId == null) {
    const getRes = await input.fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}?$select=parentFolderId`,
      { method: 'GET', headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    if (!getRes.ok) {
      const detail = await getRes.text().catch(() => '');
      throw new Error(`graph messages.get ${getRes.status}: ${detail.slice(0, 200)}`);
    }
    const cur = (await getRes.json()) as { parentFolderId?: string };
    originalFolderId = cur.parentFolderId ?? null;
  }

  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}/move`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationId: input.destinationFolderId }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.move ${res.status}: ${detail.slice(0, 200)}`);
  }
  const moved = (await res.json()) as { id: string };
  return {
    newMessageId: moved.id,
    reverseToken: {
      kind: 'graph.move',
      new_message_id: moved.id,
      original_folder_id: originalFolderId,
    },
  };
}

export interface OutlookFlagReverseToken {
  kind: 'graph.flag';
  message_id: string;
  previous: 'flagged' | 'notFlagged';
}

export interface OutlookSetFlagInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  flagged: boolean;
}

export async function outlookSetFlag(
  input: OutlookSetFlagInput,
): Promise<{ reverseToken: OutlookFlagReverseToken }> {
  const status = input.flagged ? 'flagged' : 'notFlagged';
  const res = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ flag: { flagStatus: status } }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`graph messages.flag ${res.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'graph.flag',
      message_id: input.messageId,
      previous: input.flagged ? 'notFlagged' : 'flagged',
    },
  };
}

export interface OutlookCategoryReverseToken {
  kind: 'graph.category';
  message_id: string;
  category: string;
  previous_categories: string[];
}

export interface OutlookAddCategoryInput {
  fetch: OutlookFetch;
  accessToken: string;
  messageId: string;
  category: string;
}

export async function outlookAddCategory(
  input: OutlookAddCategoryInput,
): Promise<{ reverseToken: OutlookCategoryReverseToken }> {
  const getRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}?$select=categories`,
    { method: 'GET', headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  if (!getRes.ok) {
    const detail = await getRes.text().catch(() => '');
    throw new Error(`graph messages.get ${getRes.status}: ${detail.slice(0, 200)}`);
  }
  const existing = ((await getRes.json()) as { categories?: string[] }).categories ?? [];
  if (existing.includes(input.category)) {
    return {
      reverseToken: {
        kind: 'graph.category',
        message_id: input.messageId,
        category: input.category,
        previous_categories: existing,
      },
    };
  }
  const next = [...existing, input.category];
  const patchRes = await input.fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${input.messageId}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ categories: next }),
    },
  );
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    throw new Error(`graph messages.category ${patchRes.status}: ${detail.slice(0, 200)}`);
  }
  return {
    reverseToken: {
      kind: 'graph.category',
      message_id: input.messageId,
      category: input.category,
      previous_categories: existing,
    },
  };
}
