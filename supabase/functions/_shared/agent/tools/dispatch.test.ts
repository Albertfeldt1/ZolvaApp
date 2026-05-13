// supabase/functions/_shared/agent/tools/dispatch.test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { executeTool, type ExecuteContext } from './dispatch.ts';

function makeCtx(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    fetch: async () => new Response('{}', { status: 200 }),
    gmail: {
      accessToken: 'tok',
      resolveLabelId: async (name) => `L_${name.toUpperCase().replace(/\s+/g, '_')}`,
    },
    outlook: { accessToken: 'outlook-tok' },
    ...overrides,
  };
}

Deno.test('executeTool: mail.archive removes INBOX label', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool('mail.archive', { provider: 'google', thread_id: 't1' }, ctx);
  assertEquals(captured!.url.endsWith('/threads/t1/modify'), true);
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: [],
    removeLabelIds: ['INBOX'],
  });
  assertEquals(result.reverseToken?.kind, 'gmail.modify');
  assertEquals(result.recordPayload.thread_id, 't1');
  assertEquals(result.reversible, true);
  assertEquals(result.mode, 'executed');
});

Deno.test('executeTool: mail.label add resolves and applies', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.label',
    { provider: 'google', thread_id: 't1', label: 'Receipts', op: 'add' },
    ctx,
  );
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: ['L_RECEIPTS'],
    removeLabelIds: [],
  });
  assertEquals(result.recordPayload.label, 'Receipts');
  assertEquals(result.recordPayload.op, 'add');
  assertEquals(result.mode, 'executed');
});

Deno.test('executeTool: mail.flag_important applies Zolva flaggede label', async () => {
  let captured: { url: string; body: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.flag_important',
    { provider: 'google', thread_id: 't1' },
    ctx,
  );
  assertEquals(JSON.parse(captured!.body), {
    addLabelIds: ['L_ZOLVA_FLAGGEDE'],
    removeLabelIds: [],
  });
  assertEquals(result.recordPayload.thread_id, 't1');
  assertEquals(result.mode, 'executed');
});

Deno.test('executeTool: mail.summarize records summary, no Gmail call, not reversible', async () => {
  let fetchCalls = 0;
  const ctx = makeCtx({
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.summarize',
    { provider: 'google', thread_id: 't1', summary: 'Acme renewal — expires 2026-05-30.' },
    ctx,
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.reversible, false);
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.summary, 'Acme renewal — expires 2026-05-30.');
  assertEquals(result.mode, 'executed');
});

Deno.test('executeTool: mail.draft_reply with provider=google calls gmail draft', async () => {
  let captured: string | null = null;
  const ctx = makeCtx({
    fetch: async (url) => {
      captured = url;
      return new Response(
        JSON.stringify({ id: 'draft-1', message: { id: 'm-1', threadId: 't1' } }),
        { status: 200 },
      );
    },
  });
  const result = await executeTool(
    'mail.draft_reply',
    {
      provider: 'google',
      thread_id: 't1',
      in_reply_to_message_id: 'm-orig',
      to: 'r@x.com',
      subject: 'Re: Faktura',
      body: 'Tak.',
    },
    ctx,
  );
  assertEquals(captured!.endsWith('/users/me/drafts'), true);
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(result.reverseToken?.kind, 'gmail.draft');
  assertEquals(result.recordPayload.draft_id, 'draft-1');
});

Deno.test('executeTool: mail.draft_reply with provider=microsoft hits graph createReply', async () => {
  let urls: string[] = [];
  const ctx = makeCtx({
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.draft_reply',
    {
      provider: 'microsoft',
      thread_id: 't1',
      in_reply_to_message_id: 'm-orig',
      to: 'r@x.com',
      subject: 'Re: Hej',
      body: 'Tak.',
    },
    ctx,
  );
  assertEquals(urls[0].includes('createReply'), true);
  assertEquals(result.reverseToken?.kind, 'graph.draft');
});

Deno.test('executeTool: mail.send_reply returns mode=propose without calling provider', async () => {
  let fetchCalls = 0;
  const ctx = makeCtx({
    fetch: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't1',
      draft_id: 'draft-1',
      draft_hash: 'sha1-abc',
      preview_text: 'Tak for invitationen.',
    },
    ctx,
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.mode, 'propose');
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.draft_id, 'draft-1');
  assertEquals(result.recordPayload.draft_hash, 'sha1-abc');
  assertEquals(result.recordPayload.preview_text, 'Tak for invitationen.');
});

Deno.test('mail.archive (outlook): moves message to archive folder', async () => {
  let url = '';
  let method = '';
  let body = '';
  const ctx = makeCtx({
    fetch: async (u, init) => {
      url = u;
      method = init?.method ?? 'GET';
      body = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ id: 'moved-1' }), { status: 201 });
    },
  });
  const result = await executeTool(
    'mail.archive',
    { provider: 'microsoft', thread_id: 'm-x', archive_folder_id: 'archive' },
    ctx,
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(url, 'https://graph.microsoft.com/v1.0/me/messages/m-x/move');
  assertEquals(method, 'POST');
  assertEquals(JSON.parse(body), { destinationId: 'archive' });
  assertEquals(result.reverseToken?.kind, 'graph.move');
  assertEquals(result.recordPayload.archive_folder_id, 'archive');
});

Deno.test('mail.label (outlook): adds category via two-step GET-then-PATCH', async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const bodies: string[] = [];
  let step = 0;
  const ctx = makeCtx({
    fetch: async (u, init) => {
      urls.push(u);
      methods.push(init?.method ?? 'GET');
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      step += 1;
      if (step === 1) {
        // GET existing categories
        return new Response(JSON.stringify({ id: 'm-x', categories: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'm-x', categories: ['Receipts'] }), {
        status: 200,
      });
    },
  });
  const result = await executeTool(
    'mail.label',
    { provider: 'microsoft', thread_id: 'm-x', label: 'Receipts', op: 'add' },
    ctx,
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reverseToken?.kind, 'graph.category');
  assertEquals(urls[0], 'https://graph.microsoft.com/v1.0/me/messages/m-x?$select=categories');
  assertEquals(urls[1], 'https://graph.microsoft.com/v1.0/me/messages/m-x');
  assertEquals(methods[1], 'PATCH');
  assertEquals(JSON.parse(bodies[1]), { categories: ['Receipts'] });
});

Deno.test('mail.label (outlook): op=remove is not supported in phase 3.1', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () =>
      executeTool(
        'mail.label',
        { provider: 'microsoft', thread_id: 'm-x', label: 'Receipts', op: 'remove' },
        ctx,
      ),
    Error,
    'outlook label remove not supported',
  );
});

Deno.test('mail.flag_important (outlook): PATCHes flag.flagStatus=flagged', async () => {
  let url = '';
  let method = '';
  let body = '';
  const ctx = makeCtx({
    fetch: async (u, init) => {
      url = u;
      method = init?.method ?? 'GET';
      body = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ id: 'm-x', flag: { flagStatus: 'flagged' } }), {
        status: 200,
      });
    },
  });
  const result = await executeTool(
    'mail.flag_important',
    { provider: 'microsoft', thread_id: 'm-x' },
    ctx,
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reverseToken?.kind, 'graph.flag');
  assertEquals(url, 'https://graph.microsoft.com/v1.0/me/messages/m-x');
  assertEquals(method, 'PATCH');
  assertEquals(JSON.parse(body), { flag: { flagStatus: 'flagged' } });
});
