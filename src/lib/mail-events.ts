import { insertMailEvent } from './profile-store';
import type { MailEventType } from './types';
import { getPrivacyFlag } from './hooks';

type RecordInput = {
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerSubject: string | null;
};

export function recordMailEvent(input: RecordInput): void {
  if (!getPrivacyFlag('memory-enabled')) return;
  void insertMailEvent(input.userId, {
    eventType: input.eventType,
    providerThreadId: input.providerThreadId,
    providerFrom: input.providerFrom,
    providerSubject: input.providerSubject,
  }).catch((err) => {
    if (__DEV__) console.warn('[mail-events] insert failed:', err);
  });
}
