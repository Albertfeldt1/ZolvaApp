jest.mock('../supabase', () => ({
  supabase: { functions: { invoke: jest.fn() } },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestForcedBriefOnce, onForcedBriefSettled } from '../forced-brief';
import { supabase } from '../supabase';

const invoke = supabase.functions.invoke as jest.Mock;

beforeEach(async () => {
  await AsyncStorage.clear();
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { forced: true, status: 'sent', briefId: 'b1' }, error: null });
});

test('invokes daily-brief with force:true', async () => {
  await requestForcedBriefOnce('u1');
  expect(invoke).toHaveBeenCalledWith('daily-brief', { body: { force: true } });
});

test('second call for the same user is a no-op', async () => {
  await requestForcedBriefOnce('u1');
  await requestForcedBriefOnce('u1');
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('notifies settled listeners after the call resolves', async () => {
  const fn = jest.fn();
  const off = onForcedBriefSettled(fn);
  await requestForcedBriefOnce('u2');
  expect(fn).toHaveBeenCalledTimes(1);
  off();
});

test('invoke failure is swallowed and still notifies listeners', async () => {
  invoke.mockRejectedValue(new Error('network'));
  const fn = jest.fn();
  const off = onForcedBriefSettled(fn);
  await expect(requestForcedBriefOnce('u3')).resolves.toBeUndefined();
  expect(fn).toHaveBeenCalledTimes(1);
  off();
});
