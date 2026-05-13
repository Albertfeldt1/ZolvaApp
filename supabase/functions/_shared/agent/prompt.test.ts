// supabase/functions/_shared/agent/prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { actionTypeFromToolName, buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';

Deno.test('MAIL_TRIAGE_TOOLS exposes nine tools after phase 4a', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name).sort();
  assertEquals(names, [
    'cal_list_events',
    'drive_search',
    'mail_archive',
    'mail_draft_reply',
    'mail_flag_important',
    'mail_get_body',
    'mail_label',
    'mail_send_reply',
    'mail_summarize',
  ]);
});

Deno.test('actionTypeFromToolName maps each tool to its ActionType', () => {
  assertEquals(actionTypeFromToolName('mail_get_body'), 'mail.get_body');
  assertEquals(actionTypeFromToolName('cal_list_events'), 'cal.list_events');
  assertEquals(actionTypeFromToolName('drive_search'), 'drive.search');
  // Existing six still resolve
  assertEquals(actionTypeFromToolName('mail_send_reply'), 'mail.send_reply');
  // Unknown returns null
  assertEquals(actionTypeFromToolName('foo'), null);
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

Deno.test('buildMailTriagePrompt: system prompt mentions outlook scope and conservative drafting', () => {
  const { system } = buildMailTriagePrompt({ threads: [] });
  const txt = system[0].text.toLowerCase();
  // We just check anchors; full prose lives in prompt.ts.
  assertEquals(txt.includes('outlook'), true);
  assertEquals(txt.includes('draft'), true);
});
