// Shared Anthropic client. All three AI features (chat, observations,
// email drafts) call into this module.
//
// SECURITY: The API key is shipped in the bundle via EXPO_PUBLIC_ANTHROPIC_API_KEY.
// This is demo-only. Before production, proxy through a backend or Supabase
// Edge Function so the key never leaves the server.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const API_VERSION = '2023-06-01';

const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? '';

export class ClaudeConfigError extends Error {
  constructor() {
    super('Missing EXPO_PUBLIC_ANTHROPIC_API_KEY. Add it to .env and restart Metro.');
    this.name = 'ClaudeConfigError';
  }
}

export function hasClaudeKey(): boolean {
  return apiKey.length > 0;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
};

export type ClaudeToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type CompleteOptions = {
  system?: string;
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: ClaudeToolSchema[];
  metadata?: { user_id?: string };
};

type AnthropicResponse = {
  content: ClaudeContentBlock[];
  stop_reason: string;
};

export type ClaudeToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ClaudeCompletion = {
  text: string;
  toolUses: ClaudeToolUse[];
  stopReason: string;
  rawContent: ClaudeContentBlock[];
};

export async function completeRaw(opts: CompleteOptions): Promise<ClaudeCompletion> {
  if (!apiKey) throw new ClaudeConfigError();
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.7,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      metadata: opts.metadata,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as AnthropicResponse;
  const text = json.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  const toolUses = json.content.flatMap((block): ClaudeToolUse[] =>
    block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
  );
  return { text, toolUses, stopReason: json.stop_reason, rawContent: json.content };
}

export async function complete(opts: CompleteOptions): Promise<string> {
  const { text } = await completeRaw(opts);
  return text;
}

// Structured JSON response. Prompts the model to return JSON and parses it.
export async function completeJson<T>(opts: CompleteOptions & { schemaHint: string }): Promise<T> {
  const systemWithSchema = [
    opts.system ?? '',
    '',
    'Return ONLY valid JSON matching this schema. No markdown fences, no prose.',
    opts.schemaHint,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await complete({ ...opts, system: systemWithSchema, temperature: opts.temperature ?? 0.3 });
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}
