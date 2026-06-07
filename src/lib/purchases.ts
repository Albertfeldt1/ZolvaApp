// src/lib/purchases.ts
import { Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
} from 'react-native-purchases';

// Test Store key works for either platform; prefer a platform-specific key,
// fall back to a generic one. Swap test_ key for appl_/goog_ before shipping.
const API_KEY =
  (Platform.OS === 'ios'
    ? process.env.EXPO_PUBLIC_RC_IOS_KEY
    : process.env.EXPO_PUBLIC_RC_ANDROID_KEY) ||
  process.env.EXPO_PUBLIC_RC_KEY ||
  '';

let configured = false;

// Call once at app startup. No-op without a key (tests / Expo Go / missing env)
// so callers degrade to the free baseline instead of throwing.
export function configurePurchases(): void {
  if (configured || !API_KEY) return;
  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey: API_KEY });
  configured = true;
}

export function isPurchasesConfigured(): boolean {
  return configured;
}

export async function loginPurchases(userId: string): Promise<void> {
  if (!configured) return;
  try { await Purchases.logIn(userId); } catch (e) { warnPurchases('logIn', e); }
}

export async function logoutPurchases(): Promise<void> {
  if (!configured) return;
  try { await Purchases.logOut(); } catch (e) { warnPurchases('logOut', e); }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try { return await Purchases.getCustomerInfo(); }
  catch (e) { warnPurchases('getCustomerInfo', e); return null; }
}

export function addCustomerInfoListener(cb: (info: CustomerInfo) => void): () => void {
  if (!configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(cb);
  return () => Purchases.removeCustomerInfoUpdateListener(cb);
}

export async function getCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!configured) return null;
  try { return (await Purchases.getOfferings()).current; }
  catch (e) { warnPurchases('getOfferings', e); return null; }
}

export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try { return await Purchases.restorePurchases(); }
  catch (e) { warnPurchases('restorePurchases', e); return null; }
}

function warnPurchases(where: string, e: unknown): void {
  if (__DEV__) console.warn(`[purchases] ${where} failed:`, e);
}
