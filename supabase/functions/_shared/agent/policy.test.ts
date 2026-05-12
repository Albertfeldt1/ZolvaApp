// supabase/functions/_shared/agent/policy.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolvePolicy } from './policy.ts';

Deno.test('resolvePolicy: absent row returns spec default', () => {
  assertEquals(resolvePolicy('mail.label', []), 'auto');
  assertEquals(resolvePolicy('mail.send_reply', []), 'propose');
});

Deno.test('resolvePolicy: user override beats default', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.label' as const, mode: 'off' as const },
  ];
  assertEquals(resolvePolicy('mail.label', rows), 'off');
});

Deno.test('resolvePolicy: user can upgrade propose -> auto', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.send_reply' as const, mode: 'auto' as const },
  ];
  assertEquals(resolvePolicy('mail.send_reply', rows), 'auto');
});

Deno.test('resolvePolicy: only the row matching action_type wins', () => {
  const rows = [
    { user_id: 'u', action_type: 'mail.label' as const, mode: 'off' as const },
    { user_id: 'u', action_type: 'mail.archive' as const, mode: 'propose' as const },
  ];
  assertEquals(resolvePolicy('mail.archive', rows), 'propose');
  assertEquals(resolvePolicy('mail.flag_important', rows), 'auto');
});
