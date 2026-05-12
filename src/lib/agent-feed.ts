// src/lib/agent-feed.ts
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface AgentActionRow {
  id: string;
  action_type:
    | 'mail.label'
    | 'mail.archive'
    | 'mail.flag_important'
    | 'mail.summarize';
  payload: Record<string, unknown>;
  executed_at: string;
  reversible: boolean;
  reverse_token: Record<string, unknown> | null;
  reversed_at: string | null;
}

export function mergeAgentActions(
  existing: AgentActionRow[],
  incoming: AgentActionRow,
): AgentActionRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) => (a.executed_at < b.executed_at ? 1 : -1));
  return next;
}

export function useAgentActions(userId: string | null | undefined): {
  rows: AgentActionRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<AgentActionRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('agent_actions')
        .select('id, action_type, payload, executed_at, reversible, reverse_token, reversed_at')
        .eq('user_id', userId)
        .order('executed_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      if (error) console.warn('[agent-feed] read failed:', error.message);
      setRows((data ?? []) as AgentActionRow[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`agent_actions:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_actions', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as AgentActionRow;
          if (!next || !next.id) return;
          setRows((prev) => mergeAgentActions(prev, next));
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

export async function revertAgentAction(actionId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) return { ok: false, error: 'no session' };
  const baseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
  const res = await fetch(`${baseUrl}/functions/v1/agent-undo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action_id: actionId }),
  });
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const j = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: !!j.ok, error: j.error };
}
