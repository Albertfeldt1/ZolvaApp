// src/lib/entitlement.ts
export type Tier = 'free' | 'lite' | 'pro';

export type Entitlement = {
  tier: Tier;
  isTrial: boolean;
  trialEndsAt: string | null;
  periodEnd: string | null;
};

// Minimal structural shape of RN Purchases CustomerInfo we depend on. Keeping
// our own shape means tests pass plain objects and the resolver isn't coupled
// to the SDK's full type.
export type CustomerInfoLike = {
  entitlements: {
    active: Record<string, { periodType?: string; expirationDate?: string | null }>;
  };
};

export const FREE: Entitlement = { tier: 'free', isTrial: false, trialEndsAt: null, periodEnd: null };

export function resolveEntitlement(info: CustomerInfoLike | null | undefined): Entitlement {
  const active = info?.entitlements?.active ?? {};
  const picked = active['pro']
    ? { tier: 'pro' as Tier, e: active['pro'] }
    : active['lite']
      ? { tier: 'lite' as Tier, e: active['lite'] }
      : null;
  if (!picked) return FREE;
  const isTrial = picked.e.periodType === 'TRIAL';
  const periodEnd = picked.e.expirationDate ?? null;
  return { tier: picked.tier, isTrial, trialEndsAt: isTrial ? periodEnd : null, periodEnd };
}
