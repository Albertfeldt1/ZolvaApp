// Voice-note actions → real reminders/calendar events.
//
// PapirTranscription's "Tilføj" buttons land here. Reminders go straight to
// the existing reminders domain (the caller uses useReminders().add).
// Calendar events reuse the chat's provider-agnostic writer
// (createCalendarEvent in chat-tools.ts) — google/microsoft/icloud incl.
// conflict check — so voice gets exactly the same calendar behavior as chat.
import { useAuth } from './auth';
import { createCalendarEvent, type ChatCtx, type WriteEventInput } from './chat-tools';
import { refreshCalendarNow, useIcloudConnected } from './hooks';
import { isIntegrationEffectivelyEnabled } from './integration-flags';
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

/** Create a calendar event from an extracted voice action. Throws
 * VoiceEventError with a user-facing Danish message on refusal/failure. */
export async function addVoiceEvent(
  ctx: ChatCtx,
  provider: CalendarProviderId,
  action: Extract<ExtractedAction, { kind: 'event' }>,
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
  };
  const r = await createCalendarEvent(ctx, provider, input);
  if (r.isError) {
    // createCalendarEvent's messages are model-facing but Danish and short —
    // conflict refusals in particular read fine to a human.
    throw new VoiceEventError(r.text);
  }
  refreshCalendarNow();
}
