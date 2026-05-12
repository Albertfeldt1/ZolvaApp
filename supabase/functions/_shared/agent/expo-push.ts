// supabase/functions/_shared/agent/expo-push.ts
//
// Expo Push API caller for agent proposals. Mirrors the pattern from
// reminders-fire (one message per token, single batched POST). Failures
// are swallowed by the caller; we don't retry pushes.

export type PushFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface DispatchExpoPushInput {
  fetch: PushFetch;
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export async function dispatchExpoPush(input: DispatchExpoPushInput): Promise<void> {
  if (input.tokens.length === 0) return;
  const messages = input.tokens.map((token) => ({
    to: token,
    title: input.title,
    body: input.body,
    sound: 'default',
    data: input.data,
  }));
  await input.fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messages),
  });
}
