// supabase/functions/_shared/entitlement.ts
//
// Pure mapping from RevenueCat webhook events / DB rows to a tier state.
// No I/O here so it stays unit-testable. See revenuecat-webhook for wiring.

export type Tier = 'free' | 'lite' | 'pro';

export type EntitlementState = {
  tier: Tier;
  is_trial: boolean;
  current_period_end: string | null; // ISO 8601
  store: string | null;
  product_id: string | null;
};

// Subset of RevenueCat webhook event fields we consume.
// https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
export type RcEvent = {
  type: string;
  app_user_id?: string;
  entitlement_ids?: string[] | null;
  period_type?: string;            // 'TRIAL' | 'INTRO' | 'NORMAL'
  expiration_at_ms?: number | null;
  store?: string;                  // 'APP_STORE' | 'PLAY_STORE' | 'PROMOTIONAL'
  product_id?: string;
  event_timestamp_ms?: number | null; // when RevenueCat generated the event
};

export type WebhookOutcome =
  | { action: 'upsert'; userId: string; state: EntitlementState }
  | { action: 'expire'; userId: string }
  | { action: 'ignore'; reason: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Events that mean "user is currently entitled to whatever entitlement_ids says".
const ACTIVE_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);

export function tierFromEntitlementIds(ids: string[] | null | undefined): Tier {
  const set = new Set(ids ?? []);
  if (set.has('pro')) return 'pro';
  if (set.has('lite')) return 'lite';
  return 'free';
}

export function eventToOutcome(event: RcEvent): WebhookOutcome {
  const userId = event.app_user_id ?? '';
  if (!UUID_RE.test(userId)) {
    return { action: 'ignore', reason: 'app_user_id is not a Supabase user id (anonymous?)' };
  }
  if (event.type === 'EXPIRATION') {
    return { action: 'expire', userId };
  }
  if (!ACTIVE_TYPES.has(event.type)) {
    // CANCELLATION = auto-renew off but still entitled until EXPIRATION.
    // BILLING_ISSUE = grace period. TRANSFER/TEST = irrelevant. No tier change.
    return { action: 'ignore', reason: `no tier change for ${event.type}` };
  }
  const tier = tierFromEntitlementIds(event.entitlement_ids);
  if (tier === 'free') {
    // Active event but no known entitlement -> treat as down to free.
    return { action: 'expire', userId };
  }
  return {
    action: 'upsert',
    userId,
    state: {
      tier,
      is_trial: event.period_type === 'TRIAL',
      current_period_end: event.expiration_at_ms
        ? new Date(event.expiration_at_ms).toISOString()
        : null,
      store: event.store ?? null,
      product_id: event.product_id ?? null,
    },
  };
}

// Ordering guard for webhook writes. RevenueCat retries and can deliver
// events out of order; without this, a re-delivered older EXPIRATION arriving
// after a newer RENEWAL would clobber an active paying user down to free.
// Apply the incoming event only if it is at least as new as what we last
// stored. Fail open (apply) when we can't order it, so we never silently drop
// a legitimate write.
export function shouldApplyRcEvent(
  incomingMs: number | null | undefined,
  storedIso: string | null | undefined,
): boolean {
  if (incomingMs == null) return true;
  if (!storedIso) return true;
  const storedMs = Date.parse(storedIso);
  if (Number.isNaN(storedMs)) return true;
  return incomingMs >= storedMs;
}

// Maps a DB row (or null) to a full state. Used by getEntitlement (Task 3).
export function rowToState(row: Partial<EntitlementState> | null | undefined): EntitlementState {
  if (!row || !row.tier) {
    return { tier: 'free', is_trial: false, current_period_end: null, store: null, product_id: null };
  }
  return {
    tier: row.tier as Tier,
    is_trial: row.is_trial ?? false,
    current_period_end: row.current_period_end ?? null,
    store: row.store ?? null,
    product_id: row.product_id ?? null,
  };
}
