// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionType } from '../types.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  gmailCreateDraft,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
  type GmailModifyReverseToken,
  type GmailDraftReverseToken,
} from './gmail.ts';
import {
  outlookCreateDraft,
  outlookMoveMessage,
  outlookSetFlag,
  outlookAddCategory,
  type OutlookFetch,
  type OutlookDraftReverseToken,
  type OutlookMoveReverseToken,
  type OutlookFlagReverseToken,
  type OutlookCategoryReverseToken,
} from './outlook.ts';

export interface ExecuteContext {
  fetch: GmailFetch & OutlookFetch;
  gmail: { accessToken: string; resolveLabelId: (name: string) => Promise<string> };
  // Outlook is optional — only loaded if the user has a microsoft watcher.
  outlook?: { accessToken: string };
}

export type ExecuteReverseToken =
  | GmailModifyReverseToken
  | GmailDraftReverseToken
  | OutlookDraftReverseToken
  | OutlookMoveReverseToken
  | OutlookFlagReverseToken
  | OutlookCategoryReverseToken
  | null;

export type ExecuteMode = 'executed' | 'propose';

export interface ExecuteResult {
  mode: ExecuteMode;
  reversible: boolean;
  reverseToken: ExecuteReverseToken;
  recordPayload: Record<string, unknown>;
}

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  const provider = mustProvider(payload);

  switch (action) {
    case 'mail.archive': {
      const threadId = mustString(payload, 'thread_id');
      if (provider === 'google') {
        const { reverseToken } = await gmailModifyThread({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
          addLabelIds: [],
          removeLabelIds: ['INBOX'],
        });
        return {
          mode: 'executed',
          reversible: true,
          reverseToken,
          recordPayload: { provider, thread_id: threadId },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook archive requested but outlook context missing');
      }
      const archiveFolderId = mustString(payload, 'archive_folder_id');
      const { reverseToken } = await outlookMoveMessage({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        messageId: threadId,
        destinationFolderId: archiveFolderId,
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken,
        recordPayload: { provider, thread_id: threadId, archive_folder_id: archiveFolderId },
      };
    }
    case 'mail.label': {
      const threadId = mustString(payload, 'thread_id');
      const label = mustString(payload, 'label');
      const op = mustString(payload, 'op');
      if (op !== 'add' && op !== 'remove') {
        throw new Error(`mail.label op must be add|remove, got ${op}`);
      }
      if (provider === 'google') {
        const labelId = await ctx.gmail.resolveLabelId(label);
        const { reverseToken } = await gmailModifyThread({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
          addLabelIds: op === 'add' ? [labelId] : [],
          removeLabelIds: op === 'remove' ? [labelId] : [],
        });
        return {
          mode: 'executed',
          reversible: true,
          reverseToken,
          recordPayload: { provider, thread_id: threadId, label, op },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook label requested but outlook context missing');
      }
      if (op !== 'add') {
        throw new Error('outlook label remove not supported in phase 3.1');
      }
      const { reverseToken } = await outlookAddCategory({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        messageId: threadId,
        category: label,
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken,
        recordPayload: { provider, thread_id: threadId, label, op },
      };
    }
    case 'mail.flag_important': {
      const threadId = mustString(payload, 'thread_id');
      if (provider === 'google') {
        const labelId = await ctx.gmail.resolveLabelId(ZOLVA_FLAGGED_LABEL);
        const { reverseToken } = await gmailModifyThread({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
          addLabelIds: [labelId],
          removeLabelIds: [],
        });
        return {
          mode: 'executed',
          reversible: true,
          reverseToken,
          recordPayload: { provider, thread_id: threadId },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook flag requested but outlook context missing');
      }
      const { reverseToken } = await outlookSetFlag({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        messageId: threadId,
        flagged: true,
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken,
        recordPayload: { provider, thread_id: threadId },
      };
    }
    case 'mail.summarize': {
      const threadId = mustString(payload, 'thread_id');
      const summary = mustString(payload, 'summary');
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: { provider, thread_id: threadId, summary },
      };
    }
    case 'mail.draft_reply': {
      const threadId = mustString(payload, 'thread_id');
      const inReplyTo = mustString(payload, 'in_reply_to_message_id');
      const bodyText = mustString(payload, 'body');
      if (provider === 'google') {
        const to = mustString(payload, 'to');
        const subject = mustString(payload, 'subject');
        const out = await gmailCreateDraft({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
          to,
          subject,
          bodyText,
          inReplyToMessageId: inReplyTo,
        });
        return {
          mode: 'executed',
          reversible: true,
          reverseToken: out.reverseToken,
          recordPayload: {
            provider,
            thread_id: threadId,
            draft_id: out.draftId,
            message_id: out.messageId,
            body_preview: bodyText.slice(0, 200),
          },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook draft requested but outlook context missing');
      }
      const out = await outlookCreateDraft({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        inReplyToMessageId: inReplyTo,
        bodyText,
      });
      return {
        mode: 'executed',
        reversible: true,
        reverseToken: out.reverseToken,
        recordPayload: {
          provider,
          thread_id: threadId,
          draft_id: out.draftId,
          body_preview: bodyText.slice(0, 200),
        },
      };
    }
    case 'mail.send_reply': {
      // Proposal path: dispatcher does NOT execute the send. Runner writes
      // a proposed_actions row with this payload; agent-approve executes
      // later when the user taps Send.
      const threadId = mustString(payload, 'thread_id');
      const draftId = mustString(payload, 'draft_id');
      const draftHash = mustString(payload, 'draft_hash');
      const previewText = mustString(payload, 'preview_text');
      return {
        mode: 'propose',
        reversible: false,
        reverseToken: null,
        recordPayload: {
          provider,
          thread_id: threadId,
          draft_id: draftId,
          draft_hash: draftHash,
          preview_text: previewText,
        },
      };
    }
    default:
      throw new Error(`executeTool: unsupported action type ${action}`);
  }
}

function mustString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`tool payload missing required string field ${key}`);
  }
  return v;
}

function mustProvider(payload: Record<string, unknown>): 'google' | 'microsoft' {
  const v = payload.provider;
  if (v === 'google' || v === 'microsoft') return v;
  throw new Error(`tool payload missing or invalid provider (got ${String(v)})`);
}
