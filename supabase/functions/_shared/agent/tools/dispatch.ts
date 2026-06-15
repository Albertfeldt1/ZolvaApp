// supabase/functions/_shared/agent/tools/dispatch.ts
import type { ActionMode, ActionType } from '../types.ts';
import { deriveIdemKey } from '../idem.ts';
import {
  gmailModifyThread,
  resolveLabelId,
  gmailCreateDraft,
  gmailSendDraft,
  gmailUpdateDraft,
  ZOLVA_FLAGGED_LABEL,
  type GmailFetch,
  type GmailModifyReverseToken,
  type GmailDraftReverseToken,
} from './gmail.ts';
import {
  outlookCreateDraft,
  outlookResolveLatestMessageId,
  outlookMoveMessage,
  outlookSetFlag,
  outlookAddCategory,
  outlookSendDraft,
  outlookUpdateDraft,
  type OutlookFetch,
  type OutlookDraftReverseToken,
  type OutlookMoveReverseToken,
  type OutlookFlagReverseToken,
  type OutlookCategoryReverseToken,
} from './outlook.ts';
import { gmailGetBody, outlookGetBody } from './mail-body.ts';
import { googleListEvents, outlookListEvents } from './calendar.ts';
import { computeFreeSlots, type BusyInterval } from '../free-slots.ts';
import {
  googleCreateEvent,
  outlookCreateEvent,
  googleUpdateEvent,
  outlookUpdateEvent,
  type EventPatch,
  type GcalEventDeleteToken,
  type GcalEventRestoreToken,
  type GraphEventDeleteToken,
  type GraphEventRestoreToken,
} from './calendar-write.ts';
import { driveSearchFiles } from './drive.ts';
import { gmailSearch, outlookSearch } from './mail-search.ts';

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
  | GcalEventDeleteToken
  | GcalEventRestoreToken
  | GraphEventDeleteToken
  | GraphEventRestoreToken
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
  // Fourth rail: refuse auto-send on threads the agent never opened with
  // mail.get_body during the same run. The runner populates a per-run
  // Set<thread_id>; this predicate is sync because it's a Set lookup.
  threadWasResearched: (threadId: string) => boolean;
  // Guardrail gate: false when the input rail tainted the run or the output
  // rail flagged this reply. Computed by the runner (it owns the Claude creds);
  // dispatch only enforces it. Failing it degrades to propose like every other
  // gate.
  railsOk: boolean;
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
  // nudge.push is the one action that carries no email/calendar provider — it
  // sends a push notification. Validate + shape its payload here; the actual
  // push send happens in the runner (after the agent_actions row is inserted,
  // which is what rate-limits it). Handled before mustProvider so the absent
  // provider field doesn't throw.
  if (action === 'nudge.push') {
    return {
      mode: 'executed',
      reversible: false,
      reverseToken: null,
      recordPayload: {
        action_kind: mustString(payload, 'action_kind'),
        target_id: mustString(payload, 'target_id'),
        title: mustString(payload, 'title'),
        body: mustString(payload, 'body'),
      },
    };
  }

  // commitment.record writes to our own agent_commitments table — no provider
  // API call. Like nudge.push, the dispatcher only validates + shapes; the
  // runner performs the upsert via deps.recordCommitment. Handled before
  // mustProvider so the (present) provider field is validated by mustString,
  // not the generic provider guard.
  if (action === 'commitment.record') {
    const direction = mustString(payload, 'direction');
    if (direction !== 'you_owe' && direction !== 'owed_to_you') {
      throw new Error(`commitment.record invalid direction ${direction}`);
    }
    const rec: Record<string, unknown> = {
      direction,
      counterparty: mustString(payload, 'counterparty'),
      summary: mustString(payload, 'summary'),
      thread_id: mustString(payload, 'thread_id'),
      provider: mustString(payload, 'provider'),
      source_excerpt: mustString(payload, 'source_excerpt'),
    };
    if (typeof payload.due_at === 'string' && payload.due_at) rec.due_at = payload.due_at;
    return { mode: 'executed', reversible: false, reverseToken: null, recordPayload: rec };
  }

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
    case 'cal.list_events': {
      const startIso = mustString(payload, 'start_iso');
      const endIso = mustString(payload, 'end_iso');
      if (provider === 'google') {
        // ctx.gmail.accessToken is the user's Google access token, which
        // covers every scope granted at consent — including
        // calendar.events (src/lib/auth.ts:65). The 'gmail' name is
        // historical; the token works for Drive + Calendar too.
        const events = await googleListEvents({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          startIso,
          endIso,
        });
        return {
          mode: 'executed',
          reversible: false,
          reverseToken: null,
          recordPayload: { provider, start_iso: startIso, end_iso: endIso, events },
        };
      }
      if (!ctx.outlook) throw new Error('outlook cal_list_events requested but outlook context missing');
      const events = await outlookListEvents({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        startIso,
        endIso,
      });
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: { provider, start_iso: startIso, end_iso: endIso, events },
      };
    }
    case 'cal.find_free_slots': {
      // Context-only, like cal.list_events: read busy events in the window,
      // then compute free slots deterministically. No agent_actions row.
      const durationMinutes = typeof payload.duration_minutes === 'number'
        ? payload.duration_minutes
        : 30;
      const daysAhead = typeof payload.days_ahead === 'number' ? payload.days_ahead : 7;
      const now = new Date();
      const fromIso = now.toISOString();
      const toIso = new Date(now.getTime() + daysAhead * 86_400_000).toISOString();

      let events: Awaited<ReturnType<typeof googleListEvents>>;
      if (provider === 'google') {
        events = await googleListEvents({
          fetch: ctx.fetch,
          accessToken: ctx.gmail.accessToken,
          startIso: fromIso,
          endIso: toIso,
        });
      } else {
        if (!ctx.outlook) {
          throw new Error('outlook cal_find_free_slots requested but outlook context missing');
        }
        events = await outlookListEvents({
          fetch: ctx.fetch,
          accessToken: ctx.outlook.accessToken,
          startIso: fromIso,
          endIso: toIso,
        });
      }

      const busy: BusyInterval[] = events.map((e) => ({ start: e.start, end: e.end }));
      const slots = computeFreeSlots(busy, {
        fromIso,
        toIso,
        tz: 'Europe/Copenhagen',
        workdayStartHour: 9,
        workdayEndHour: 17,
        slotMinutes: durationMinutes,
        maxSlots: 3,
      });
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: { provider, slots },
      };
    }
    case 'mail.search': {
      const query = mustString(payload, 'query');
      const limit = typeof payload.limit === 'number' ? payload.limit : 10;
      const hits = provider === 'google'
        ? await gmailSearch({ fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, query, limit })
        : await (async () => {
            if (!ctx.outlook) throw new Error('outlook mail.search requested but outlook context missing');
            return outlookSearch({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, query, limit });
          })();
      return { mode: 'executed', reversible: false, reverseToken: null, recordPayload: { provider, query, hits } };
    }
    case 'drive.search': {
      // Google-only for Phase 4a. OneDrive search is Phase 4b.
      if (provider !== 'google') {
        throw new Error('drive.search: only google supported in phase 4a');
      }
      const query = mustString(payload, 'query');
      const limit = typeof payload.limit === 'number' ? payload.limit : 10;
      const files = await driveSearchFiles({
        fetch: ctx.fetch,
        // Same Google access token covers drive.file via the OAuth grant
        // (src/lib/auth.ts).
        accessToken: ctx.gmail.accessToken,
        query,
        limit,
      });
      return {
        mode: 'executed',
        reversible: false,
        reverseToken: null,
        recordPayload: { provider, query, files },
      };
    }
    case 'mail.draft_reply': {
      const threadId = mustString(payload, 'thread_id');
      const inReplyTo = mustString(payload, 'in_reply_to_message_id');
      const bodyText = mustString(payload, 'body');
      // Idempotency hash of the body. deriveIdemKey + the send-path idem key
      // both require draft_hash, and send_reply must reference the SAME value,
      // so we compute it here and hand it back to Claude in the tool result.
      const draftHash = await sha1Hex(bodyText);
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
            draft_hash: draftHash,
            message_id: out.messageId,
            to,
            subject,
            body_preview: bodyText.slice(0, 200),
            body_full: bodyText,
            in_reply_to_message_id: inReplyTo,
          },
        };
      }
      if (!ctx.outlook) {
        throw new Error('outlook draft requested but outlook context missing');
      }
      // The agent only ever holds the conversationId (thread_id) for Outlook;
      // createReply needs a real Graph message id, so resolve the latest
      // message in the conversation instead of trusting in_reply_to (which is
      // the conversationId or a hallucination, and would 404).
      const replyTargetId = await outlookResolveLatestMessageId({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        conversationId: threadId,
      });
      const out = await outlookCreateDraft({
        fetch: ctx.fetch,
        accessToken: ctx.outlook.accessToken,
        inReplyToMessageId: replyTargetId,
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
          draft_hash: draftHash,
          message_id: replyTargetId,
          body_preview: bodyText.slice(0, 200),
          body_full: bodyText,
          in_reply_to_message_id: replyTargetId,
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

      // Fourth rail (cheap, sync): refuse auto-send on a thread the agent
      // never opened with mail.get_body during this run. Body-grounding is
      // mandatory — we don't send "yes I'm free" off the snippet alone.
      // Checked before the Promise.allSettled so we skip wasted DB reads.
      if (!opts.safety.threadWasResearched(threadId)) {
        return {
          mode: 'propose',
          reversible: false,
          reverseToken: null,
          recordPayload: baseRecord,
        };
      }

      // Auto-send path — every rail must hold. The prior-failed lookup key MUST
      // match what the runner stored on proposed_actions.payload.idem_key
      // (deriveIdemKey), or the rail silently never matches a prior failure.
      const idemKey = deriveIdemKey('mail.send_reply', { thread_id: threadId, draft_hash: draftHash });
      const [recipientResult, priorFailResult] = await Promise.allSettled([
        opts.safety.hasRecipientHistory(toAddr),
        opts.safety.hasPriorFailedIdem(idemKey),
      ]);
      // Fail-safe: rejection treats recipient as not in allowlist, prior-fail as true.
      const recipientOk = recipientResult.status === 'fulfilled' && recipientResult.value;
      const priorFail = priorFailResult.status !== 'fulfilled' || priorFailResult.value;
      if (!opts.safety.userIsIdle || !recipientOk || priorFail || !opts.safety.railsOk) {
        return {
          mode: 'propose',
          reversible: false,
          reverseToken: null,
          recordPayload: baseRecord,
        };
      }

      // If the user edited the reply in the approval modal, push the edit onto
      // the draft before sending so what they saw is what actually goes out.
      // (edited_body is only present on the agent-approve path; unattended
      // auto-sends never carry it.)
      const editedBody = typeof payload.edited_body === 'string' ? payload.edited_body.trim() : '';
      if (editedBody) {
        if (provider === 'google') {
          await gmailUpdateDraft({
            fetch: ctx.fetch,
            accessToken: ctx.gmail.accessToken,
            draftId,
            threadId,
            to: toAddr,
            subject: mustString(payload, 'subject'),
            bodyText: editedBody,
            inReplyToMessageId: mustString(payload, 'in_reply_to_message_id'),
          });
        } else {
          if (!ctx.outlook) throw new Error('outlook send requested but outlook context missing');
          await outlookUpdateDraft({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, draftId, bodyText: editedBody });
        }
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
    case 'cal.create_event': {
      const title = mustString(payload, 'title');
      const startIso = mustString(payload, 'start_iso');
      const endIso = mustString(payload, 'end_iso');
      const attendees = Array.isArray(payload.attendees)
        ? (payload.attendees as unknown[]).filter((a): a is string => typeof a === 'string')
        : undefined;
      const location = typeof payload.location === 'string' ? payload.location : undefined;
      const baseRecord: Record<string, unknown> = { provider, title, start_iso: startIso, end_iso: endIso };
      if (attendees && attendees.length) baseRecord.attendees = attendees;
      if (location) baseRecord.location = location;

      // Propose path: no write. Runner writes a proposed_actions row; the real
      // create happens when agent-approve re-dispatches with policy='auto'.
      if (opts.policy !== 'auto') {
        return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
      }
      if (provider === 'google') {
        const out = await googleCreateEvent({
          fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, title, startIso, endIso, attendees, location,
        });
        return {
          mode: 'executed', reversible: true, reverseToken: out.reverseToken,
          recordPayload: { ...baseRecord, event_id: out.eventId },
        };
      }
      if (!ctx.outlook) throw new Error('outlook create_event requested but outlook context missing');
      const out = await outlookCreateEvent({
        fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, title, startIso, endIso, attendees, location,
      });
      return {
        mode: 'executed', reversible: true, reverseToken: out.reverseToken,
        recordPayload: { ...baseRecord, event_id: out.eventId },
      };
    }
    case 'cal.update_event': {
      const eventId = mustString(payload, 'event_id');
      const patch: EventPatch = {};
      if (typeof payload.title === 'string') patch.title = payload.title;
      if (typeof payload.start_iso === 'string') patch.startIso = payload.start_iso;
      if (typeof payload.end_iso === 'string') patch.endIso = payload.end_iso;
      if (typeof payload.location === 'string') patch.location = payload.location;
      if (Object.keys(patch).length === 0) {
        throw new Error('cal.update_event: no fields to change');
      }
      const baseRecord: Record<string, unknown> = { provider, event_id: eventId };
      if (patch.title !== undefined) baseRecord.title = patch.title;
      if (patch.startIso !== undefined) baseRecord.start_iso = patch.startIso;
      if (patch.endIso !== undefined) baseRecord.end_iso = patch.endIso;
      if (patch.location !== undefined) baseRecord.location = patch.location;

      if (opts.policy !== 'auto') {
        return { mode: 'propose', reversible: false, reverseToken: null, recordPayload: baseRecord };
      }
      if (provider === 'google') {
        const out = await googleUpdateEvent({ fetch: ctx.fetch, accessToken: ctx.gmail.accessToken, eventId, patch });
        return { mode: 'executed', reversible: true, reverseToken: out.reverseToken, recordPayload: baseRecord };
      }
      if (!ctx.outlook) throw new Error('outlook update_event requested but outlook context missing');
      const out = await outlookUpdateEvent({ fetch: ctx.fetch, accessToken: ctx.outlook.accessToken, eventId, patch });
      return { mode: 'executed', reversible: true, reverseToken: out.reverseToken, recordPayload: baseRecord };
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

// SHA-1 hex of a string — used as the body idempotency token (draft_hash).
// Not security-sensitive; it only needs to be deterministic so the same draft
// body maps to the same idem key across draft_reply → send_reply → approve.
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
