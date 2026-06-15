import { FEED_ENTRY_TYPES, isFeedEntryType } from '../types';

describe('feed entry type allow-list', () => {
  test('includes the types that were previously dropped on reload', () => {
    // Regression: reviveEntry once whitelisted only 8 types, so chatReply,
    // agent_proposal and trialEnding entries vanished after an app restart.
    expect(FEED_ENTRY_TYPES).toContain('chatReply');
    expect(FEED_ENTRY_TYPES).toContain('agent_proposal');
    expect(FEED_ENTRY_TYPES).toContain('trialEnding');
  });

  test('isFeedEntryType accepts known types and rejects junk', () => {
    expect(isFeedEntryType('agent_proposal')).toBe(true);
    expect(isFeedEntryType('reminder')).toBe(true);
    expect(isFeedEntryType('nope')).toBe(false);
    expect(isFeedEntryType(undefined)).toBe(false);
    expect(isFeedEntryType(42)).toBe(false);
  });
});
