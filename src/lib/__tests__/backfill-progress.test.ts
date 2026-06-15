import { isBackfillComplete } from '../backfill-progress';

describe('isBackfillComplete', () => {
  test('empty job set is NOT complete until a status poll has confirmed it', () => {
    // Guards against advancing before the first poll resolves.
    expect(isBackfillComplete([], false)).toBe(false);
  });

  test('empty job set IS complete once a poll confirmed there are no jobs', () => {
    // Regression: previously this case waited the full 45s animation ceiling
    // because the completion effect bailed on jobs.length === 0.
    expect(isBackfillComplete([], true)).toBe(true);
  });

  test('not complete while any job is still non-terminal', () => {
    expect(isBackfillComplete([{ status: 'done' }, { status: 'queued' }], true)).toBe(false);
    expect(isBackfillComplete([{ status: 'running' }], true)).toBe(false);
  });

  test('complete when every job is in a terminal state', () => {
    expect(isBackfillComplete([{ status: 'done' }, { status: 'failed' }], true)).toBe(true);
    expect(isBackfillComplete([{ status: 'cancelled' }], true)).toBe(true);
  });
});
