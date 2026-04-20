// Thin wrapper over expo-secure-store. Used as the storage adapter for
// the Supabase auth client and as the home for OAuth provider tokens.
//
// Why this exists: Supabase session + provider refresh/access tokens used
// to live in AsyncStorage, which is plaintext on disk. Moving them to the
// platform keychain (iOS Keychain / Android Keystore) makes device-theft /
// jailbreak extraction materially harder. On web, expo-secure-store has no
// keychain to back onto, so we fall back to AsyncStorage so auth keeps
// working during `expo start --web` and the build doesn't explode.
//
// Keychain key constraint: expo-secure-store only accepts `[A-Za-z0-9._-]`.
// Supabase's default session key `sb-<ref>-auth-token` already fits.

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const useSecureStore = Platform.OS === 'ios' || Platform.OS === 'android';

export async function getItem(key: string): Promise<string | null> {
  if (!useSecureStore) return AsyncStorage.getItem(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch (err) {
    if (__DEV__) console.warn('[secure-storage] getItem failed:', key, err);
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  if (!useSecureStore) return AsyncStorage.setItem(key, value);
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (err) {
    if (__DEV__) console.warn('[secure-storage] setItem failed:', key, err);
    throw err;
  }
}

export async function deleteItem(key: string): Promise<void> {
  if (!useSecureStore) return AsyncStorage.removeItem(key);
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (err) {
    if (__DEV__) console.warn('[secure-storage] deleteItem failed:', key, err);
  }
}

// Supabase's auth client expects `{ getItem, setItem, removeItem }`. We can't
// just pass this module because the removal method is named `deleteItem`.
export const supabaseStorageAdapter = {
  getItem,
  setItem,
  removeItem: deleteItem,
};
