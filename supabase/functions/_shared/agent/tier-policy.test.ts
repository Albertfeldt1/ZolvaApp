import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { clampModeForTier } from './tier-policy.ts';

Deno.test('pro is identity', () => {
  assertEquals(clampModeForTier('pro', 'mail.send_reply', 'auto'), 'auto');
  assertEquals(clampModeForTier('pro', 'cal.create_event', 'auto'), 'auto');
  assertEquals(clampModeForTier('pro', 'nudge.push', 'auto'), 'auto');
});

Deno.test('lite downgrades sends to propose', () => {
  assertEquals(clampModeForTier('lite', 'mail.send_reply', 'auto'), 'propose');
  assertEquals(clampModeForTier('lite', 'mail.send_new', 'auto'), 'propose');
});

Deno.test('lite disables calendar writes and nudges', () => {
  assertEquals(clampModeForTier('lite', 'cal.create_event', 'auto'), 'off');
  assertEquals(clampModeForTier('lite', 'cal.update_event', 'propose'), 'off');
  assertEquals(clampModeForTier('lite', 'cal.rsvp', 'propose'), 'off');
  assertEquals(clampModeForTier('lite', 'nudge.push', 'auto'), 'off');
});

Deno.test('lite leaves read/summarize/draft untouched', () => {
  assertEquals(clampModeForTier('lite', 'mail.summarize', 'auto'), 'auto');
  assertEquals(clampModeForTier('lite', 'mail.draft_reply', 'auto'), 'auto');
  assertEquals(clampModeForTier('lite', 'cal.list_events', 'auto'), 'auto');
});

Deno.test('free disables everything (defensive — free is skipped earlier)', () => {
  assertEquals(clampModeForTier('free', 'mail.summarize', 'auto'), 'off');
  assertEquals(clampModeForTier('free', 'mail.draft_reply', 'auto'), 'off');
});
