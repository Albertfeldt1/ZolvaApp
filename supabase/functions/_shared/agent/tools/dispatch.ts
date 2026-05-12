// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionType } from '../types.ts';
import {
  gmailModifyThread,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
  type GmailModifyReverseToken,
} from './gmail.ts';

export interface ExecuteContext {
  accessToken: string;
  fetch: GmailFetch;
  // Pluggable so tests don't need to stub the label-list/create calls.
  resolveLabelId: (name: string) => Promise<string>;
}

export type ExecuteReverseToken = GmailModifyReverseToken | null;

export interface ExecuteResult {
  reversible: boolean;
  reverseToken: ExecuteReverseToken;
  // The payload the caller will store on agent_actions. Always includes
  // thread_id; mail.label / mail.flag_important add label, op; mail.summarize
  // adds summary text.
  recordPayload: Record<string, unknown>;
}

export async function executeTool(
  action: ActionType,
  payload: Record<string, unknown>,
  ctx: ExecuteContext,
): Promise<ExecuteResult> {
  switch (action) {
    case 'mail.archive': {
      const threadId = mustString(payload, 'thread_id');
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: [],
        removeLabelIds: ['INBOX'],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId },
      };
    }
    case 'mail.label': {
      const threadId = mustString(payload, 'thread_id');
      const label = mustString(payload, 'label');
      const op = mustString(payload, 'op'); // 'add' | 'remove'
      if (op !== 'add' && op !== 'remove') {
        throw new Error(`mail.label op must be add|remove, got ${op}`);
      }
      const labelId = await ctx.resolveLabelId(label);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: op === 'add' ? [labelId] : [],
        removeLabelIds: op === 'remove' ? [labelId] : [],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId, label, op },
      };
    }
    case 'mail.flag_important': {
      const threadId = mustString(payload, 'thread_id');
      const labelId = await ctx.resolveLabelId(ZOLVA_FLAGGED_LABEL);
      const { reverseToken } = await gmailModifyThread({
        fetch: ctx.fetch,
        accessToken: ctx.accessToken,
        threadId,
        addLabelIds: [labelId],
        removeLabelIds: [],
      });
      return {
        reversible: true,
        reverseToken,
        recordPayload: { thread_id: threadId },
      };
    }
    case 'mail.summarize': {
      const threadId = mustString(payload, 'thread_id');
      const summary = mustString(payload, 'summary');
      return {
        reversible: false,
        reverseToken: null,
        recordPayload: { thread_id: threadId, summary },
      };
    }
    default:
      throw new Error(`executeTool: unsupported action type ${action} (phase 2 only handles mail.* triage)`);
  }
}

function mustString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`tool payload missing required string field ${key}`);
  }
  return v;
}
