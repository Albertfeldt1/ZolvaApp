// supabase/functions/_shared/agent/idem.ts
import type { ActionType } from './types.ts';

export type IdemPayload = Record<string, unknown>;

function req(payload: IdemPayload, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(`idem payload missing required field ${key}`);
  }
  return v;
}

export function deriveIdemKey(action: ActionType, payload: IdemPayload): string {
  switch (action) {
    case 'mail.label':
      return `mail.label:${req(payload, 'thread_id')}:${req(payload, 'label')}:${req(payload, 'op')}`;
    case 'mail.archive':
      return `mail.archive:${req(payload, 'thread_id')}`;
    case 'mail.summarize':
      return `mail.summarize:${req(payload, 'thread_id')}`;
    case 'mail.flag_important':
      return `mail.flag_important:${req(payload, 'thread_id')}`;
    case 'mail.draft_reply':
      return `mail.draft_reply:${req(payload, 'thread_id')}:${req(payload, 'draft_hash')}`;
    case 'mail.send_reply':
      return `mail.send_reply:${req(payload, 'thread_id')}:${req(payload, 'draft_hash')}`;
    default:
      // Phase 3+ action types reach this branch — caller is responsible
      // for not invoking it on unsupported types in Phase 2.
      throw new Error(`deriveIdemKey: unsupported action type ${action}`);
  }
}
