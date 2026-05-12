import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface AgentEnabledState {
  remote: boolean | null;
  optimistic: boolean | null;
}

export function reduceAgentEnabled(state: AgentEnabledState): boolean {
  if (state.optimistic !== null) return state.optimistic;
  if (state.remote !== null) return state.remote;
  return true; // spec default: on
}

export function useAgentEnabled(userId: string | null | undefined): {
  enabled: boolean;
  loading: boolean;
  setEnabled: (next: boolean) => Promise<void>;
} {
  const [state, setState] = useState<AgentEnabledState>({ remote: null, optimistic: null });
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('agent_enabled')
        .eq('user_id', userId)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.warn('[agent-settings] read failed:', error.message);
      setState((s) => ({ ...s, remote: data?.agent_enabled ?? true }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!userId) return;
    setState((s) => ({ ...s, optimistic: next }));
    const { error } = await supabase
      .from('user_profiles')
      .update({ agent_enabled: next })
      .eq('user_id', userId);
    if (error) {
      console.warn('[agent-settings] write failed:', error.message);
      setState((s) => ({ ...s, optimistic: null }));
      return;
    }
    setState((s) => ({ remote: next, optimistic: null }));
  }, [userId]);

  return { enabled: reduceAgentEnabled(state), loading, setEnabled };
}
