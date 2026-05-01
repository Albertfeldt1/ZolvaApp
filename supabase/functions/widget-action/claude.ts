const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = (tz: string, nowIso: string) => `Du parser én anmodning fra brugeren — enten en kalenderbegivenhed eller en påmindelse.

Den nuværende dato og tid er ${nowIso}. Brugerens tidszone er ${tz}. Brug dette til at opløse alle relative datoer ("i morgen", "om to dage", "next Monday") — ALDRIG fra din egen træningsdata-cutoff.

Vælg ÉT værktøj:
- create_calendar_event: når brugeren vil have et MØDE / kalenderbegivenhed med start- og sluttid.
- create_reminder: når brugeren vil have en PÅMINDELSE (typisk "husk mig på", "remind me to") uden mødelogik.

Tvivl-håndtering: hvis prompten kun indeholder en handling og et tidspunkt ("ring til mor kl. 17"), foretræk create_reminder. Hvis der er en eksplicit møde-kontekst ("møde med", "frokost med", "appointment", "session"), foretræk create_calendar_event.

Tvetydig tid: for "kl. 5" / "5 o'clock" / "fem" uden AM/PM-kontekst, vælg det næste rimelige tidspunkt i 07-22-vinduet. Dansk "klokken fem" betyder typisk 17:00.

Rapportér også det opdagede sprog ('da' / 'en' / 'unknown').`;

const TOOLS = [
  {
    name: 'create_calendar_event',
    description: 'Brug når brugeren vil have et MØDE eller en KALENDERBEGIVENHED med en konkret start- og sluttid. Eksempler: "sæt et møde i morgen kl. 17", "bord 19:30 hos Mami", "tandlæge tirsdag 10". Skal IKKE bruges til påmindelser uden mødelogik.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'kort titel' },
        start: { type: 'string', description: "ISO 8601 med offset i brugerens tidszone" },
        end: { type: 'string', description: 'OPTIONAL — server defaulter hvis udeladt' },
        calendar_label: {
          type: ['string', 'null'],
          enum: ['work', 'personal', null],
          description: 'kun hvis brugeren nævnte en specifik kalender',
        },
        prompt_language: { type: 'string', enum: ['da', 'en', 'unknown'] },
      },
      required: ['title', 'start', 'calendar_label', 'prompt_language'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_reminder',
    description: 'Brug når brugeren vil have en PÅMINDELSE — typisk indledet med "husk mig på", "remind me to", "minder mig om", uden mødelogik. Eksempler: "husk mig på at ringe til mor kl. 17", "remind me to take meds at 8". Skal IKKE bruges til møder.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'påmindelsesteksten — kort og handlingsorienteret' },
        due_at: {
          type: ['string', 'null'],
          description: "ISO 8601 med tidszone-offset, eller null hvis brugeren ikke nævnte et tidspunkt",
        },
        prompt_language: { type: 'string', enum: ['da', 'en', 'unknown'] },
      },
      required: ['text', 'prompt_language'],
      additionalProperties: false,
    },
  },
];

export type ClaudeExtractionEvent = {
  kind: 'event';
  title: string;
  start: string;
  end?: string;
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeExtractionReminder = {
  kind: 'reminder';
  text: string;
  due_at: string | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeExtraction = ClaudeExtractionEvent | ClaudeExtractionReminder;

export type ClaudeUsage = { input: number; output: number };

export async function extractAction(
  prompt: string,
  timezone: string,
): Promise<{ extraction: ClaudeExtraction; usage: ClaudeUsage; model: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT(timezone, new Date().toISOString()),
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as {
    content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const toolUse = body.content.find((c) => c.type === 'tool_use');
  if (!toolUse?.input || !toolUse.name) {
    throw new Error('claude returned no tool_use block');
  }

  let extraction: ClaudeExtraction;
  if (toolUse.name === 'create_calendar_event') {
    extraction = { kind: 'event', ...(toolUse.input as Omit<ClaudeExtractionEvent, 'kind'>) };
  } else if (toolUse.name === 'create_reminder') {
    extraction = { kind: 'reminder', ...(toolUse.input as Omit<ClaudeExtractionReminder, 'kind'>) };
  } else {
    throw new Error(`unknown tool ${toolUse.name}`);
  }

  return {
    extraction,
    usage: { input: body.usage.input_tokens, output: body.usage.output_tokens },
    model: body.model,
  };
}
