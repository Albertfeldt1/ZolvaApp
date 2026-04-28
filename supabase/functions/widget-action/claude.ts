const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

export type ClaudeExtraction = {
  title: string;
  start: string;        // ISO 8601 with offset
  end?: string;         // optional — server defaults if omitted
  calendar_label: 'work' | 'personal' | null;
  prompt_language: 'da' | 'en' | 'unknown';
};

export type ClaudeUsage = { input: number; output: number };

const SYSTEM_PROMPT = (tz: string) => `You parse a single calendar-create request. The user's timezone is ${tz}. Return a tool call with title, start, optionally end, optionally calendar_label. If unparseable, return title='UNPARSEABLE'.

Ambiguous-time handling: for inputs without AM/PM context (e.g. "kl. 5", "5 o'clock", "fem"), default to the next reasonable occurrence in the user-local 07:00–22:00 window. If 'now' is before 07:00, pick today 07:00–22:00; if after 22:00, pick tomorrow's window. Specifically prefer afternoon hours (13:00–18:00) when the input is plausibly social/work-related ("møde", "meeting", "lunch", "drinks") — Danish "klokken fem" overwhelmingly means 17:00 in those contexts.

Also report the language you detected ('da' / 'en' / 'unknown') in a prompt_language field so the server can log it for debugging.`;

const TOOL = {
  name: 'create_calendar_event',
  description: 'Structured extraction of a calendar event from a user request.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short title for the event' },
      start: { type: 'string', description: "ISO 8601 with offset in the user's timezone" },
      end: { type: 'string', description: 'OPTIONAL — server defaults if omitted' },
      calendar_label: {
        type: ['string', 'null'],
        enum: ['work', 'personal', null],
        description: 'only set if user mentioned a specific calendar',
      },
      prompt_language: {
        type: 'string',
        enum: ['da', 'en', 'unknown'],
        description: 'detected language of the input',
      },
    },
    required: ['title', 'start', 'calendar_label', 'prompt_language'],
    additionalProperties: false,
  },
};

export async function extractEvent(
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
      system: SYSTEM_PROMPT(timezone),
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'create_calendar_event' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json() as {
    content: Array<{ type: string; name?: string; input?: ClaudeExtraction }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };

  const toolUse = body.content.find((c) => c.type === 'tool_use' && c.name === 'create_calendar_event');
  if (!toolUse?.input) throw new Error('claude returned no tool_use block');

  return {
    extraction: toolUse.input,
    usage: { input: body.usage.input_tokens, output: body.usage.output_tokens },
    model: body.model,
  };
}
