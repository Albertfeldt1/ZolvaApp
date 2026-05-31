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
  // draft_hash must be present (deriveIdemKey + send_reply both require it) and
  // be a 40-char SHA-1 hex of the body.
  assertEquals(typeof result.recordPayload.draft_hash, 'string');
  assertEquals((result.recordPayload.draft_hash as string).length, 40);
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
  assertEquals(result.recordPayload.body_full, 'Tak.');
  assertEquals(result.recordPayload.in_reply_to_message_id, 'm-orig');
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
      to: 'r@x.com',
    },
    ctx,
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.mode, 'propose');
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.draft_id, 'draft-1');
  assertEquals(result.recordPayload.draft_hash, 'sha1-abc');
  assertEquals(result.recordPayload.preview_text, 'Tak for invitationen.');
  assertEquals(result.recordPayload.to, 'r@x.com');
});

Deno.test('mail.archive (outlook): pre-fetches parent folder then moves message', async () => {
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
        // GET parentFolderId
        return new Response(JSON.stringify({ id: 'm-x', parentFolderId: 'inbox' }), {
          status: 200,
        });
      }
      // POST /move
      return new Response(JSON.stringify({ id: 'moved-1', parentFolderId: 'archive' }), {
        status: 201,
      });
    },
  });
  const result = await executeTool(
    'mail.archive',
    { provider: 'microsoft', thread_id: 'm-x', archive_folder_id: 'archive' },
    ctx,
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(urls[0], 'https://graph.microsoft.com/v1.0/me/messages/m-x?$select=parentFolderId');
  assertEquals(methods[0], 'GET');
  assertEquals(urls[1], 'https://graph.microsoft.com/v1.0/me/messages/m-x/move');
  assertEquals(methods[1], 'POST');
  assertEquals(JSON.parse(bodies[1]), { destinationId: 'archive' });
  assertEquals(result.reverseToken?.kind, 'graph.move');
  if (result.reverseToken?.kind === 'graph.move') {
    assertEquals(result.reverseToken.original_folder_id, 'inbox');
  }
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

Deno.test('mail.label (outlook): op=remove is not yet supported', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () =>
      executeTool(
        'mail.label',
        { provider: 'microsoft', thread_id: 'm-x', label: 'Receipts', op: 'remove' },
        ctx,
      ),
    Error,
    'outlook category remove not yet supported',
  );
});

