// Pure selection of which facts are due for a memory follow-up. The DB query in
// the sweep already filters (confirmed, follow_up_at <= now, followed_up_at
// null); this re-applies the same predicate so the logic is unit-tested rather
// than assumed (this codebase's habit: prove the layer).

export interface FollowupFactRow {
  id: string;
  text: string;
  category: string;
  follow_up_at: string | null;   // ISO
  followed_up_at: string | null; // ISO, set once acted
  status: string;                // 'confirmed' expected
}

export function selectDueFollowups(facts: FollowupFactRow[], now: Date): FollowupFactRow[] {
  const nowMs = now.getTime();
  return facts.filter((f) => {
    if (f.status !== 'confirmed') return false;
    if (f.followed_up_at) return false;
    if (!f.follow_up_at) return false;
    const due = new Date(f.follow_up_at).getTime();
    return !Number.isNaN(due) && due <= nowMs;
  });
}

// fact.due agent_event payload. day is the Copenhagen calendar day, used by the
// per-day dedup index so a fact emits at most one event per day.
export function toFactDuePayload(f: FollowupFactRow, day: string): Record<string, unknown> {
  return { fact_id: f.id, text: f.text, category: f.category, follow_up_at: f.follow_up_at, day };
}
