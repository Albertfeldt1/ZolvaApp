// supabase/functions/agent-tick/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectEligibleUserIds } from './index.ts';

Deno.test('selectEligibleUserIds: filters via v_users_with_pending_agent_events', async () => {
  const calls: string[] = [];
  const fakeClient = {
    from(view: string) {
      calls.push(view);
      assertEquals(view, 'v_users_with_pending_agent_events');
      return {
        select(_cols: string) {
          return Promise.resolve({
            data: [
              { user_id: 'u-1' },
              { user_id: 'u-2' },
              { user_id: 'u-1' },
            ],
            error: null,
          });
        },
      };
    },
  };
  const ids = await selectEligibleUserIds(fakeClient as never);
  assertEquals(ids.sort(), ['u-1', 'u-2']);
  assertEquals(calls, ['v_users_with_pending_agent_events']);
});
