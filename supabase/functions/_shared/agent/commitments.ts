// supabase/functions/_shared/agent/commitments.ts
//
// Pure logic for commitment tracking: due-date inference, due-selection,
// reconciliation transitions, and nudge templating. No network, no Supabase —
// every function is a deterministic transform so the bulk of confidence lives
// in unit tests (this codebase's hard lesson: prove the layer, don't assume it).

export type CommitmentDirection = 'you_owe' | 'owed_to_you';
export type CommitmentStatus = 'open' | 'nudged' | 'resolved' | 'dismissed' | 'expired';

// What the extraction Claude pass produces (one per commitment_record call),
// before persistence fills in id/status/timestamps.
export interface ExtractedCommitment {
  direction: CommitmentDirection;
  counterparty: string;
  summary: string;
  due_at: string | null;        // explicit ISO if the mail named a deadline
  thread_id: string;
  provider: 'google' | 'microsoft';
  source_excerpt: string;
  last_message_at: string | null;
}

// A persisted row, as read back for reconcile/nudge.
export interface CommitmentRow {
  id: string;
  user_id: string;
  direction: CommitmentDirection;
  counterparty: string;
  summary: string;
  due_at: string | null;
  due_inferred: boolean;
  thread_id: string;
  provider: 'google' | 'microsoft';
  source_excerpt: string;
  last_message_at: string | null;
  status: CommitmentStatus;
  created_at: string;
  nudged_at: string | null;
  resolved_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Fill a soft due date when the mail named none. Calendar days (not business
// days) in v1 — deterministic and testable; business-day refinement is a
// future tweak noted in the spec.
export function resolveDue(
  direction: CommitmentDirection,
  explicitDueAt: string | null,
  anchorIso: string | null,
): { dueAt: string | null; inferred: boolean } {
  if (explicitDueAt) return { dueAt: explicitDueAt, inferred: false };
  if (!anchorIso) return { dueAt: null, inferred: false };
  const anchor = new Date(anchorIso).getTime();
  if (Number.isNaN(anchor)) return { dueAt: null, inferred: false };
  const offset = direction === 'you_owe' ? 2 * DAY_MS : 3 * DAY_MS;
  return { dueAt: new Date(anchor + offset).toISOString(), inferred: true };
}
