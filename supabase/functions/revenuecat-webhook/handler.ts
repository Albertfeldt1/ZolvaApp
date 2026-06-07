// supabase/functions/revenuecat-webhook/handler.ts
import { eventToOutcome, type EntitlementState, type RcEvent } from '../_shared/entitlement.ts';
import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';

export type WebhookDeps = {
  secret: string;
  upsert: (userId: string, state: EntitlementState, raw: unknown) => Promise<void>;
  expire: (userId: string, raw: unknown) => Promise<void>;
};

export type WebhookResult = { status: number; body: { ok: boolean; reason?: string } };

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleWebhook(
  authHeader: string | null,
  payload: { event?: RcEvent } | null,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!secretMatches(authHeader, deps.secret)) {
    return { status: 401, body: { ok: false, reason: 'bad auth' } };
  }
  const event = payload?.event;
  if (!event || typeof event.type !== 'string') {
    return { status: 400, body: { ok: false, reason: 'no event' } };
  }
  const outcome = eventToOutcome(event);
  if (outcome.action === 'ignore') {
    return { status: 200, body: { ok: true, reason: outcome.reason } };
  }
  if (outcome.action === 'expire') {
    await deps.expire(outcome.userId, payload);
    return { status: 200, body: { ok: true } };
  }
  await deps.upsert(outcome.userId, outcome.state, payload);
  return { status: 200, body: { ok: true } };
}
