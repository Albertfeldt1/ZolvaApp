// supabase/functions/_shared/agent/verify.ts
import type { ClaimedEvent } from './runner.ts';

export function buildThreadAllowlist(events: ClaimedEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'mail.new') continue;
    const tid = e.payload.thread_id;
    if (typeof tid === 'string' && tid) out.add(tid);
  }
  return out;
}

export function verifyThreadId(threadId: string, allow: Set<string>): void {
  if (!allow.has(threadId)) {
    throw new Error(`hallucination-guard: unknown thread ${threadId}`);
  }
}
