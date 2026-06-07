// src/lib/paywall.ts
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import { isPurchasesConfigured } from './purchases';

// Present the paywall only when the user lacks `entitlement`. Returns true if
// the user ends up entitled (purchased, restored, or was already entitled).
export async function presentPaywallIfNeeded(entitlement = 'pro'): Promise<boolean> {
  if (!isPurchasesConfigured()) return false;
  try {
    const result = await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: entitlement,
    });
    return (
      result === PAYWALL_RESULT.PURCHASED ||
      result === PAYWALL_RESULT.RESTORED ||
      result === PAYWALL_RESULT.NOT_PRESENTED // not presented = already entitled
    );
  } catch (e) {
    if (__DEV__) console.warn('[paywall] presentIfNeeded failed:', e);
    return false;
  }
}

// Always present the paywall (e.g. an explicit "Upgrade" button).
export async function presentPaywall(): Promise<PAYWALL_RESULT | null> {
  if (!isPurchasesConfigured()) return null;
  try { return await RevenueCatUI.presentPaywall(); }
  catch (e) { if (__DEV__) console.warn('[paywall] present failed:', e); return null; }
}

// RevenueCat Customer Center: manage/cancel/restore, no custom UI needed.
export async function presentCustomerCenter(): Promise<void> {
  if (!isPurchasesConfigured()) return;
  try { await RevenueCatUI.presentCustomerCenter(); }
  catch (e) { if (__DEV__) console.warn('[customer-center] present failed:', e); }
}
