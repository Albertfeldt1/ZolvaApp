import { insertMailEvent } from './profile-store';
import type { MailEventType } from './types';
import { getPrivacyFlag } from './hooks';
import { PROFILE_MEMORY_ENABLED, invalidatePreamble } from './profile';
import { isDemoUserId } from './demo-data';
import {
  addInteraction,
  findRosterMatch,
  listNetworkPeople,
  updateNetworkPersonFields,
  type NetworkPerson,
} from './network-store';

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
  // Netværk (M2): et SVAR er reel kontakt — log en interaktion på personen
  // og bump "sidst kontakt". Kun 'replied' ('read' er støj, 'dismissed' er
  // ikke kontakt). Fire-and-forget parallelt med insertMailEvent-kæden:
  // netværkslogning må aldrig forsinke eller vælte mail-flowet.
  if (input.eventType === 'replied') {
    logNetworkMailReply(input).catch((err) => {
      if (__DEV__) console.warn('[mail-events] network log failed:', err);
    });
  }
}

// Navnedelen af '"Display Name" <email@host>' — null når headeren kun er en
// bar adresse. Eksporteret for jest.
export function displayNameFromAddr(addr: string | null): string | null {
  if (!addr) return null;
  const angleIdx = addr.indexOf('<');
  if (angleIdx <= 0) return null;
  const name = addr.slice(0, angleIdx).trim().replace(/^["']+|["']+$/g, '').trim();
  return name || null;
}

// Afsender → person i netværket: email-eksakt match først (stærkest),
// derefter displaynavn via samme roster-match som ekstraktoren bruger.
// Eksporteret for jest.
export function matchPersonForMail(
  people: NetworkPerson[],
  providerFrom: string | null,
): NetworkPerson | null {
  const email = extractEmail(providerFrom);
  if (email) {
    const byEmail = people.find((p) => p.email?.trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const name = displayNameFromAddr(providerFrom);
  return name ? findRosterMatch(people, name, null) : null;
}

async function logNetworkMailReply(input: RecordInput): Promise<void> {
  if (isDemoUserId(input.userId)) return;
  const person = matchPersonForMail(await listNetworkPeople(input.userId), input.providerFrom);
  if (!person) return;
  await addInteraction(input.userId, person.id, {
    kind: 'mail',
    summary: input.providerSubject
      ? `Du svarede på "${input.providerSubject.slice(0, 120)}"`
      : 'Du svarede på en mail',
    // addInteractions source_ref-guard gør dobbelt-tryk idempotente.
    sourceRef: `mail:${input.providerThreadId}:replied`,
  });
  await updateNetworkPersonFields(input.userId, person.id, {}, { lastContactedAt: new Date() });
}
