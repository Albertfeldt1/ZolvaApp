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
export function copenhagenDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const DUE_LEAD_MS = 12 * 60 * 60 * 1000;   // you_owe: nudge within 12h of due (deadline-proximate)
const MIN_AGE_MS = 4 * 60 * 60 * 1000;     // you_owe: never nudge a promise younger than this
const SILENCE_MS = 3 * DAY_MS;             // owed_to_you: 3 days of silence

export function selectDue(rows: CommitmentRow[], now: Date): CommitmentRow[] {
  const nowMs = now.getTime();
  const today = copenhagenDay(now);
  return rows.filter((r) => {
    if (r.status !== 'open') return false;
    if (r.direction === 'you_owe') {
      if (!r.due_at) return false;
      // Min-age floor: don't nudge a promise the user just made — a reminder is
      // useless seconds after you said "I'll send it". Combined with the 12h
      // lead and the quiet-hours gate, a daytime deadline first nudges the
      // morning of (overnight-eligible nudges are held to the 07:00 sweep), and
      // a vague/inferred deadline (sits at send-time +2d) won't fire until the
      // promise has aged ~1.5 days. True "already handled it?" suppression is
      // the thread-reconciliation path (Slice 3), not this.
      const created = new Date(r.created_at).getTime();
      if (Number.isNaN(created) || created > nowMs - MIN_AGE_MS) return false;
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

const EXPIRE_GRACE_MS = 7 * DAY_MS;

export interface ThreadState {
  // Newest message timestamp in the source thread (null when not fetched).
  lastMessageAt: string | null;
  // Who sent that newest message relative to the user.
  lastDirection: 'inbound' | 'outbound' | null;
}

// Decide the next status for an open commitment given current thread state.
// Returns the fields to update, or null when nothing changes. Order matters:
// resolution (the loop is closed) wins over expiry (the loop went stale).
export function applyReconcile(
  row: CommitmentRow,
  thread: ThreadState,
  now: Date,
): { status: 'resolved'; resolved_at: string } | { status: 'expired' } | null {
  if (row.status !== 'open') return null;
  const nowIso = now.toISOString();

  if (thread.lastMessageAt && thread.lastDirection) {
    const last = new Date(thread.lastMessageAt).getTime();
    if (row.direction === 'owed_to_you' && thread.lastDirection === 'inbound') {
      const prev = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
      if (last > prev) return { status: 'resolved', resolved_at: nowIso };
    }
    if (row.direction === 'you_owe' && thread.lastDirection === 'outbound') {
      const created = new Date(row.created_at).getTime();
      if (last > created) return { status: 'resolved', resolved_at: nowIso };
    }
  }

  // Expiry is direction-agnostic: any open row whose due_at has passed by the
  // grace period is expired, including an owed_to_you with an inferred due date
  // that lapsed. An owed_to_you with no due_at at all is intentionally closed
  // only via reconciliation/dismiss in v1, not auto-expiry.
  if (row.due_at) {
    const due = new Date(row.due_at).getTime();
    if (!Number.isNaN(due) && now.getTime() > due + EXPIRE_GRACE_MS) {
      return { status: 'expired' };
    }
  }
  return null;
}

// Minimal shape of a Gmail thread fetched with format=minimal: messages
// oldest-first, each carrying labelIds + internalDate (ms-epoch string).
export interface GmailThreadMeta {
  messages?: Array<{ labelIds?: string[]; internalDate?: string }>;
}

// Derive ThreadState from a Gmail thread. The newest message is the last in the
// array (Gmail returns oldest-first). Its direction is outbound iff it carries
// the SENT label — which excludes DRAFT-only messages, so the agent's own
// unsent drafts never look like a resolution. Kept pure (parse only, no fetch)
// so the reconcile signal is unit-tested rather than assumed.
export function parseGmailThreadState(thread: GmailThreadMeta): ThreadState {
  const msgs = thread.messages ?? [];
  if (msgs.length === 0) return { lastMessageAt: null, lastDirection: null };
  const last = msgs[msgs.length - 1];
  const ms = Number(last.internalDate);
  const lastMessageAt = Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  const lastDirection = (last.labelIds ?? []).includes('SENT') ? 'outbound' : 'inbound';
  return { lastMessageAt, lastDirection };
}

// Minimal shape of one Outlook message as Graph returns it for thread-state.
export interface GraphMessageLite {
  from?: { emailAddress?: { address?: string } };
  sentDateTime?: string;
}

// Derive ThreadState from the NEWEST message in an Outlook conversation. Graph
// is queried with $orderby=sentDateTime desc & $top=1, so the caller passes that
// single newest message. Direction is outbound when the sender address matches
// the mailbox owner (case-insensitive) — the Graph analogue of Gmail's SENT
// label. When sender or owner is unknown the direction is left null, which
// reconcile reads as "no movement" (safe: it won't resolve on a guess).
export function parseGraphThreadState(
  newest: GraphMessageLite | undefined,
  ownerAddress: string,
): ThreadState {
  if (!newest) return { lastMessageAt: null, lastDirection: null };
  const at = newest.sentDateTime ?? null;
  const ms = at ? new Date(at).getTime() : NaN;
  const lastMessageAt = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  const from = (newest.from?.emailAddress?.address ?? '').toLowerCase();
  const owner = (ownerAddress ?? '').toLowerCase();
  const lastDirection: 'inbound' | 'outbound' | null =
    from && owner ? (from === owner ? 'outbound' : 'inbound') : null;
  return { lastMessageAt, lastDirection };
}

export interface CommitmentNudge {
  action_kind: 'commitment';   // always 'commitment' — the rate-limit category
  target_id: string;     // thread_id — one nudge per loop per day
  title: string;         // Danish, <= 40 chars
  body: string;          // Danish, <= 140 chars
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function buildCommitmentNudge(row: CommitmentRow): CommitmentNudge {
  const who = row.counterparty || 'nogen';
  const title = row.direction === 'you_owe' ? 'Du skylder et svar' : 'Du venter på svar';
  const body = row.direction === 'you_owe'
    ? `Du lovede ${who}: ${row.summary}`
    : `Du venter stadig på svar fra ${who}: ${row.summary}`;
  return {
    action_kind: 'commitment',
    target_id: row.thread_id,
    title: clamp(title, 40),
    body: clamp(body, 140),
  };
}
