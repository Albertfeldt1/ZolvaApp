import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth';
import { isDemoUser } from './demo';

export type Brief = {
  id: string;
  kind: 'morning' | 'evening';
  headline: string;
  body: string[];
  weather: { tempC: number; highC: number; lowC: number; conditionLabel: string } | null;
  tone: 'calm' | 'busy' | 'heads-up' | null;
  generatedAt: Date;
  readAt: Date | null;
};

function rowToBrief(r: Record<string, unknown>): Brief {
  return {
    id: r.id as string,
    kind: r.kind as 'morning' | 'evening',
    headline: r.headline as string,
    body: Array.isArray(r.body) ? (r.body as string[]) : [],
    weather: (r.weather as Brief['weather']) ?? null,
    tone: (r.tone as Brief['tone']) ?? null,
    generatedAt: new Date(r.generated_at as string),
    readAt: r.read_at ? new Date(r.read_at as string) : null,
  };
}

export function useTodayBrief(): {
  brief: Brief | null;
  loading: boolean;
  markRead: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { user } = useAuth();
  const userId = user?.id;
  const demo = isDemoUser(user);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || demo) {
      setBrief(null);
      return;
    }
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('briefs')
        .select('*')
        .eq('user_id', userId)
        .gte('generated_at', `${today}T00:00:00Z`)
        .order('generated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0];
      setBrief(row ? rowToBrief(row as Record<string, unknown>) : null);
    } catch (err) {
      if (__DEV__) console.warn('[briefs] refresh failed:', err);
      setBrief(null);
    } finally {
      setLoading(false);
    }
  }, [userId, demo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markRead = useCallback(async () => {
    if (!brief) return;
    const readAt = new Date();
    setBrief((prev) => (prev ? { ...prev, readAt } : prev));
    try {
      await supabase
        .from('briefs')
        .update({ read_at: readAt.toISOString() })
        .eq('id', brief.id);
    } catch (err) {
      if (__DEV__) console.warn('[briefs] markRead failed:', err);
    }
  }, [brief]);

  return { brief, loading, markRead, refresh };
}

export function useBriefHistory(
  kind: 'morning' | 'evening',
  limit = 30,
): { items: Brief[]; loading: boolean; refresh: () => Promise<void> } {
  const { user } = useAuth();
  const userId = user?.id;
  const demo = isDemoUser(user);
  const [items, setItems] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || demo) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('briefs')
        .select('*')
        .eq('user_id', userId)
        .eq('kind', kind)
        .order('generated_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      setItems((data ?? []).map((r) => rowToBrief(r as Record<string, unknown>)));
    } catch (err) {
      if (__DEV__) console.warn('[briefs] history refresh failed:', err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [userId, demo, kind, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, refresh };
}
