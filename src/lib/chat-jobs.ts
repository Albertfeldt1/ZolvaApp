// Client side of the chat-jobs background-execution path. Wraps the
// chat-run edge function so the chat turn keeps running on the server
// after the app backgrounds, plus the foreground reconciler that picks
// up answers landed while the user was away.
//
// Flow:
//   1. useChat.send builds messages/system/tools as today, then calls
//      submitChatJob instead of completeRaw for the first round.
//   2. chat-run inserts a chat_jobs row, calls Claude. If pure text,
//      writes outcome and pushes a notification. If tool_use, marks the
//      row needs_tools and returns the tool blocks.
//   3. Client either appends the answer (done) or continues today's
//      local tool loop (needs_tools).
//   4. acknowledgeChatJob marks the row delivered so the foreground
//      reconciler won't re-show it on the next app open AND suppresses
//      a redundant tray banner if the push lands while we're foregrounded.

import { supabase } from './supabase';
import {
  ClaudeConfigError,
  ClaudeRateLimitError,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeSystemBlock,
  type ClaudeToolSchema,
  type ClaudeToolUse,
} from './claude';
import { rememberChatJobAcknowledged } from './notifications';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const CHAT_RUN_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/chat-run`;
const CHAT_FINALIZE_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/chat-finalize`;

export type ChatJobStatus = 'running' | 'done' | 'needs_tools' | 'error';

export type ChatJobSubmitOptions = {
  messages: ClaudeMessage[];
  system: string | ClaudeSystemBlock[];
  tools?: ClaudeToolSchema[];
  metadata?: Record<string, unknown>;
  // Short preview of the user's last turn for the push notification body.
  // Optional - the server falls back to just the answer if missing.
  userPreview?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type ChatJobDone = {
  jobId: string;
  status: 'done';
  text: string;
};

export type ChatJobNeedsTools = {
  jobId: string;
  status: 'needs_tools';
  toolUses: ClaudeToolUse[];
  rawContent: ClaudeContentBlock[];
  text: string;
};

export type ChatJobError = {
  jobId: string | null;
  status: 'error';
  errorCode: string;
};

export type ChatJobResult = ChatJobDone | ChatJobNeedsTools | ChatJobError;

export async function submitChatJob(opts: ChatJobSubmitOptions): Promise<ChatJobResult> {
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new ClaudeConfigError('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new ClaudeConfigError('Du skal være logget ind for at bruge Claude.');
  }

  const payload: Record<string, unknown> = {
    messages: opts.messages,
    system: typeof opts.system === 'string'
      ? [{ type: 'text', text: opts.system } satisfies ClaudeSystemBlock]
      : opts.system,
  };
  if (opts.tools && opts.tools.length > 0) payload.tools = opts.tools;
  if (opts.metadata) payload.metadata = opts.metadata;
  if (opts.userPreview) payload.userPreview = opts.userPreview;
  if (opts.model) payload.model = opts.model;
  if (opts.maxTokens) payload.max_tokens = opts.maxTokens;

  const res = await fetch(CHAT_RUN_URL, {
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

  // Even on non-2xx the body may carry a jobId so the caller can show
  // partial state if useful; we just surface it as an error result.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { jobId: null, status: 'error', errorCode: `http_${res.status}_unparseable` };
  }

  if (!res.ok) {
    const errCode =
      (parsed as { error?: unknown })?.error && typeof (parsed as { error?: unknown }).error === 'string'
        ? ((parsed as { error: string }).error)
        : `http_${res.status}`;
    const jobId = (parsed as { jobId?: unknown })?.jobId;
    return {
      jobId: typeof jobId === 'string' ? jobId : null,
      status: 'error',
      errorCode: errCode,
    };
  }

  const r = parsed as {
    jobId?: unknown;
    status?: unknown;
    text?: unknown;
    toolUses?: unknown;
    rawContent?: unknown;
  };
  if (typeof r.jobId !== 'string' || typeof r.status !== 'string') {
    return { jobId: null, status: 'error', errorCode: 'malformed_response' };
  }

  if (r.status === 'done') {
    return { jobId: r.jobId, status: 'done', text: typeof r.text === 'string' ? r.text : '' };
  }
  if (r.status === 'needs_tools') {
    const toolUses = Array.isArray(r.toolUses) ? (r.toolUses as ClaudeToolUse[]) : [];
    const rawContent = Array.isArray(r.rawContent) ? (r.rawContent as ClaudeContentBlock[]) : [];
    return {
      jobId: r.jobId,
      status: 'needs_tools',
      toolUses,
      rawContent,
      text: typeof r.text === 'string' ? r.text : '',
    };
  }
  return { jobId: r.jobId, status: 'error', errorCode: `unexpected_status_${r.status}` };
}

// Mark a job as displayed in-band. Two effects:
//   1. Server row gets acknowledged_at = now() so the foreground reconciler
//      won't re-emit the message on the next app open.
//   2. notifications.setNotificationHandler suppresses the foreground tray
//      banner for this jobId (the chat-run server always pushes; if we got
//      the answer in-band, the banner would be a redundant duplicate).
export async function acknowledgeChatJob(jobId: string): Promise<void> {
  rememberChatJobAcknowledged(jobId);
  try {
    const { error } = await supabase
      .from('chat_jobs')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', jobId);
    if (error && __DEV__) console.warn('[chat-jobs] ack failed:', error.message);
  } catch (err) {
    if (__DEV__) console.warn('[chat-jobs] ack threw:', err);
  }
}

// On AppState=active, fetch any 'done' jobs the user submitted that haven't
// been displayed yet. Used by useChat to render answers that arrived while
// the app was backgrounded.
export type PendingDoneJob = {
  jobId: string;
  text: string;
  finishedAt: Date;
};

export async function fetchUnacknowledgedDoneJobs(userId: string): Promise<PendingDoneJob[]> {
  try {
    const { data, error } = await supabase
      .from('chat_jobs')
      .select('id, output_text, finished_at')
      .eq('user_id', userId)
      .eq('status', 'done')
      .is('acknowledged_at', null)
      .order('finished_at', { ascending: true });
    if (error) {
      if (__DEV__) console.warn('[chat-jobs] reconcile fetch failed:', error.message);
      return [];
    }
    return (data ?? [])
      .filter(
        (r): r is { id: string; output_text: string; finished_at: string } =>
          typeof r.id === 'string' &&
          typeof r.output_text === 'string' &&
          typeof r.finished_at === 'string',
      )
      .map((r) => ({
        jobId: r.id,
        text: r.output_text,
        finishedAt: new Date(r.finished_at),
      }));
  } catch (err) {
    if (__DEV__) console.warn('[chat-jobs] reconcile threw:', err);
    return [];
  }
}

// After the client-side tool loop produces the final answer for a turn
// that started as needs_tools, call this to mark the chat_jobs row done
// and fire the push (so users who backgrounded mid-loop within iOS's
// ~30s grace get a tray banner when the answer lands). Best-effort; the
// caller has already updated local UI before this runs.
export async function finalizeChatJob(
  jobId: string,
  finalText: string,
  userPreview?: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_ANON) return;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) return;
    const res = await fetch(CHAT_FINALIZE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ jobId, finalText, userPreview }),
    });
    if (!res.ok && __DEV__) {
      const detail = await res.text().catch(() => '<unreadable>');
      console.warn('[chat-jobs] finalize non-2xx:', res.status, detail);
    }
  } catch (err) {
    if (__DEV__) console.warn('[chat-jobs] finalize threw:', err);
  }
}
