// src/lib/purchases.ts
import { Platform } from 'react-native';
import Purchases, { type CustomerInfo } from 'react-native-purchases';

const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY ?? '';
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? '';

let configured = false;

// Call once at app startup. No-op (and stays unconfigured) when no key is
// present — e.g. tests or a build without RevenueCat env — so callers degrade
// to the free baseline instead of throwing.
export function configurePurchases(): void {
  if (configured) return;
  const apiKey = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) return;
  Purchases.configure({ apiKey });
  configured = true;
}

export function isPurchasesConfigured(): boolean {
  return configured;
}

export async function loginPurchases(userId: string): Promise<void> {
  if (!configured) return;
  try { await Purchases.logIn(userId); } catch { /* non-fatal; UI falls back to free */ }
}

export async function logoutPurchases(): Promise<void> {
  if (!configured) return;
  try { await Purchases.logOut(); } catch { /* non-fatal */ }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try { return await Purchases.getCustomerInfo(); } catch { return null; }
}

export function addCustomerInfoListener(cb: (info: CustomerInfo) => void): () => void {
  if (!configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(cb);
  return () => Purchases.removeCustomerInfoUpdateListener(cb);
}
