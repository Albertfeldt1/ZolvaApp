import { mergeProposedActions, type ProposedActionRow } from '../agent-proposals';

jest.mock('../supabase', () => ({ supabase: {} as never }));

const row = (id: string, created: string, status: ProposedActionRow['status'] = 'pending'): ProposedActionRow => ({
  id,
  action_type: 'mail.send_reply',
  payload: { thread_id: 't1', draft_id: 'draft-1' },
  preview: { title: 'Send svar?', body: 'Tak.' },
  status,
  created_at: created,
  expires_at: new Date(new Date(created).getTime() + 72 * 3600 * 1000).toISOString(),
});

describe('mergeProposedActions', () => {
  it('replaces row by id and re-sorts by created_at desc', () => {
    const before = [row('a', '2026-05-13T10:00:00Z'), row('b', '2026-05-13T11:00:00Z')];
    const merged = mergeProposedActions(before, row('b', '2026-05-13T11:00:00Z', 'executed'));
    expect(merged.find((r) => r.id === 'b')?.status).toBe('executed');
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
  it('prepends new row', () => {
    const merged = mergeProposedActions([row('a', '2026-05-13T10:00:00Z')], row('b', '2026-05-13T12:00:00Z'));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
