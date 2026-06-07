// supabase/functions/revenuecat-webhook/handler.ts
import { eventToOutcome, type EntitlementState, type RcEvent } from '../_shared/entitlement.ts';

export type WebhookDeps = {
  secret: string;
  upsert: (userId: string, state: EntitlementState, raw: unknown) => Promise<void>;
  expire: (userId: string, raw: unknown) => Promise<void>;
};

export type WebhookResult = { status: number; body: { ok: boolean; reason?: string } };

export async function handleWebhook(
  authHeader: string | null,
  payload: { event?: RcEvent } | null,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!authHeader || authHeader !== deps.secret) {
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
