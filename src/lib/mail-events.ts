import { insertMailEvent } from './profile-store';
import type { MailEventType } from './types';
import { getPrivacyFlag } from './hooks';
import { PROFILE_MEMORY_ENABLED, invalidatePreamble } from './profile';

type RecordInput = {
  userId: string;
  eventType: MailEventType;
  providerThreadId: string;
  providerFrom: string | null;
  providerTo: string | null;
  providerSubject: string | null;
};

// Mail providers return From / To headers as either bare emails or
// "Display Name <email@host>". The allowlist matches on the bare email
// only, so normalise before storing — anything that doesn't yield a
// valid-looking email becomes null.
export function extractEmail(addr: string | null): string | null {
  if (!addr) return null;
  const angle = addr.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = addr.trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(bare)) return bare.toLowerCase();
  return null;
}

export function recordMailEvent(input: RecordInput): void {
  if (!PROFILE_MEMORY_ENABLED) return;
  if (!getPrivacyFlag('memory-enabled')) return;
  void insertMailEvent(input.userId, {
    eventType: input.eventType,
    providerThreadId: input.providerThreadId,
    // providerFrom kept raw so daily-brief shows the display name.
    // providerTo is normalised because the auto-send allowlist matches
    // on the bare email Claude provides via mail.send_reply.to.
    providerFrom: input.providerFrom,
    providerTo: extractEmail(input.providerTo),
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
