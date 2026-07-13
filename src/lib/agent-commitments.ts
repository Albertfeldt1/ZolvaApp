// src/lib/agent-commitments.ts
//
// Read-only client view of the agent_commitments table — the "Open loops" the
// agent is tracking (promises you owe, replies you're waiting on). The table
// has an owner-RLS SELECT policy; there is intentionally no client write path in
// this slice. Loops are opened/closed server-side by the agent-commitments
// sweep (Phase 2 reconcile), so the client only subscribes and renders.
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { getDemoCommitments, isDemoUserId, subscribeDemoAgent } from './demo-data';

export type CommitmentDirection = 'you_owe' | 'owed_to_you';

export interface CommitmentRow {
  id: string;
  direction: CommitmentDirection;
  counterparty: string;
  summary: string;
  due_at: string | null;
  due_inferred: boolean;
  thread_id: string;
  provider: 'google' | 'microsoft';
  status: 'open' | 'nudged' | 'resolved' | 'dismissed' | 'expired';
  created_at: string;
  nudged_at: string | null;
  resolved_at: string | null;
}

const SELECT_COLS =
  'id, direction, counterparty, summary, due_at, due_inferred, thread_id, provider, status, created_at, nudged_at, resolved_at';

// Merge a realtime row into the list. Drops it when it's no longer open (a
// reconcile that resolves/expires a loop must remove it from the view), and
// keeps the list sorted you_owe-first then oldest-first so the most pressing
// loop sits at the top of each group.
export function mergeOpenCommitments(
  existing: CommitmentRow[],
  incoming: CommitmentRow,
): CommitmentRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  if (incoming.status !== 'open') return without;
  const next = [...without, incoming];
  next.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'you_owe' ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  });
  return next;
}

export function useOpenCommitments(userId: string | null | undefined): {
  rows: CommitmentRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<CommitmentRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setRows([]);
      setLoading(false);
      return;
    }
    if (isDemoUserId(userId)) {
      const sync = () => setRows(getDemoCommitments());
      sync();
      setLoading(false);
      return subscribeDemoAgent(sync);
    }
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('agent_commitments')
        .select(SELECT_COLS)
        .eq('user_id', userId)
        .eq('status', 'open');
      if (cancelled) return;
      if (error) console.warn('[agent-commitments] read failed:', error.message);
      const list = (data ?? []) as CommitmentRow[];
      list.sort((a, b) => {
        if (a.direction !== b.direction) return a.direction === 'you_owe' ? -1 : 1;
        return a.created_at < b.created_at ? -1 : 1;
      });
      setRows(list);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`agent_commitments:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_commitments', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as CommitmentRow;
          if (!next || !next.id) return;
          setRows((prev) => mergeOpenCommitments(prev, next));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return { rows, loading };
}
