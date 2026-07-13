import { useEffect, useId, useState } from 'react';
import { supabase } from './supabase';
import { decideDemoProposal, getDemoProposals, isDemoUserId, subscribeDemoAgent } from './demo-data';

export interface ProposedActionRow {
  id: string;
  action_type: 'mail.send_reply' | 'mail.draft_reply' | string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: 'pending' | 'approved' | 'dismissed' | 'expired' | 'executed' | 'failed';
  created_at: string;
  expires_at: string | null;
}

export function mergeProposedActions(
  existing: ProposedActionRow[],
  incoming: ProposedActionRow,
): ProposedActionRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return next;
}

export function useProposedActions(userId: string | null | undefined): {
  rows: ProposedActionRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<ProposedActionRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const instanceId = useId();

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setLoading(false); return; }
    if (isDemoUserId(userId)) {
      const sync = () => setRows(getDemoProposals());
      sync();
      setLoading(false);
      return subscribeDemoAgent(sync);
    }
    (async () => {
      const { data, error } = await supabase
        .from('proposed_actions')
        .select('id, action_type, payload, preview, status, created_at, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) console.warn('[agent-proposals] read failed:', error.message);
      setRows((data ?? []) as ProposedActionRow[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`proposed_actions:${userId}:${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'proposed_actions', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as ProposedActionRow;
          if (!next?.id) return;
          setRows((prev) => mergeProposedActions(prev, next));
        },
      )
      .subscribe();

    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [userId, instanceId]);

  return { rows, loading };
}

export function usePendingProposalCount(userId: string | null | undefined): number {
  const { rows } = useProposedActions(userId);
  return rows.filter((r) => r.status === 'pending').length;
}

export async function approveProposedAction(actionId: string, editedBody?: string): Promise<{ ok: boolean; error?: string }> {
  if (actionId.startsWith('demo-')) {
    return decideDemoProposal(actionId, 'approved') ? { ok: true } : { ok: false, error: 'not pending' };
  }
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'no session' };
  const baseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
  const res = await fetch(`${baseUrl}/functions/v1/agent-approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: actionId, edited_body: editedBody }),
  });
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const j = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error };
}

export async function dismissProposedAction(actionId: string): Promise<{ ok: boolean; error?: string }> {
  if (actionId.startsWith('demo-')) {
    return decideDemoProposal(actionId, 'dismissed') ? { ok: true } : { ok: false, error: 'not pending' };
  }
  // Routed through the edge function (not a direct table update) so the server
  // can also delete the underlying mail draft — otherwise "Spring over" leaves
  // an orphan draft in the user's mailbox.
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'no session' };
  const baseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
  const res = await fetch(`${baseUrl}/functions/v1/agent-dismiss`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: actionId }),
  });
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const j = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error };
}
