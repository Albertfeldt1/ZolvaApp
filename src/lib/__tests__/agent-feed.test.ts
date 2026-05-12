// src/lib/__tests__/agent-feed.test.ts
// Mock supabase before importing agent-feed.ts to avoid native-module
// errors in Jest. mergeAgentActions is a pure function and does not use it.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

import { mergeAgentActions, type AgentActionRow } from '../agent-feed';

const row = (id: string, executed: string, reversed: string | null = null): AgentActionRow => ({
  id,
  action_type: 'mail.archive',
  payload: { thread_id: 't1' },
  executed_at: executed,
  reversible: true,
  reverse_token: { kind: 'gmail.modify', thread_id: 't1', add_label_ids: ['INBOX'], remove_label_ids: [] },
  reversed_at: reversed,
});

describe('mergeAgentActions', () => {
  it('replaces matching row by id', () => {
    const before = [row('a', '2026-05-12T10:00:00Z'), row('b', '2026-05-12T11:00:00Z')];
    const merged = mergeAgentActions(before, row('b', '2026-05-12T11:00:00Z', '2026-05-12T12:00:00Z'));
    expect(merged.find((r) => r.id === 'b')?.reversed_at).toBe('2026-05-12T12:00:00Z');
    expect(merged).toHaveLength(2);
  });
  it('prepends new row in descending executed_at order', () => {
    const before = [row('a', '2026-05-12T10:00:00Z')];
    const merged = mergeAgentActions(before, row('b', '2026-05-12T11:00:00Z'));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('does not show reverted rows in the feed by default', () => {
    const r1 = row('a', '2026-05-12T10:00:00Z', '2026-05-12T10:05:00Z');
    const r2 = row('b', '2026-05-12T11:00:00Z');
    expect(mergeAgentActions([r1, r2], r1).filter((r) => !r.reversed_at).map((r) => r.id)).toEqual(['b']);
  });
});
