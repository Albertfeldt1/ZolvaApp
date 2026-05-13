// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionMode, ActionType } from '../types.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  gmailCreateDraft,
  gmailSendDraft,
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
  outlookSendDraft,
  type OutlookFetch,
  type OutlookDraftReverseToken,
  type OutlookMoveReverseToken,
  type OutlookFlagReverseToken,
  type OutlookCategoryReverseToken,
} from './outlook.ts';
import { gmailGetBody, outlookGetBody } from './mail-body.ts';

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

// Safety hooks the runner can pass in to authorize an auto-send. Each
// predicate is async because real implementations hit Supabase. The
// dispatcher only reads these from inside the mail.send_reply auto path.
export interface ExecuteSafetyContext {
  userIsIdle: boolean;
  hasRecipientHistory: (address: string) => Promise<boolean>;
  hasPriorFailedIdem: (idemKey: string) => Promise<boolean>;
}

export interface ExecuteOptions {
  policy?: ActionMode;
  safety?: ExecuteSafetyContext;
}

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
  opts: ExecuteOptions = {},
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
        throw new Error('outlook category remove not yet supported');
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
    case 'mail.get_body': {
      const threadId = mustString(payload, 'thread_id');
      if (provider === 'google') {
        const r = await gmailGetBody({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          threadId,
        });
        return {
          mode: 'executed',
          reversible: false,
          reverseToken: null,
          recordPayload: {
            provider,
            thread_id: threadId,
            from: r.from,
            to: r.to,
            subject: r.subject,
            sent_at: r.sent_at,
            body_text: r.body_text,
          },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook get_body requested but outlook context missing');
      }
      const r = await outlookGetBody({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        threadId,
      });
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: {
          provider,
          thread_id: threadId,
          from: r.from,
          to: r.to,
          subject: r.subject,
          sent_at: r.sent_at,
          body_text: r.body_text,
        },
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
      // Two paths:
      // 1. Default / propose: dispatcher does NOT execute the send. Runner
      //    writes a proposed_actions row; agent-approve sends when the
      //    user taps Send.
      // 2. Auto: caller passes opts.policy='auto' AND a safety context.
      //    All three rails (idle, recipient allow-listed, no prior failed
      //    idem) must hold or we fall back to propose.
      const threadId = mustString(payload, 'thread_id');
      const draftId = mustString(payload, 'draft_id');
      const draftHash = mustString(payload, 'draft_hash');
      const previewText = mustString(payload, 'preview_text');
      const toAddr = mustString(payload, 'to');

      const baseRecord: Record<string, unknown> = {
        provider,
        thread_id: threadId,
        draft_id: draftId,
        draft_hash: draftHash,
        preview_text: previewText,
        to: toAddr,
      };

      if (opts.policy !== 'auto' || !opts.safety) {
        return {
          mode: 'propose',
          reversible: false,
          reverseToken: null,
          recordPayload: baseRecord,
        };
      }

      // Auto-send path — every rail must hold.
      const idemKey = `${threadId}::${draftHash}`;
      const [recipientResult, priorFailResult] = await Promise.allSettled([
        opts.safety.hasRecipientHistory(toAddr),
        opts.safety.hasPriorFailedIdem(idemKey),
      ]);
      // Fail-safe: rejection treats recipient as not in allowlist, prior-fail as true.
      const recipientOk = recipientResult.status === 'fulfilled' && recipientResult.value;
      const priorFail = priorFailResult.status !== 'fulfilled' || priorFailResult.value;
      if (!opts.safety.userIsIdle || !recipientOk || priorFail) {
        return {
          mode: 'propose',
          reversible: false,
          reverseToken: null,
          recordPayload: baseRecord,
        };
      }

      if (provider === 'google') {
        await gmailSendDraft({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          draftId,
        });
      } else {
        if (!ctx.outlook) {
          throw new Error('outlook send requested but outlook context missing');
        }
        await outlookSendDraft({
          fetch: ctx.fetch,
          accessToken: ctx.outlook.accessToken,
          draftId,
        });
      }
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: baseRecord,
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
