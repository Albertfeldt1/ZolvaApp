import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMemoryFollowupPrompt, MEMORY_FOLLOWUP_TOOLS } from './prompt.ts';

Deno.test('buildMemoryFollowupPrompt lists each fact with its id and text', () => {
  const { system, messages } = buildMemoryFollowupPrompt({
    facts: [{ fact_id: 'f1', text: 'du skal forny dit pas', follow_up_at: '2026-06-12T00:00:00Z' }],
    nowIso: '2026-06-12T07:00:00Z',
  });
  assertEquals(system.length > 0, true);
  const body = messages[0].content as string;
  assertEquals(body.includes('f1'), true);
  assertEquals(body.includes('du skal forny dit pas'), true);
});

Deno.test('MEMORY_FOLLOWUP_TOOLS exposes nudge + search + body + draft + send', () => {
  const names = MEMORY_FOLLOWUP_TOOLS.map((t) => (t as { name: string }).name);
  assertEquals(names.includes('nudge_push'), true);
  assertEquals(names.includes('mail_search'), true);
  assertEquals(names.includes('mail_draft_reply'), true);
  assertEquals(names.includes('mail_send_reply'), true);
});
