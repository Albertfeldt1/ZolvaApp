import { shouldSeedReplyDraft } from '../reply-draft';

describe('shouldSeedReplyDraft', () => {
  test('seeds when an AI draft exists and we have not seeded yet', () => {
    expect(shouldSeedReplyDraft('Hej, tak for din mail', false)).toBe(true);
  });

  test('does NOT re-seed once already seeded, even after the user clears the box', () => {
    // Regression: the old effect depended on `draft`, so emptying the box
    // re-fired the seed and the user could never discard the suggestion.
    expect(shouldSeedReplyDraft('Hej, tak for din mail', true)).toBe(false);
  });

  test('never seeds when there is no AI draft', () => {
    expect(shouldSeedReplyDraft(undefined, false)).toBe(false);
    expect(shouldSeedReplyDraft('', false)).toBe(false);
  });
});
