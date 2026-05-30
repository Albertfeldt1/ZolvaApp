import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { reverseTokenProvider } from './reverse-provider.ts';

Deno.test('reverseTokenProvider: google kinds', () => {
  assertEquals(reverseTokenProvider({ kind: 'gmail.modify' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gmail.draft' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gcal.event_delete' }), 'google');
  assertEquals(reverseTokenProvider({ kind: 'gcal.event_restore' }), 'google');
});

Deno.test('reverseTokenProvider: microsoft kinds', () => {
  assertEquals(reverseTokenProvider({ kind: 'graph.draft' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.move' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.event_delete' }), 'microsoft');
  assertEquals(reverseTokenProvider({ kind: 'graph.event_restore' }), 'microsoft');
});

Deno.test('reverseTokenProvider: unknown kind throws', () => {
  assertThrows(() => reverseTokenProvider({ kind: 'nope' }), Error, 'unknown');
});
