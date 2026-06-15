import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseDeadTokens } from './expo-tickets.ts';

Deno.test('parseDeadTokens: maps DeviceNotRegistered tickets back to their tokens', () => {
  const tokens = ['tok-a', 'tok-b', 'tok-c'];
  const body = {
    data: [
      { status: 'ok', id: '1' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      { status: 'ok', id: '3' },
    ],
  };
  assertEquals(parseDeadTokens(tokens, body), ['tok-b']);
});

Deno.test('parseDeadTokens: does not prune transient (non-DeviceNotRegistered) errors', () => {
  const tokens = ['tok-a'];
  const body = { data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }] };
  assertEquals(parseDeadTokens(tokens, body), []);
});

Deno.test('parseDeadTokens: empty when all delivered or body is unexpected', () => {
  assertEquals(parseDeadTokens(['a'], { data: [{ status: 'ok' }] }), []);
  assertEquals(parseDeadTokens(['a'], null), []);
  assertEquals(parseDeadTokens(['a'], { nope: true }), []);
});
