// Shared Anthropic client — calls the `claude-proxy` Supabase Edge Function,
// which holds ANTHROPIC_API_KEY server-side and forwards to Anthropic.
// The public interface is unchanged: callers keep using complete / completeRaw
// / completeJson / hasClaudeKey as before.

import { supabase } from './supabase';
import { buildProfilePreamble } from './profile';
import { getPrivacyFlag } from './hooks';

// Default model for all Claude calls unless a caller passes `model` explicitly.
// Haiku is cheap and fast, the right fit for classification and short extraction
// work. User-visible copy (reply drafts, daily briefs) overrides this — see
// individual call sites in hooks.ts.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const PROXY_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/claude-proxy`;

export class ClaudeConfigError extends Error {
  constructor(message = 'Claude er ikke tilgængelig. Log ind og prøv igen.') {
    super(message);
    this.name = 'ClaudeConfigError';
  }
}

export class ClaudeRateLimitError extends Error {
  readonly retryAfterSec: number;
  readonly reason: 'rpm' | 'daily';
  constructor(retryAfterSec: number, reason: 'rpm' | 'daily') {
    super(
      reason === 'daily'
        ? 'Du har nået dagens grænse for Zolva. Prøv igen i morgen.'
        : 'Zolva holder en kort pause — prøv igen om lidt.',
    );
    this.name = 'ClaudeRateLimitError';
    this.retryAfterSec = retryAfterSec;
    this.reason = reason;
  }
}

// The key lives in the edge function now, so there's no local key check.
// Keep this export for callers that used it as a feature gate; the real
// authorization check happens server-side when the proxy is invoked.
export function hasClaudeKey(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON.length > 0;
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

export type ClaudeSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type CompleteOptions = {
  system?: string | ClaudeSystemBlock[];
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: ClaudeToolSchema[];
  metadata?: { user_id?: string };
  attachProfile?: boolean; // default true
  model?: string; // overrides DEFAULT_MODEL; proxy forwards as-is
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
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new ClaudeConfigError('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  const userId = sessionData.session?.user?.id;
  if (!accessToken) {
    throw new ClaudeConfigError('Du skal være logget ind for at bruge Claude.');
  }

  const attach = opts.attachProfile !== false && userId;
  let systemBlocks: ClaudeSystemBlock[] = [];
  if (attach && getPrivacyFlag('memory-enabled')) {
    const preamble = await buildProfilePreamble(userId, { user: sessionData.session!.user });
    if (preamble) {
      systemBlocks.push({ type: 'text', text: preamble, cache_control: { type: 'ephemeral' } });
    }
  }
  if (opts.system != null) {
    if (typeof opts.system === 'string') {
      systemBlocks.push({ type: 'text', text: opts.system });
    } else {
      systemBlocks.push(...opts.system);
    }
  }

  const payload: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
    messages: opts.messages,
  };
  if (systemBlocks.length > 0) payload.system = systemBlocks;
  if (opts.tools != null) payload.tools = opts.tools;

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_ANON,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
    const body = await res.text();
    const reason: 'rpm' | 'daily' = body.includes('daily') ? 'daily' : 'rpm';
    throw new ClaudeRateLimitError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      reason,
    );
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude proxy ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as AnthropicResponse;
  if (!Array.isArray(json.content)) {
    throw new Error('Claude proxy returned malformed response');
  }

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
  const schemaSuffix = [
    'Return ONLY valid JSON matching this schema. No markdown fences, no prose.',
    opts.schemaHint,
  ].join('\n');

  // Preserve the caller's system shape: a string gets appended to with newlines;
  // an array-form ClaudeSystemBlock[] gets a trailing text block. Previously
  // the array path was silently dropped — completeJson is rarely called with
  // arrays today but the type signature promises support.
  let systemWithSchema: string | ClaudeSystemBlock[];
  if (Array.isArray(opts.system)) {
    systemWithSchema = [...opts.system, { type: 'text' as const, text: schemaSuffix }];
  } else {
    systemWithSchema = [opts.system ?? '', '', schemaSuffix].filter(Boolean).join('\n');
  }

  const raw = await complete({ ...opts, system: systemWithSchema, temperature: opts.temperature ?? 0.3 });
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}
