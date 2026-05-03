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

const CLASSIFIER_SYSTEM = [
  'Du er en intern klassifikator for en chatbot der har værktøjer til mail og kalender.',
  'Du får én besked fra chatbotten. Afgør om beskeden påstår at en handling er udført',
  'eller at konkrete data er hentet — ting der KRÆVER et værktøjskald.',
  '',
  'Påstande der kræver værktøj (claimed=true):',
  '- "Jeg har sendt mailen", "Mailen er afsendt", "Jeg sendte den"',
  '- "Jeg har gemt udkastet", "Udkastet ligger i din kladdemappe"',
  '- "Jeg har oprettet/ændret/slettet begivenheden", "Den er lagt i kalenderen"',
  '- "Jeg har gemt påmindelsen/noten"',
  '- "Jeg har tjekket din kalender — du har X", "Din næste mail er fra Y"',
  '- "Jeg fandt filen om Z i Drive"',
  '',
  'IKKE krav om værktøj (claimed=false):',
  '- Spørgsmål til brugeren ("Skal jeg sende den?")',
  '- Bekræftelse FØR handling ("Jeg sender den nu hvis du siger ja")',
  '- Generel snak / hjælp / forklaring',
  '- "Jeg KAN sende mails", "Jeg har værktøjer til..."',
  '- Fremtidsform ("Jeg vil sende...", "Jeg sender...")',
  '- Negationer ("Jeg har IKKE sendt den")',
].join('\n');

const CLASSIFIER_SCHEMA_HINT = [
  '{',
  '  "claimed": "boolean — true hvis beskeden påstår en udført handling",',
  '  "tool": "string|null — én af: send_mail, create_draft, add_reminder, add_note, create_calendar_event, update_calendar_event, delete_calendar_event, list_calendar_events, list_recent_mail, read_mail_thread, list_reminders, list_notes, search_drive_files, read_drive_file. null hvis claimed=false eller værktøj uklart.",',
  '  "reason": "string — kort dansk begrundelse, max 100 tegn"',
  '}',
].join('\n');

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

type RawVerdict = {
  claimed?: unknown;
  tool?: unknown;
  reason?: unknown;
};

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
  assistantText: string,
  signal?: AbortSignal,
): Promise<ClaimVerdict> {
  try {
    const raw = await completeJson<RawVerdict>({
      model: CLASSIFIER_MODEL,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: assistantText }],
      schemaHint: CLASSIFIER_SCHEMA_HINT,
      maxTokens: 150,
      temperature: 0,
      attachProfile: false,
      signal,
    });
    return normalizeVerdict(raw);
  } catch (err) {
    if (__DEV__ && getPrivacyFlag('anon-reports')) {
      // eslint-disable-next-line no-console
      console.warn(
        `${CHAT_GUARD_DEBUG_TAG} classifier failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return { claimed: false, tool: null, reason: 'classifier-failed' };
  }
}

function normalizeVerdict(raw: RawVerdict): ClaimVerdict {
  if (typeof raw?.claimed !== 'boolean') {
    return { claimed: false, tool: null, reason: 'classifier-failed' };
  }
  const toolStr = typeof raw.tool === 'string' ? raw.tool : null;
  const tool = toolStr && VALID_TOOLS.has(toolStr as ChatToolName)
    ? (toolStr as ChatToolName)
    : null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return { claimed: raw.claimed, tool, reason };
}