Deno.test('mail.send_reply (policy=auto, all rails pass): executes via Gmail', async () => {
  let sentUrl = '';
  let sentBody = '';
  const ctx = makeCtx({
    fetch: async (u, init) => {
      sentUrl = u;
      sentBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('{"id":"sent-1"}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't-1',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'mor@example.dk',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => false,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(sentUrl, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send');
  assertEquals(JSON.parse(sentBody), { id: 'd-1' });
});

Deno.test('mail.send_reply (policy=auto, all rails pass): executes via Outlook', async () => {
  let sentUrl = '';
  const ctx = makeCtx({
    fetch: async (u) => {
      sentUrl = u;
      return new Response('', { status: 202 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'microsoft',
      thread_id: 't-1',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'mor@example.dk',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => false,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(sentUrl, 'https://graph.microsoft.com/v1.0/me/messages/d-1/send');
});

Deno.test('mail.send_reply (policy=auto, recipient not in allowlist): falls back to propose', async () => {
  let called = false;
  const ctx = makeCtx({
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't-1',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'stranger@example.com',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => false,
        hasPriorFailedIdem: async () => false,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
});

Deno.test('mail.send_reply (policy=auto, user not idle): falls back to propose', async () => {
  let called = false;
  const ctx = makeCtx({
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't',
      draft_id: 'd',
      draft_hash: 'h',
      preview_text: 'p',
      to: 'a@b.dk',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: false,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => false,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
});

Deno.test('mail.send_reply (policy=auto, prior failed idem): falls back to propose', async () => {
  let called = false;
  const ctx = makeCtx({
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't',
      draft_id: 'd',
      draft_hash: 'h',
      preview_text: 'p',
      to: 'a@b.dk',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => true,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
});

Deno.test('mail.send_reply (policy=auto, allowlist throws): falls back to propose', async () => {
  const result = await executeTool(
    'mail.send_reply',
    { provider: 'google', thread_id: 't', draft_id: 'd', draft_hash: 'h', preview_text: 'p', to: 'a@b.dk' },
    { fetch: (async () => new Response('{}', { status: 200 })) as never, gmail: { accessToken: '', resolveLabelId: async () => '' } },
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => { throw new Error('db down'); },
        hasPriorFailedIdem: async () => false,
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'propose');
});

Deno.test('mail.send_reply (policy=auto, prior-fail throws): falls back to propose', async () => {
  const result = await executeTool(
    'mail.send_reply',
    { provider: 'google', thread_id: 't', draft_id: 'd', draft_hash: 'h', preview_text: 'p', to: 'a@b.dk' },
    { fetch: (async () => new Response('{}', { status: 200 })) as never, gmail: { accessToken: '', resolveLabelId: async () => '' } },
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => true,
        hasPriorFailedIdem: async () => { throw new Error('db down'); },
        threadWasResearched: () => true,
      },
    },
  );
  assertEquals(result.mode, 'propose');
});

Deno.test('mail.send_reply (policy=auto, missing safety): falls back to propose (back-compat)', async () => {
  let called = false;
  const ctx = makeCtx({
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't',
      draft_id: 'd',
      draft_hash: 'h',
      preview_text: 'p',
      to: 'a@b.dk',
    },
    ctx,
    { policy: 'auto' },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
});

Deno.test('mail.send_reply (policy=auto, thread not researched): falls back to propose', async () => {
  let called = false;
  let allowlistCalled = false;
  let priorFailCalled = false;
  const ctx = makeCtx({
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    {
      provider: 'google',
      thread_id: 't-no-body',
      draft_id: 'd-1',
      draft_hash: 'h-1',
      preview_text: 'Hej',
      to: 'mor@example.dk',
    },
    ctx,
    {
      policy: 'auto',
      safety: {
        userIsIdle: true,
        hasRecipientHistory: async () => { allowlistCalled = true; return true; },
        hasPriorFailedIdem: async () => { priorFailCalled = true; return false; },
        // Rail fires: agent never opened this thread with mail.get_body.
        threadWasResearched: () => false,
      },
    },
  );
  assertEquals(result.mode, 'propose');
  assertEquals(called, false);
  // Predicate runs BEFORE the Promise.allSettled — no wasted DB reads.
  assertEquals(allowlistCalled, false);
  assertEquals(priorFailCalled, false);
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

Deno.test('executeTool: cal.create_event proposes (no write) when policy != auto', async () => {
  let called = false;
  const ctx = makeCtx({ fetch: async () => { called = true; return new Response('{}', { status: 200 }); } });
  const result = await executeTool(
    'cal.create_event',
    { provider: 'google', title: 'Frokost', start_iso: '2026-06-01T11:00:00Z', end_iso: '2026-06-01T12:00:00Z' },
    ctx,
  );
  assertEquals(result.mode, 'propose');
  assertEquals(result.reversible, false);
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload.title, 'Frokost');
  assertEquals(called, false);
});

Deno.test('executeTool: cal.create_event (google) writes + returns delete token when policy=auto', async () => {
  let captured: { url: string; method: string } | null = null;
  const ctx = makeCtx({
    fetch: async (url, init) => {
      captured = { url, method: init?.method ?? 'GET' };
      return new Response(JSON.stringify({ id: 'evt-9' }), { status: 200 });
    },
  });
  const result = await executeTool(
    'cal.create_event',
    { provider: 'google', title: 'Frokost', start_iso: '2026-06-01T11:00:00Z', end_iso: '2026-06-01T12:00:00Z' },
    ctx,
    { policy: 'auto' },
  );
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, true);
  assertEquals(result.reverseToken?.kind, 'gcal.event_delete');
  assertEquals(result.recordPayload.event_id, 'evt-9');
  assertEquals(captured!.method, 'POST');
});

Deno.test('executeTool: cal.update_event proposes when policy != auto', async () => {
  const ctx = makeCtx();
  const result = await executeTool(
    'cal.update_event',
    { provider: 'microsoft', event_id: 'e1', start_iso: '2026-06-02T14:00:00Z' },
    ctx,
  );
  assertEquals(result.mode, 'propose');
  assertEquals(result.recordPayload.event_id, 'e1');
  assertEquals(result.recordPayload.start_iso, '2026-06-02T14:00:00Z');
});

Deno.test('executeTool: cal.update_event throws when no change fields given', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () => executeTool('cal.update_event', { provider: 'google', event_id: 'e1' }, ctx, { policy: 'auto' }),
    Error,
    'no fields to change',
  );
});

Deno.test('executeTool: cal.update_event throws on empty patch even on propose path', async () => {
  const ctx = makeCtx();
  await assertRejects(
    () => executeTool('cal.update_event', { provider: 'google', event_id: 'e1' }, ctx),
    Error,
    'no fields to change',
  );
});

Deno.test('executeTool: mail.draft_reply (google) stores full body + in_reply_to', async () => {
  const ctx = makeCtx({
    fetch: async () => new Response(JSON.stringify({ id: 'd1', message: { id: 'm1' } }), { status: 200 }),
  });
  const result = await executeTool(
    'mail.draft_reply',
    { provider: 'google', thread_id: 't1', in_reply_to_message_id: 'msg1', to: 'a@x.com', subject: 'Re: Hej', body: 'Det fulde svar som er ret langt' },
    ctx,
  );
  assertEquals(result.recordPayload.body_full, 'Det fulde svar som er ret langt');
  assertEquals(result.recordPayload.in_reply_to_message_id, 'msg1');
});

Deno.test('executeTool: mail.send_reply (google) applies edited_body via update-then-send', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const ctx = makeCtx({
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url });
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    { provider: 'google', thread_id: 't1', draft_id: 'd1', draft_hash: 'h', preview_text: 'p', to: 'a@x.com', subject: 'Re: Hej', in_reply_to_message_id: 'm1', edited_body: 'Min redigerede tekst' },
    ctx,
    { policy: 'auto', safety: { userIsIdle: true, hasRecipientHistory: async () => true, hasPriorFailedIdem: async () => false, threadWasResearched: () => true } },
  );
  assertEquals(result.mode, 'executed');
  // a PUT to the draft (update) happened before the send
  const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/drafts/d1'));
  const send = calls.find((c) => c.url.endsWith('/drafts/send'));
  assertEquals(!!put, true);
  assertEquals(!!send, true);
  assertEquals(calls.indexOf(put!) < calls.indexOf(send!), true);
});

Deno.test('executeTool: mail.send_reply (google) without edited_body does NOT update the draft', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const ctx = makeCtx({
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url });
      return new Response('{}', { status: 200 });
    },
  });
  await executeTool(
    'mail.send_reply',
    { provider: 'google', thread_id: 't1', draft_id: 'd1', draft_hash: 'h', preview_text: 'p', to: 'a@x.com' },
    ctx,
    { policy: 'auto', safety: { userIsIdle: true, hasRecipientHistory: async () => true, hasPriorFailedIdem: async () => false, threadWasResearched: () => true } },
  );
  assertEquals(calls.some((c) => c.method === 'PUT'), false);
});

Deno.test('executeTool: mail.send_reply (outlook) applies edited_body via PATCH-then-send', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const ctx = makeCtx({
    fetch: async (url: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url });
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'mail.send_reply',
    { provider: 'microsoft', thread_id: 't1', draft_id: 'd1', draft_hash: 'h', preview_text: 'p', to: 'a@x.com', edited_body: 'Redigeret' },
    ctx,
    { policy: 'auto', safety: { userIsIdle: true, hasRecipientHistory: async () => true, hasPriorFailedIdem: async () => false, threadWasResearched: () => true } },
  );
  const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/me/messages/d1'));
  const send = calls.find((c) => c.url.endsWith('/me/messages/d1/send'));
  assertEquals(!!patch, true);
  assertEquals(!!send, true);
  assertEquals(calls.indexOf(patch!) < calls.indexOf(send!), true);
  assertEquals(result.mode, 'executed');
});

Deno.test('executeTool: nudge.push echoes payload as executed, makes no network call, needs no provider', async () => {
  let fetched = false;
  const ctx = makeCtx({
    fetch: async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    },
  });
  const result = await executeTool(
    'nudge.push',
    { action_kind: 'mail_attention', target_id: 'thread-9', title: 'Vigtig mail', body: 'Din pakke er forsinket' },
    ctx,
  );
  assertEquals(fetched, false);
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, false);
  assertEquals(result.reverseToken, null);
  assertEquals(result.recordPayload, {
    action_kind: 'mail_attention',
    target_id: 'thread-9',
    title: 'Vigtig mail',
    body: 'Din pakke er forsinket',
  });
});

Deno.test('executeTool: nudge.push throws when title missing', async () => {
  await assertRejects(
    () => executeTool('nudge.push', { action_kind: 'k', target_id: 't', body: 'b' }, makeCtx()),
    Error,
    'title',
  );
});

Deno.test('executeTool: mail.search (google) returns hits as context, no agent_actions semantics', async () => {
  const ctx = makeCtx({
    fetch: async (url: string) => {
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }), { status: 200 });
      return new Response(JSON.stringify({ threadId: 't1', snippet: 's', payload: { headers: [{ name: 'From', value: 'A <a@x>' }, { name: 'Subject', value: 'Sub' }, { name: 'Date', value: 'd' }] } }), { status: 200 });
    },
  });
  const result = await executeTool('mail.search', { provider: 'google', query: 'a@x' }, ctx);
  assertEquals(result.mode, 'executed');
  assertEquals(result.reversible, false);
  assertEquals(Array.isArray((result.recordPayload as { hits: unknown[] }).hits), true);
  assertEquals(((result.recordPayload as { hits: Array<{ thread_id: string }> }).hits)[0].thread_id, 't1');
});
