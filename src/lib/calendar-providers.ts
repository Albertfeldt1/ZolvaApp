// Lists calendars the connected accounts can write to. Used by the Settings
// "Stemmestyring" picker. Filtering is best-effort — Google G Suite policy
// overrides and shared-with-edit-delegation inconsistencies will get past
// this. Real write failures surface at Edge-Function write time.

import { tryWithRefresh } from './auth';

export type ProviderCalendar = {
  provider: 'google' | 'microsoft';
  id: string;
  name: string;
  color: string | null;
  accountEmail: string | null;
  isMainAccount: boolean;
};

type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
};

type MicrosoftCalendar = {
  id: string;
  name?: string;
  hexColor?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
  owner?: { address?: string };
};

export async function listGoogleCalendars(): Promise<ProviderCalendar[]> {
  return tryWithRefresh('google', async (token) => {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401) {
      const { ProviderAuthError } = await import('./auth');
      throw new ProviderAuthError('google', 'Google calendar list 401');
    }
    if (!res.ok) throw new Error(`Google calendarList ${res.status}`);
    const body = (await res.json()) as { items?: GoogleCalendarListEntry[] };
    return (body.items ?? [])
      .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
      .map<ProviderCalendar>((c) => ({
        provider: 'google',
        id: c.id,
        name: c.summaryOverride ?? c.summary ?? c.id,
        color: c.backgroundColor ?? null,
        accountEmail: c.primary ? c.id : null,
        isMainAccount: !!c.primary,
      }));
  });
}

export async function listMicrosoftCalendars(): Promise<ProviderCalendar[]> {
  return tryWithRefresh('microsoft', async (token) => {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      const { ProviderAuthError } = await import('./auth');
      throw new ProviderAuthError('microsoft', 'Microsoft calendars 401');
    }
    if (!res.ok) throw new Error(`Microsoft calendars ${res.status}`);
    const body = (await res.json()) as { value?: MicrosoftCalendar[] };
    return (body.value ?? [])
      .filter((c) => c.canEdit !== false)
      .map<ProviderCalendar>((c) => ({
        provider: 'microsoft',
        id: c.id,
        name: c.name ?? c.id,
        color: c.hexColor ?? null,
        accountEmail: c.owner?.address ?? null,
        isMainAccount: !!c.isDefaultCalendar,
      }));
  });
}

export async function listWritableCalendars(opts: {
  hasGoogle: boolean;
  hasMicrosoft: boolean;
}): Promise<ProviderCalendar[]> {
  const calls: Array<Promise<ProviderCalendar[]>> = [];
  if (opts.hasGoogle) calls.push(listGoogleCalendars());
  if (opts.hasMicrosoft) calls.push(listMicrosoftCalendars());
  const settled = await Promise.allSettled(calls);
  // Promise.allSettled so one provider's failure doesn't blank the picker.
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
