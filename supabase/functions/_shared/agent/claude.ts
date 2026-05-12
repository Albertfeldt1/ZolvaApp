// supabase/functions/_shared/agent/claude.ts

export type ClaudeFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface ClaudeSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ClaudeUserMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

export interface CallClaudeInput {
  fetch: ClaudeFetch;
  apiKey: string;
  system: ClaudeSystemBlock[];
  messages: ClaudeUserMessage[];
  tools?: unknown[];
  model?: string;
  maxTokens?: number;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CallClaudeResult {
  content: Array<Record<string, unknown>>;
  usage: ClaudeUsage;
  stop_reason: string;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;

export async function callClaude(input: CallClaudeInput): Promise<CallClaudeResult> {
  const body: Record<string, unknown> = {
    model: input.model ?? DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: input.system,
    messages: input.messages,
  };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;

  const res = await input.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`claude ${res.status}: ${detail.slice(0, 300)}`);
  }
  const j = (await res.json()) as {
    content?: Array<Record<string, unknown>>;
    usage?: ClaudeUsage;
    stop_reason?: string;
  };
  return {
    content: j.content ?? [],
    usage: j.usage ?? { input_tokens: 0, output_tokens: 0 },
    stop_reason: j.stop_reason ?? 'unknown',
  };
}
