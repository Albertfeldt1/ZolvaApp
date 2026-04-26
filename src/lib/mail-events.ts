import { insertMailEvent } from './profile-store';
import type { MailEventType } from './types';
import { getPrivacyFlag } from './hooks';
import { PROFILE_MEMORY_ENABLED, invalidatePreamble } from './profile';

type RecordInput = {
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerSubject: string | null;
};

export function recordMailEvent(input: RecordInput): void {
  if (!PROFILE_MEMORY_ENABLED) return;
  if (!getPrivacyFlag('memory-enabled')) return;
  void insertMailEvent(input.userId, {
    eventType: input.eventType,
    providerThreadId: input.providerThreadId,
    providerFrom: input.providerFrom,
    providerSubject: input.providerSubject,
  })
    .then(() => {
      // Recent mail events are part of the preamble; invalidate so the next
      // Claude call rebuilds it. getFactsSignature wouldn't otherwise change.
      invalidatePreamble(input.userId);
    })
    .catch((err) => {
      if (__DEV__) console.warn('[mail-events] insert failed:', err);
    });
}
