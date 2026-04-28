import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { verifyJwt } from './jwt.ts';

type WidgetActionRequest = {
  prompt?: string;
  timezone?: string;
  locale?: string;
};

type WidgetActionResponse = {
  dialog: string;
  snippet: {
    mood: 'happy' | 'worried';
    summary: string;
    deepLink: string;
  };
};

const json = (status: number, body: WidgetActionResponse): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  let userId: string;
  try {
    const verified = await verifyJwt(token);
    userId = verified.userId;
  } catch {
    return json(401, {
      dialog: 'Logget ud — åbn Zolva for at logge ind igen.',
      snippet: { mood: 'worried', summary: 'Logget ud', deepLink: 'zolva://settings' },
    });
  }

  const body = (await req.json().catch(() => ({}))) as WidgetActionRequest;
  // Subsequent tasks fill in the pipeline. For now, prove the wiring.
  return json(200, {
    dialog: `OK ${userId.slice(0, 6)} · ${body.prompt ?? '(empty)'}`,
    snippet: { mood: 'happy', summary: 'pipeline TODO', deepLink: 'zolva://chat' },
  });
});
