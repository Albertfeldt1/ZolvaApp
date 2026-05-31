// src/lib/__tests__/agent-commitments.test.ts
// Mock supabase before importing agent-commitments.ts to avoid native-module
// errors in Jest. mergeOpenCommitments is pure and does not use it.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

import { mergeOpenCommitments, type CommitmentRow } from '../agent-commitments';

const row = (over: Partial<CommitmentRow>): CommitmentRow => ({
  id: 'c1',
  direction: 'you_owe',
  counterparty: 'Allan',
  summary: 'Send Q3-decket',
  due_at: null,
  due_inferred: false,
  thread_id: 't1',
  provider: 'google',
  status: 'open',
  created_at: '2026-06-01T08:00:00Z',
  nudged_at: null,
  resolved_at: null,
  ...over,
});

describe('mergeOpenCommitments', () => {
  it('replaces a matching row by id', () => {
    const before = [row({ id: 'a' }), row({ id: 'b', summary: 'old' })];
    const merged = mergeOpenCommitments(before, row({ id: 'b', summary: 'new' }));
    expect(merged.find((r) => r.id === 'b')?.summary).toBe('new');
    expect(merged).toHaveLength(2);
  });

  it('drops a row once it is no longer open (resolved/expired removed from view)', () => {
    const before = [row({ id: 'a' }), row({ id: 'b' })];
    const merged = mergeOpenCommitments(before, row({ id: 'b', status: 'resolved' }));
    expect(merged.map((r) => r.id)).toEqual(['a']);
  });

  it('sorts you_owe before owed_to_you, then oldest-first within a group', () => {
    const before = [
      row({ id: 'owed-new', direction: 'owed_to_you', created_at: '2026-06-03T08:00:00Z' }),
      row({ id: 'owe-new', direction: 'you_owe', created_at: '2026-06-02T08:00:00Z' }),
    ];
    const merged = mergeOpenCommitments(
      before,
      row({ id: 'owe-old', direction: 'you_owe', created_at: '2026-06-01T08:00:00Z' }),
    );
    expect(merged.map((r) => r.id)).toEqual(['owe-old', 'owe-new', 'owed-new']);
  });
});
