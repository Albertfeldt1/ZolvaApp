// supabase/functions/_shared/agent/prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { actionTypeFromToolName, buildMailTriagePrompt, MAIL_TRIAGE_TOOLS } from './prompt.ts';

Deno.test('MAIL_TRIAGE_TOOLS exposes eight tools (archive/label/flag retired — need gmail.modify)', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name).sort();
  assertEquals(names, [
    'cal_create_event',
    'cal_list_events',
    'cal_update_event',
    'drive_search',
    'mail_draft_reply',
    'mail_get_body',
    'mail_send_reply',
    'mail_summarize',
  ]);
});

Deno.test('actionTypeFromToolName maps each tool to its ActionType', () => {
  assertEquals(actionTypeFromToolName('mail_get_body'), 'mail.get_body');
  assertEquals(actionTypeFromToolName('cal_list_events'), 'cal.list_events');
  assertEquals(actionTypeFromToolName('drive_search'), 'drive.search');
  // Previously six; now eight after calendar-write tools
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

Deno.test('actionTypeFromToolName: maps the two calendar-write tools', () => {
  assertEquals(actionTypeFromToolName('cal_create_event'), 'cal.create_event');
  assertEquals(actionTypeFromToolName('cal_update_event'), 'cal.update_event');
});

Deno.test('MAIL_TRIAGE_TOOLS: includes calendar-write tools', () => {
  const names = MAIL_TRIAGE_TOOLS.map((t) => t.name);
  assertEquals(names.includes('cal_create_event'), true);
  assertEquals(names.includes('cal_update_event'), true);
});

Deno.test('buildMailTriagePrompt: injects Danish current date when nowIso given', () => {
  const { messages } = buildMailTriagePrompt({
    threads: [{ thread_id: 't1', from: 'a@x.com', subject: 'Frokost', snippet: '' }],
    nowIso: '2026-05-30T12:00:00Z',
  });
  const userText = messages[0].content as string;
  assertEquals(userText.includes('Dags dato:'), true);
  assertEquals(userText.includes('2026'), true);
  assertEquals(userText.includes('maj'), true);
});

Deno.test('buildMailTriagePrompt: omits date line when nowIso absent', () => {
  const { messages } = buildMailTriagePrompt({
    threads: [{ thread_id: 't1', from: 'a@x.com', subject: 'Frokost', snippet: '' }],
  });
  assertEquals((messages[0].content as string).includes('Dags dato:'), false);
});
