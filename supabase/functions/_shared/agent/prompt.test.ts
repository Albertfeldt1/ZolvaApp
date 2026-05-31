// supabase/functions/_shared/agent/prompt.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { actionTypeFromToolName, buildMailTriagePrompt, buildReflectPrompt, MAIL_TRIAGE_TOOLS, REFLECT_TOOLS } from './prompt.ts';
import { COMMITMENT_SCAN_TOOLS, buildCommitmentScanPrompt } from './prompt.ts';

Deno.test('MAIL_TRIAGE_TOOLS exposes nine tools (archive/label/flag retired — need gmail.modify)', () => {
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
    'nudge_push',
  ]);
});

Deno.test('actionTypeFromToolName maps nudge_push to nudge.push', () => {
  assertEquals(actionTypeFromToolName('nudge_push'), 'nudge.push');
});

Deno.test('nudge_push tool requires action_kind, target_id, title, body (no provider)', () => {
  const tool = MAIL_TRIAGE_TOOLS.find((t) => t.name === 'nudge_push')!;
  const schema = tool.input_schema as { required: string[]; properties: Record<string, unknown> };
  assertEquals(schema.required.sort(), ['action_kind', 'body', 'target_id', 'title']);
  assertEquals('provider' in schema.properties, false);
});

Deno.test('buildMailTriagePrompt: system prompt steers nudge usage as a last resort', () => {
  const { system } = buildMailTriagePrompt({ threads: [] });
  const txt = system[0].text.toLowerCase();
  assertEquals(txt.includes('nudge_push'), true);
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

Deno.test('REFLECT_TOOLS is exactly mail_search, mail_get_body, nudge_push', () => {
  assertEquals(REFLECT_TOOLS.map((t) => t.name).sort(), ['mail_get_body', 'mail_search', 'nudge_push']);
});

Deno.test('actionTypeFromToolName maps mail_search', () => {
  assertEquals(actionTypeFromToolName('mail_search'), 'mail.search');
});

Deno.test('buildReflectPrompt lists events with time + attendees and injects Copenhagen date', () => {
  const { system, messages } = buildReflectPrompt({
    events: [{ event_id: 'e1', provider: 'google', title: 'Møde med Anders', start: '2026-06-01T12:00:00Z', location: 'Zoom', attendees: ['anders@x.dk'], description: '' }],
    nowIso: '2026-06-01T08:00:00Z',
  });
  const txt = (messages[0].content as string);
  assertEquals(txt.includes('Møde med Anders'), true);
  assertEquals(txt.includes('anders@x.dk'), true);
  assertEquals(txt.includes('Dags dato:'), true);
  assertEquals(system[0].cache_control, { type: 'ephemeral' });
});

Deno.test('commitment_record maps to commitment.record action', () => {
  assertEquals(actionTypeFromToolName('commitment_record'), 'commitment.record');
});

Deno.test('COMMITMENT_SCAN_TOOLS offers only commitment_record', () => {
  assertEquals(COMMITMENT_SCAN_TOOLS.map((t) => t.name), ['commitment_record']);
});

Deno.test('buildCommitmentScanPrompt lists candidate threads', () => {
  const { system, messages } = buildCommitmentScanPrompt({
    candidates: [{
      thread_id: 't1', provider: 'google', counterparty: 'Allan',
      subject: 'Q3', latest_text: 'Jeg sender decket på fredag', latest_from: 'user',
      latest_at: '2026-06-01T10:00:00Z',
    }],
    nowIso: '2026-06-01T12:00:00Z',
  });
  assertEquals(system.length, 1);
  assertEquals(String(messages[0].content).includes('t1'), true);
});
