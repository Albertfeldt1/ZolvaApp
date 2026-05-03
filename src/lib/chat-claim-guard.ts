// Catches text-only chat responses that falsely claim a tool-backed action
// was performed. See docs/superpowers/specs/2026-05-03-chat-hallucination-
// guard-design.md for the full design.

import { completeJson } from './claude';
import { getPrivacyFlag } from './hooks';

export type ChatToolName =
  | 'send_mail'
  | 'create_draft'
  | 'add_reminder'
  | 'add_note'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'delete_calendar_event'
  | 'list_calendar_events'
  | 'list_recent_mail'
  | 'read_mail_thread'
  | 'list_reminders'
  | 'list_notes'
  | 'search_drive_files'
  | 'read_drive_file';

export type ClaimVerdict = {
  claimed: boolean;
  tool: ChatToolName | null;
  reason: string;
};

export const GENERIC_CONFUSED_FALLBACK =
  'Jeg blev forvirret — kan du gentage hvad du gerne vil have mig til?';

export const CHAT_GUARD_DEBUG_TAG = '[chat-guard]';

const VALID_TOOLS: ReadonlySet<ChatToolName> = new Set([
  'send_mail',
  'create_draft',
  'add_reminder',
  'add_note',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'list_calendar_events',
  'list_recent_mail',
  'read_mail_thread',
  'list_reminders',
  'list_notes',
  'search_drive_files',
  'read_drive_file',
]);

export function buildCorrectionMessage(tool: ChatToolName | null): string {
  const toolPart = tool ? `'${tool}'` : 'et værktøj';
  return [
    `Du påstod at du har udført ${toolPart}, men du kaldte ikke værktøjet i din forrige tur.`,
    'Enten kald værktøjet nu hvis brugeren har bekræftet handlingen, eller spørg brugeren',
    'om bekræftelse før du fortsætter. Påstå aldrig at noget er udført uden faktisk at have',
    'kaldt værktøjet.',
  ].join(' ');
}

export async function classifyClaim(
  _assistantText: string,
  _signal?: AbortSignal,
): Promise<ClaimVerdict> {
  // Implemented in Task 2.
  return { claimed: false, tool: null, reason: 'unimplemented' };
}

// Keep referenced symbols used so the linter doesn't flag them before Task 2
// wires them in: completeJson and getPrivacyFlag are used by classifyClaim.
void completeJson;
void getPrivacyFlag;
void VALID_TOOLS;
