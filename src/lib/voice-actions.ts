// Voice-note actions → real reminders/calendar events.
//
// PapirTranscription's "Tilføj" buttons land here. Reminders go straight to
// the existing reminders domain (the caller uses useReminders().add).
// Calendar events reuse the chat's provider-agnostic writer
// (createCalendarEvent in chat-tools.ts) — google/microsoft/icloud incl.
// conflict check — so voice gets exactly the same calendar behavior as chat.
import { useAuth } from './auth';
import { createCalendarEvent, type CalendarConflict, type ChatCtx, type WriteEventInput } from './chat-tools';
import { refreshCalendarNow, useIcloudConnected } from './hooks';
import { isIntegrationEffectivelyEnabled } from './integration-flags';
import {
  findRosterMatch,
  insertNetworkPerson,
  listNetworkPeople,
  mergeAiIntoPerson,
  updateNetworkPersonFields,
  type AiPersonFields,
} from './network-store';
import type { ExtractedAction } from './transcribe';

export type CalendarProviderId = 'google' | 'microsoft' | 'icloud';

export type VoiceActionCtx = {
  ctx: ChatCtx;
  /** Calendar providers the user can write to right now, in preference order. */
  calendarProviders: CalendarProviderId[];
};

/** Builds the same tool context useChat builds (hooks.ts runTurn) — live
 * integration flags + OAuth grant presence — for voice-driven writes. */
export function useVoiceActionCtx(): VoiceActionCtx {
  const { user, googleAccessToken, microsoftAccessToken } = useAuth();
  const icloudConnected = useIcloudConnected(user?.id ?? '');
  const hasGoogle = !!googleAccessToken;
  const hasMicrosoft = !!microsoftAccessToken;
  const ctx: ChatCtx = {
    userId: user?.id ?? null,
    gmail: isIntegrationEffectivelyEnabled('gmail', hasGoogle),
    googleCalendar: isIntegrationEffectivelyEnabled('google-calendar', hasGoogle),
    googleDrive: isIntegrationEffectivelyEnabled('google-drive', hasGoogle),
    outlookMail: isIntegrationEffectivelyEnabled('outlook-mail', hasMicrosoft),
    outlookCalendar: isIntegrationEffectivelyEnabled('outlook-calendar', hasMicrosoft),
    onedrive: isIntegrationEffectivelyEnabled('onedrive', hasMicrosoft),
    icloud: isIntegrationEffectivelyEnabled('icloud', icloudConnected),
  };
  const calendarProviders: CalendarProviderId[] = [];
  if (ctx.googleCalendar) calendarProviders.push('google');
  if (ctx.outlookCalendar) calendarProviders.push('microsoft');
  if (ctx.icloud) calendarProviders.push('icloud');
  return { ctx, calendarProviders };
}

const DEFAULT_EVENT_MINUTES = 60;

export class VoiceEventError extends Error {}

/** The slot is taken by existing events. Not a hard failure: the caller can
 * ask the user and retry with `forceOverlap: true`. `message` is a ready
 * user-facing Danish listing of what's in the way. */
export class VoiceEventConflictError extends VoiceEventError {
  constructor(readonly conflicts: CalendarConflict[], newStart: Date) {
    super(formatConflictsForHumans(conflicts, newStart));
  }
}

const CONFLICT_SOURCE_LABELS: Record<CalendarConflict['source'], string> = {
  google: 'Google Kalender',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

function formatConflictsForHumans(conflicts: CalendarConflict[], newStart: Date): string {
  const time = (d: Date) => d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => d.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = conflicts.map((c) => {
    // Conflicts always overlap the new slot, but a long event can have
    // started on an earlier day — spell the day out when it differs.
    const prefix = c.start.toDateString() === newStart.toDateString() ? '' : `${day(c.start)} `;
    return `• "${c.title}" ${prefix}kl. ${time(c.start)}–${time(c.end)} (${CONFLICT_SOURCE_LABELS[c.source]})`;
  });
  return ['Du har allerede noget i kalenderen på det tidspunkt:', '', ...lines].join('\n');
}

/** Create a calendar event from an extracted voice action. Throws
 * VoiceEventError with a user-facing Danish message on refusal/failure —
 * VoiceEventConflictError specifically when the slot is taken, so the UI
 * can offer "opret alligevel" and retry with `forceOverlap`. */
export async function addVoiceEvent(
  ctx: ChatCtx,
  provider: CalendarProviderId,
  action: Extract<ExtractedAction, { kind: 'event' }>,
  opts?: { forceOverlap?: boolean },
): Promise<void> {
  if (!action.whenISO) {
    throw new VoiceEventError('Tidspunktet er for upræcist til en kalender-begivenhed.');
  }
  const start = new Date(action.whenISO);
  if (Number.isNaN(start.getTime())) {
    throw new VoiceEventError('Tidspunktet kunne ikke forstås. Prøv igen.');
  }
  const end = action.endISO ? new Date(action.endISO) : new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000);
  const input: WriteEventInput = {
    title: action.title,
    start,
    end: Number.isNaN(end.getTime()) || end <= start ? new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60_000) : end,
    ...(action.place ? { location: action.place } : {}),
    ...(opts?.forceOverlap ? { forceOverlap: true } : {}),
  };
  const r = await createCalendarEvent(ctx, provider, input);
  if (r.isError) {
    if (r.conflicts?.length) throw new VoiceEventConflictError(r.conflicts, start);
    // Remaining refusals (provider disconnected, API errors) are Danish and
    // short — they read fine to a human.
    throw new VoiceEventError(r.text);
  }
  refreshCalendarNow();
}

export class VoiceNetworkError extends Error {}

/** Gem en person fra en "network_person"-handling i Netværk. Samme
 * roster-match + merge-politik som ekstraktoren og save_network_person-
 * toolet, så et tryk på "Tilføj" aldrig opretter en dublet af én der
 * allerede findes. En udtrykkelig kommando ("tilføj X til mit netværk")
 * lander direkte som confirmed — pending er til baggrundsgæt. */
export async function addVoiceNetworkPerson(
  userId: string | null,
  action: Extract<ExtractedAction, { kind: 'network_person' }>,
): Promise<{ isNew: boolean }> {
  if (!userId) {
    throw new VoiceNetworkError('Du skal være logget ind for at gemme i Netværk.');
  }
  const name = action.name?.trim();
  if (!name) {
    throw new VoiceNetworkError('Personen mangler et navn. Prøv igen.');
  }
  const fields: AiPersonFields = {
    company: action.company ?? null,
    role: action.role ?? null,
    relation: action.relation ?? null,
    howWeMet: action.howWeMet ?? null,
  };
  const people = await listNetworkPeople(userId);
  const match = findRosterMatch(people, name, action.company ?? null);
  if (match) {
    const patch = mergeAiIntoPerson(match, fields);
    await updateNetworkPersonFields(userId, match.id, patch ?? {}, { lastContactedAt: new Date() });
    return { isNew: false };
  }
  await insertNetworkPerson(userId, {
    ...fields,
    name,
    status: 'confirmed',
    source: 'voice-note',
  });
  return { isNew: true };
}
