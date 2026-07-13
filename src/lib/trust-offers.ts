import { useEffect, useId, useState } from 'react';
import { supabase } from './supabase';
import {
  decideDemoTrustOffer,
  getDemoTrustOffers,
  isDemoUserId,
  revertDemoTrustOffer,
  subscribeDemoAgent,
} from './demo-data';

export interface TrustOfferRow {
  id: string;
  action_type: string;
  recipient: string;
  approval_count: number;
  status: 'pending' | 'accepted' | 'dismissed' | 'reverted';
  created_at: string;
  decided_at: string | null;
}

export function mergeTrustOffers(
  existing: TrustOfferRow[],
  incoming: TrustOfferRow,
): TrustOfferRow[] {
  const without = existing.filter((r) => r.id !== incoming.id);
  const next = [...without, incoming];
  next.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return next;
}

// Subscribes to the user's trust offers (all statuses) with realtime updates,
// mirroring useProposedActions. Callers filter by status as needed — the
// Today feed wants `pending`, Settings wants `accepted`.
export function useTrustOffers(userId: string | null | undefined): {
  rows: TrustOfferRow[];
  loading: boolean;
} {
  const [rows, setRows] = useState<TrustOfferRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const instanceId = useId();

  useEffect(() => {
    let cancelled = false;
    if (!userId) { setLoading(false); return; }
    if (isDemoUserId(userId)) {
      const sync = () => setRows(getDemoTrustOffers());
      sync();
      setLoading(false);
      return subscribeDemoAgent(sync);
    }
    (async () => {
      const { data, error } = await supabase
        .from('trust_offers')
        .select('id, action_type, recipient, approval_count, status, created_at, decided_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) console.warn('[trust-offers] read failed:', error.message);
      setRows((data ?? []) as TrustOfferRow[]);
      setLoading(false);
    })();

    const channel = supabase
      .channel(`trust_offers:${userId}:${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'trust_offers', filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as TrustOfferRow;
          if (!next?.id) return;
          setRows((prev) => mergeTrustOffers(prev, next));
        },
      )
      .subscribe();

    return () => { cancelled = true; void supabase.removeChannel(channel); };
  }, [userId, instanceId]);

  return { rows, loading };
}

// Pending → accepted | dismissed. Owner-update RLS is the real gate; the
// explicit user_id filter is defense-in-depth, matching trust-offer-decide.
export async function decideTrustOffer(
  offerId: string,
  userId: string,
  status: 'accepted' | 'dismissed',
): Promise<{ ok: boolean }> {
  if (isDemoUserId(userId)) return { ok: decideDemoTrustOffer(offerId, status) };
  const { error } = await supabase
    .from('trust_offers')
    .update({ status, decided_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('user_id', userId)
    .eq('status', 'pending');
  return { ok: !error };
}

// Accepted → reverted (from Settings).
export async function revertTrustOffer(offerId: string, userId: string): Promise<{ ok: boolean }> {
  if (isDemoUserId(userId)) return { ok: revertDemoTrustOffer(offerId) };
  const { error } = await supabase
    .from('trust_offers')
    .update({ status: 'reverted', reverted_at: new Date().toISOString() })
    .eq('id', offerId)
    .eq('user_id', userId)
    .eq('status', 'accepted');
  return { ok: !error };
}
