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

// Europe/Copenhagen calendar day (YYYY-MM-DD) — matches the nudge.push idem
// day component so "already nudged today" lines up with local midnight.
function copenhagenDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const DUE_LEAD_MS = 24 * 60 * 60 * 1000;   // you_owe: nudge within 24h of due
const SILENCE_MS = 3 * DAY_MS;             // owed_to_you: 3 days of silence

export function selectDue(rows: CommitmentRow[], now: Date): CommitmentRow[] {
  const nowMs = now.getTime();
  const today = copenhagenDay(now);
  return rows.filter((r) => {
    if (r.status !== 'open') return false;
    if (r.direction === 'you_owe') {
      if (!r.due_at) return false;
      const due = new Date(r.due_at).getTime();
      if (Number.isNaN(due) || due > nowMs + DUE_LEAD_MS) return false;
      // Once per day until resolved.
      return !(r.nudged_at && copenhagenDay(new Date(r.nudged_at)) === today);
    }
    // owed_to_you: silent past the threshold, nudged at most once ever.
    if (r.nudged_at) return false;
    if (!r.last_message_at) return false;
    const last = new Date(r.last_message_at).getTime();
    return !Number.isNaN(last) && last <= nowMs - SILENCE_MS;
  });
}
