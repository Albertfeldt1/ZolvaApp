// supabase/functions/_shared/agent/prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';

Deno.test('MAIL_TRIAGE_TOOLS exposes exactly four mail actions', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name).sort();
  assertEquals(names, [
    'mail.archive',
    'mail.flag_important',
    'mail.label',
    'mail.summarize',
  ]);
});

Deno.test('buildMailTriagePrompt: includes each thread with subject and from', () => {
  const { system, messages } = buildMailTriagePrompt({
    threads: [
      { thread_id: 't1', from: 'a@x.com', subject: 'Faktura', snippet: '' },
      { thread_id: 't2', from: 'b@y.com', subject: 'Hej', snippet: '' },
    ],
  });
  assertEquals(system.length >= 1, true);
  assertEquals(system[0].cache_control, { type: 'ephemeral' });
  const userText = (messages[0].content as string);
  assertEquals(userText.includes('t1'), true);
  assertEquals(userText.includes('Faktura'), true);
  assertEquals(userText.includes('t2'), true);
});

Deno.test('buildMailTriagePrompt: empty threads still produces a prompt', () => {
  const { messages } = buildMailTriagePrompt({ threads: [] });
  assertEquals(typeof messages[0].content, 'string');
});
