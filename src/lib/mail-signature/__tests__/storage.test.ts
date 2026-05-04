// src/lib/mail-signature/__tests__/storage.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSignature, saveSignature, __resetForTests } from '../storage';
import { EMPTY_SIGNATURE } from '../types';

// Prevent the real auth module from pulling in supabase (and its env-var check)
// at test-module import time. subscribeUserId is only used for runtime cache
// invalidation; tests drive cache state via __resetForTests / explicit uid args.
jest.mock('../../auth', () => ({
  subscribeUserId: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    _store: new Map<string, string>(),
    async getItem(k: string) { return (this as any)._store.get(k) ?? null; },
    async setItem(k: string, v: string) { (this as any)._store.set(k, v); },
    async removeItem(k: string) { (this as any)._store.delete(k); },
    async clear() { (this as any)._store.clear(); },
  },
}));

const UID = 'user-1';
const OTHER_UID = 'user-2';

describe('storage / migration', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadSignature(UID)).toBeNull();
  });

  it('migrates v1 per-user plaintext into customLines and deletes v1 key', async () => {
    await AsyncStorage.setItem(`zolva.mail.signature.${UID}`, 'Med venlig hilsen\nAlbert');
    const out = await loadSignature(UID);
    expect(out).toEqual({ ...EMPTY_SIGNATURE, customLines: 'Med venlig hilsen\nAlbert' });
    expect(await AsyncStorage.getItem(`zolva.mail.signature.${UID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`zolva.mail.signature.v2.${UID}`)).not.toBeNull();
  });

  it('migrates legacy global plaintext when no per-user v1 exists', async () => {
    await AsyncStorage.setItem('zolva.mail.signature', 'Legacy text');
    const out = await loadSignature(UID);
    expect(out).toEqual({ ...EMPTY_SIGNATURE, customLines: 'Legacy text' });
    expect(await AsyncStorage.getItem('zolva.mail.signature')).toBeNull();
  });

  it('does not migrate when v2 already exists', async () => {
    const v2 = { ...EMPTY_SIGNATURE, name: 'Already' };
    await AsyncStorage.setItem(`zolva.mail.signature.v2.${UID}`, JSON.stringify(v2));
    await AsyncStorage.setItem(`zolva.mail.signature.${UID}`, 'should be ignored');
    const out = await loadSignature(UID);
    expect(out).toEqual(v2);
    expect(await AsyncStorage.getItem(`zolva.mail.signature.${UID}`)).toBe('should be ignored');
  });

  it('returns null and warns when v2 JSON is malformed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AsyncStorage.setItem(`zolva.mail.signature.v2.${UID}`, '{not json');
    expect(await loadSignature(UID)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('isolates signatures per user', async () => {
    await saveSignature(UID, { ...EMPTY_SIGNATURE, name: 'A' });
    await saveSignature(OTHER_UID, { ...EMPTY_SIGNATURE, name: 'B' });
    expect((await loadSignature(UID))?.name).toBe('A');
    expect((await loadSignature(OTHER_UID))?.name).toBe('B');
  });

  it('saveSignature persists JSON under the v2 per-user key', async () => {
    await saveSignature(UID, { ...EMPTY_SIGNATURE, name: 'Albert', title: 'CEO' });
    const raw = await AsyncStorage.getItem(`zolva.mail.signature.v2.${UID}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.name).toBe('Albert');
    expect(parsed.title).toBe('CEO');
  });
});
