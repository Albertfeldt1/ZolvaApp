// supabase/functions/_shared/agent/push.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { shouldPushForProposal } from './push.ts';

const NOW = new Date('2026-05-13T10:00:00Z');

Deno.test('shouldPushForProposal: true when last_active_at is null (never pinged)', () => {
  assertEquals(shouldPushForProposal(null, NOW), true);
});

Deno.test('shouldPushForProposal: true when idle >= 60s', () => {
  const sixtyOneSecondsAgo = new Date(NOW.getTime() - 61_000);
  assertEquals(shouldPushForProposal(sixtyOneSecondsAgo, NOW), true);
});

Deno.test('shouldPushForProposal: false when user is foreground (< 60s)', () => {
  const tenSecondsAgo = new Date(NOW.getTime() - 10_000);
  assertEquals(shouldPushForProposal(tenSecondsAgo, NOW), false);
});

Deno.test('shouldPushForProposal: false at exactly 30s (boundary)', () => {
  const thirty = new Date(NOW.getTime() - 30_000);
  assertEquals(shouldPushForProposal(thirty, NOW), false);
});
