// Mirrors the Supabase session into the shared keychain access group so
// the iOS AppIntent process (Siri-dispatched, separate from the RN runtime)
// can read JWT + refresh token. Native-only; web has no shared keychain.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export const KEYCHAIN_ACCESS_GROUP = 'io.zolva.shared';
export const KEYCHAIN_SERVICE = 'io.zolva.shared';
export const JWT_KEY = 'supabase.access_token';
export const REFRESH_KEY = 'supabase.refresh_token';

const isNativeIos = Platform.OS === 'ios';

// SECURITY TRADE-OFF: AFTER_FIRST_UNLOCK lets any process in this app's
// keychain access group read the token after the device has been unlocked
// at least once since boot. Required so Siri-dispatched AppIntents work
// post-reboot before the user has launched Zolva. WHEN_UNLOCKED would
// block voice on every device wake.
// NOTE: expo-secure-store@15.0.8 names the iOS access-group field `accessGroup`
// (not `keychainAccessGroup` as the plan stated). The public constant
// KEYCHAIN_ACCESS_GROUP keeps the descriptive name used by the Swift side.
const SHARED_OPTS: SecureStore.SecureStoreOptions = {
  accessGroup: KEYCHAIN_ACCESS_GROUP,
  keychainService: KEYCHAIN_SERVICE,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function writeSharedSession(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  if (!isNativeIos) return;
  await SecureStore.setItemAsync(JWT_KEY, accessToken, SHARED_OPTS);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken, SHARED_OPTS);
}

export async function clearSharedSession(): Promise<void> {
  if (!isNativeIos) return;
  await SecureStore.deleteItemAsync(JWT_KEY, SHARED_OPTS);
  await SecureStore.deleteItemAsync(REFRESH_KEY, SHARED_OPTS);
}
