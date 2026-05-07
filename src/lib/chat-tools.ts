// Tools the chat exposes to the model so it can answer questions about
// the user's actual calendar and inbox. Each high-level tool fans out
// across whichever providers are connected and returns a compact text
// summary the model can reason over.
//
// Provider failures (no token, network, auth) degrade silently per
// provider - one failing source never poisons the whole call. The result
// always includes a footer line listing which sources contributed and
// which were skipped, so the model can disclose gaps to the user.

import {
  listEvents as listGooglePrimaryEvents,
  listEventsForCalendars as listGoogleEventsForCalendars,
  createEvent as createGoogleEvent,
  updateEvent as updateGoogleEvent,
  deleteEvent as deleteGoogleEvent,
  type GoogleCalendarEvent,
  type GoogleEventInput,
} from './google-calendar';
import { listGoogleCalendars, listWritableCalendars } from './calendar-providers';
import {
  listCalendarEvents as listGraphEvents,
  listInboxMessages as listGraphMessages,
  getMessageBody as getGraphMessageBody,
  createCalendarEvent as createGraphEvent,
  updateCalendarEvent as updateGraphEvent,
  deleteCalendarEvent as deleteGraphEvent,
  type GraphCalendarEvent,
  type GraphMessage,
  type GraphEventInput,
} from './microsoft-graph';
import {
  listInboxMessages as listGmailMessages,
  getMessageBody as getGmailMessageBody,
  type GmailMessage,
} from './gmail';
import {
  searchFiles as searchDriveFiles,
  getFileContent as getDriveFileContent,
  type DriveFile,
} from './google-drive';
import {
  searchFiles as searchOnedriveFiles,
  getFileContent as getOnedriveFileContent,
  type OnedriveFile,
} from './onedrive';
import {
  listEvents as listIcloudEvents,
  createEvent as createIcloudEvent,
  updateEvent as updateIcloudEvent,
  deleteEvent as deleteIcloudEvent,
  findEventByUid as findIcloudEventByUid,
  type IcloudCalEvent,
  type IcloudEventInput,
} from './icloud-calendar';
import {
  listInbox as listIcloudInbox,
  getMessageBody as getIcloudMessageBody,
  type IcloudMessage,
} from './icloud-mail';

// ─── Calendar ─────────────────────────────────────────────────────────────

type CalendarSource = 'google' | 'microsoft' | 'icloud';

// One flag per integration. Each is "effectively enabled" - the parent
// OAuth grant exists AND the user hasn't toggled this specific integration
// off. Tools gate on the specific flag they need so disabling Gmail doesn't
// disable Google Calendar / Drive on the same OAuth grant.
export type ChatCtx = {
  userId: string | null;
  gmail: boolean;
  googleCalendar: boolean;
  googleDrive: boolean;
  outlookMail: boolean;
  outlookCalendar: boolean;
  onedrive: boolean;
  icloud: boolean;
};

type SourceOutcome = { source: CalendarSource; ok: boolean; reason?: string };

// Read events from EVERY Google calendar the user has access to, not just
// `primary`. Without this fan-out, asking the chat about "my Family
// calendar" comes back empty - events.list against `primary` doesn't see
// secondary calendars even though `calendar.calendarlist.readonly` scope
// has been granted. Each event is tagged with its calendar's display name
// so the formatter can disclose which calendar it lives on. Falls back to
// primary-only when calendarList enumeration fails (older accounts pre-
// scope-grant, or transient 5xx) so the chat keeps working in degraded mode.
type GoogleEventWithCalendar = GoogleCalendarEvent & {
  calendarId?: string;
  calendarName?: string;
};

async function listGoogleEventsAcrossCalendars(
  from: Date,
  to: Date,
): Promise<GoogleEventWithCalendar[]> {
  let idToName: Map<string, string> = new Map();
  let calendarIds: string[] = [];
  try {
    const cals = await listGoogleCalendars({ writableOnly: false });
    calendarIds = cals.map((c) => c.id);
    idToName = new Map(cals.map((c) => [c.id, c.name]));
  } catch {
    // Fall through to primary-only below.
  }
  if (calendarIds.length === 0) {
    return listGooglePrimaryEvents(from, to);
  }
  const events = await listGoogleEventsForCalendars(calendarIds, from, to);
  return events.map((e) => ({ ...e, calendarName: idToName.get(e.calendarId) }));
}

export async function listCalendarEventsAcrossProviders(
  ctx: ChatCtx,
  from: Date,
  to: Date,
): Promise<{ text: string; isError: boolean }> {
  const lines: string[] = [];
  const outcomes: SourceOutcome[] = [];

  if (ctx.googleCalendar) {
    try {
      const events = await listGoogleEventsAcrossCalendars(from, to);
      lines.push(...events.map((e) => formatGoogleEvent(e)));
      outcomes.push({ source: 'google', ok: true });
    } catch (err) {
      outcomes.push({ source: 'google', ok: false, reason: short(err) });
    }
  }
  if (ctx.outlookCalendar) {
    try {
      const events = await listGraphEvents(from, to);
      lines.push(...events.map((e) => formatGraphEvent(e)));
      outcomes.push({ source: 'microsoft', ok: true });
    } catch (err) {
      outcomes.push({ source: 'microsoft', ok: false, reason: short(err) });
    }
  }
  if (ctx.userId && ctx.icloud) {
    const r = await listIcloudEvents(ctx.userId, from, to);
    if (r.ok) {
      lines.push(...r.data.map((e) => formatIcloudEvent(e)));
      outcomes.push({ source: 'icloud', ok: true });
    } else if (r.error !== 'not-connected') {
      // 'not-connected' is the normal "no iCloud" case - silent.
      outcomes.push({ source: 'icloud', ok: false, reason: r.error });
    }
  }

  // Sort chronologically.
  lines.sort();

  if (lines.length === 0) {
    const skipped = outcomes.filter((o) => !o.ok);
    if (skipped.length > 0) {
      return {
        text: `Ingen begivenheder fundet. Mislykkedes: ${skipped.map((o) => `${o.source}=${o.reason ?? 'fejl'}`).join(', ')}.`,
        isError: false,
      };
    }
    return { text: 'Ingen begivenheder i tidsrummet.', isError: false };
  }

  const header = `${lines.length} begivenhed${lines.length === 1 ? '' : 'er'} mellem ${shortDate(from)} og ${shortDate(to)}:`;
  const footer = formatOutcomesFooter(outcomes);
  return { text: [header, '', ...lines, footer].filter(Boolean).join('\n'), isError: false };
}

// Enumerate every connected calendar the user can WRITE to, across providers.
// The model uses this to both answer "which calendars do I have?" and pick a
// specific sub-calendar when the user names one ("læg det i Family"). We
// filter to writable here because the tool's primary purpose is powering
// create_calendar_event - a read-only / subscribed calendar (accessRole
// "reader") returns 404 on POST and we'd be feeding the model a foot-gun.
// Each row carries the provider:id pair the model passes back as
// `calendar_id` on writes.
export async function listCalendarsAcrossProviders(
  ctx: ChatCtx,
): Promise<{ text: string; isError: boolean }> {
  const cals = await listWritableCalendars({
    hasGoogle: ctx.googleCalendar,
    hasMicrosoft: ctx.outlookCalendar,
    hasIcloud: !!ctx.userId && ctx.icloud,
    userId: ctx.userId ?? '',
  });
  if (cals.length === 0) {
    return { text: 'Ingen kalendere fundet på de forbundne konti.', isError: false };
  }
  // Explicit field format - avoids the model accidentally including
  // delimiters when it grabs the calendar_id. Each calendar gets a block:
  //   navn: oioioi
  //   provider: google
  //   calendar_id: abc@group.calendar.google.com
  //   konto: foo@gmail.com
  //   farve: #fbe983
  const blocks = cals.map((c) => {
    const fields = [
      `navn: ${c.name}`,
      `provider: ${c.provider}`,
      `calendar_id: ${c.id}`,
    ];
    if (c.isMainAccount) fields.push('rolle: hovedkalender');
    if (c.accountEmail) fields.push(`konto: ${c.accountEmail}`);
    if (c.color) fields.push(`farve: ${c.color}`);
    return fields.join('\n');
  });
  const header = `${cals.length} kalender${cals.length === 1 ? '' : 'e'} (alle skrivbare):`;
  const footer =
    'Når brugeren udtrykkeligt nævner en specifik kalender, send dens calendar_id ' +
    'PRÆCIS som det står i listen ovenfor (ingen brackets, ingen citationstegn) som ' +
    '`calendar_id`-felt på create_calendar_event. Udelad `calendar_id` for at lægge ' +
    'i provider-default (Google primary / Outlook default / iCloud først).';
  return { text: [header, '', blocks.join('\n\n'), '', footer].join('\n'), isError: false };
}

function formatGoogleEvent(e: GoogleEventWithCalendar): string {
  const start = e.start.dateTime ?? e.start.date ?? '';
  const end = e.end.dateTime ?? e.end.date ?? '';
  const allDay = !e.start.dateTime && !!e.start.date;
  const range = allDay ? `${start} (hele dagen)` : `${start} → ${end}`;
  const attendees = e.attendees ?? [];
  const meta: string[] = [];
  if (e.calendarName) meta.push(`kalender: ${e.calendarName}`);
  if (e.location) meta.push(`sted: ${e.location}`);
  if (attendees.length > 0) meta.push(`deltagere: ${attendees.length}`);
  return `[google:${e.id}] ${range} - ${e.summary ?? 'Uden titel'}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

function formatGraphEvent(e: GraphCalendarEvent): string {
  const range = e.isAllDay
    ? `${e.start.toISOString()} (hele dagen)`
    : `${e.start.toISOString()} → ${e.end.toISOString()}`;
  const meta: string[] = [];
  if (e.location) meta.push(`sted: ${e.location}`);
  if (e.attendeeList.length > 0) meta.push(`deltagere: ${e.attendeeList.length}`);
  return `[microsoft:${e.id}] ${range} - ${e.subject}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

function formatIcloudEvent(e: IcloudCalEvent): string {
  const range = e.allDay
    ? `${e.start.toISOString()} (hele dagen)`
    : `${e.start.toISOString()} → ${e.end.toISOString()}`;
  const meta: string[] = [];
  if (e.location) meta.push(`sted: ${e.location}`);
  if (e.calendarName) meta.push(`kalender: ${e.calendarName}`);
  return `[icloud:${e.uid}] ${range} - ${e.title}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

// ─── Mail ─────────────────────────────────────────────────────────────────

const MAIL_PER_PROVIDER_DEFAULT = 8;
const MAIL_PER_PROVIDER_MAX = 20;

export async function listRecentMailAcrossProviders(
  ctx: ChatCtx,
  limit: number,
): Promise<{ text: string; isError: boolean }> {
  const perProvider = Math.max(1, Math.min(limit, MAIL_PER_PROVIDER_MAX));
  type Row = { source: CalendarSource; id: string; from: string; subject: string; receivedAt: Date; snippet: string };
  const rows: Row[] = [];
  const outcomes: SourceOutcome[] = [];

  if (ctx.gmail) {
    try {
      const ms = await listGmailMessages(perProvider);
      ms.forEach((m) => rows.push(toGmailRow(m)));
      outcomes.push({ source: 'google', ok: true });
    } catch (err) {
      outcomes.push({ source: 'google', ok: false, reason: short(err) });
    }
  }
  if (ctx.outlookMail) {
    try {
      const ms = await listGraphMessages(perProvider);
      ms.forEach((m) => rows.push(toGraphRow(m)));
      outcomes.push({ source: 'microsoft', ok: true });
    } catch (err) {
      outcomes.push({ source: 'microsoft', ok: false, reason: short(err) });
    }
  }
  if (ctx.userId && ctx.icloud) {
    const r = await listIcloudInbox(ctx.userId, perProvider);
    if (r.ok) {
      r.data.forEach((m) => rows.push(toIcloudRow(m)));
      outcomes.push({ source: 'icloud', ok: true });
    } else if (r.error !== 'not-connected') {
      outcomes.push({ source: 'icloud', ok: false, reason: r.error });
    }
  }

  rows.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const trimmed = rows.slice(0, limit);

  if (trimmed.length === 0) {
    const skipped = outcomes.filter((o) => !o.ok);
    if (skipped.length > 0) {
      return {
        text: `Ingen mails fundet. Mislykkedes: ${skipped.map((o) => `${o.source}=${o.reason ?? 'fejl'}`).join(', ')}.`,
        isError: false,
      };
    }
    return { text: 'Ingen mails i postkasserne.', isError: false };
  }

  const lines = trimmed.map((r) =>
    `[${r.source}:${r.id}] ${r.receivedAt.toISOString()} - ${r.from} - "${r.subject}" - ${truncate(r.snippet, 120)}`,
  );
  const header = `${trimmed.length} af de nyeste mails:`;
  const footer = formatOutcomesFooter(outcomes);
  return { text: [header, '', ...lines, footer].filter(Boolean).join('\n'), isError: false };
}

function toGmailRow(m: GmailMessage) {
  return {
    source: 'google' as const,
    id: m.id,
    from: m.from,
    subject: m.subject,
    receivedAt: m.date,
    snippet: m.snippet,
  };
}
function toGraphRow(m: GraphMessage) {
  return {
    source: 'microsoft' as const,
    id: m.id,
    from: m.from,
    subject: m.subject,
    receivedAt: m.receivedAt,
    snippet: m.preview,
  };
}
function toIcloudRow(m: IcloudMessage) {
  return {
    source: 'icloud' as const,
    id: String(m.uid),
    from: m.from,
    subject: m.subject,
    receivedAt: m.date,
    snippet: m.preview,
  };
}

export async function readMailBody(
  ctx: ChatCtx,
  unifiedId: string,
): Promise<{ text: string; isError: boolean }> {
  const idx = unifiedId.indexOf(':');
  if (idx < 1) return { text: 'Ugyldigt ID. Brug fx "google:abc" eller "icloud:42".', isError: true };
  const source = unifiedId.slice(0, idx);
  const id = unifiedId.slice(idx + 1);
  if (!id) return { text: 'Mangler mail-ID.', isError: true };

  try {
    if (source === 'google') {
      if (!ctx.gmail) return { text: 'Gmail ikke forbundet.', isError: true };
      const b = await getGmailMessageBody(id);
      return { text: `Fra: ${b.from} <${b.fromEmail}>\nEmne: ${b.subject}\n\n${b.text}`, isError: false };
    }
    if (source === 'microsoft') {
      if (!ctx.outlookMail) return { text: 'Outlook ikke forbundet.', isError: true };
      const b = await getGraphMessageBody(id);
      return { text: `Fra: ${b.from} <${b.fromEmail}>\nEmne: ${b.subject}\n\n${b.text}`, isError: false };
    }
    if (source === 'icloud') {
      if (!ctx.userId || !ctx.icloud) return { text: 'iCloud ikke forbundet.', isError: true };
      const uid = Number(id);
      if (!Number.isFinite(uid)) return { text: 'iCloud-ID skal være et tal.', isError: true };
      const r = await getIcloudMessageBody(ctx.userId, uid);
      if (!r.ok) return { text: `iCloud fejl: ${r.error}`, isError: true };
      return {
        text: `Fra: ${r.data.from} <${r.data.fromEmail}>\nEmne: ${r.data.subject}\n\n${r.data.body}`,
        isError: false,
      };
    }
    return { text: `Ukendt mail-kilde "${source}". Forventer google/microsoft/icloud.`, isError: true };
  } catch (err) {
    return { text: `Kunne ikke hente mailen: ${short(err)}`, isError: true };
  }
}

// ─── Drive ────────────────────────────────────────────────────────────────
//
// Google Drive search + read. Read-only: scope is drive.readonly. Search
// matches both file content (fullText) and filenames; read returns the
// extracted text body for Google Docs/Sheets/Slides and plain-text files.
// Other MIME types are refused at read time so the model gets a clear
// "can't extract" rather than a binary blob.

export async function searchDriveFilesTool(
  ctx: ChatCtx,
  query: string,
  limit: number,
): Promise<{ text: string; isError: boolean }> {
  if (!ctx.googleDrive) return { text: 'Google Drive ikke forbundet.', isError: true };
  const trimmed = query.trim();
  if (!trimmed) return { text: 'Tom søgning. Angiv mindst ét søgeord.', isError: true };
  try {
    const hits = await searchDriveFiles(trimmed, limit);
    if (hits.length === 0) {
      return { text: `Ingen filer matcher "${trimmed}" i Drive.`, isError: false };
    }
    const lines = hits.map((f) => formatDriveHit(f));
    const header = `${hits.length} fil(er) matcher "${trimmed}":`;
    return { text: [header, '', ...lines].join('\n'), isError: false };
  } catch (err) {
    return { text: `Google Drive afviste søgningen: ${short(err)}`, isError: true };
  }
}

export async function readDriveFile(
  ctx: ChatCtx,
  id: string,
): Promise<{ text: string; isError: boolean }> {
  if (!ctx.googleDrive) return { text: 'Google Drive ikke forbundet.', isError: true };
  // Be permissive: model sometimes echoes the full "drive:abc" unified ID.
  const cleanId = id.startsWith('drive:') ? id.slice(6) : id;
  if (!cleanId) return { text: 'Mangler fil-ID.', isError: true };
  try {
    const f = await getDriveFileContent(cleanId);
    const header = `Filnavn: ${f.name}\nLink: ${f.webViewLink}\n`;
    return { text: `${header}\n${f.text}`, isError: false };
  } catch (err) {
    return { text: `Kunne ikke læse filen: ${short(err)}`, isError: true };
  }
}

function formatDriveHit(f: DriveFile): string {
  const kind = mimeLabel(f.mimeType);
  const modified = shortDate(f.modifiedTime);
  const owner = f.ownerEmail ? ` - ejer: ${f.ownerEmail}` : '';
  return `[drive:${f.id}] ${kind} - "${f.name}" - ændret ${modified}${owner} - ${f.webViewLink}`;
}

function mimeLabel(mime: string): string {
  if (mime === 'application/vnd.google-apps.document') return 'Doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'Sheet';
  if (mime === 'application/vnd.google-apps.presentation') return 'Slides';
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'Word';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'Excel';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PowerPoint';
  if (mime.startsWith('text/')) return mime.slice(5);
  if (mime === 'application/json') return 'JSON';
  return mime;
}

// ─── OneDrive ─────────────────────────────────────────────────────────────
//
// Microsoft Graph search + read for the user's personal OneDrive. Same
// shape as Drive - search by query, then read by ID. Read is restricted
// to text-shaped MIME types; Office formats are refused at read time.

export async function searchOnedriveFilesTool(
  ctx: ChatCtx,
  query: string,
  limit: number,
): Promise<{ text: string; isError: boolean }> {
  if (!ctx.onedrive) return { text: 'OneDrive ikke forbundet.', isError: true };
  const trimmed = query.trim();
  if (!trimmed) return { text: 'Tom søgning. Angiv mindst ét søgeord.', isError: true };
  try {
    const hits = await searchOnedriveFiles(trimmed, limit);
    if (hits.length === 0) {
      return { text: `Ingen filer matcher "${trimmed}" i OneDrive.`, isError: false };
    }
    const lines = hits.map((f) => formatOnedriveHit(f));
    const header = `${hits.length} fil(er) matcher "${trimmed}":`;
    return { text: [header, '', ...lines].join('\n'), isError: false };
  } catch (err) {
    return { text: `OneDrive afviste søgningen: ${short(err)}`, isError: true };
  }
}

export async function readOnedriveFile(
  ctx: ChatCtx,
  id: string,
): Promise<{ text: string; isError: boolean }> {
  if (!ctx.onedrive) return { text: 'OneDrive ikke forbundet.', isError: true };
  // Be permissive: model sometimes echoes the full "onedrive:abc" unified ID.
  const cleanId = id.startsWith('onedrive:') ? id.slice(9) : id;
  if (!cleanId) return { text: 'Mangler fil-ID.', isError: true };
  try {
    const f = await getOnedriveFileContent(cleanId);
    const header = `Filnavn: ${f.name}\nLink: ${f.webUrl}\n`;
    return { text: `${header}\n${f.text}`, isError: false };
  } catch (err) {
    return { text: `Kunne ikke læse filen: ${short(err)}`, isError: true };
  }
}

function formatOnedriveHit(f: OnedriveFile): string {
  const kind = mimeLabel(f.mimeType);
  const modified = shortDate(f.modifiedTime);
  const owner = f.ownerEmail ? ` - ejer: ${f.ownerEmail}` : '';
  return `[onedrive:${f.id}] ${kind} - "${f.name}" - ændret ${modified}${owner} - ${f.webUrl}`;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120);
}

function shortDate(d: Date): string {
  return d.toISOString().slice(0, 16);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function formatOutcomesFooter(outcomes: SourceOutcome[]): string {
  if (outcomes.length === 0) return '';
  const ok = outcomes.filter((o) => o.ok).map((o) => o.source);
  const failed = outcomes.filter((o) => !o.ok).map((o) => `${o.source}=${o.reason ?? 'fejl'}`);
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`Kilder OK: ${ok.join(', ')}`);
  if (failed.length > 0) parts.push(`Mislykkedes: ${failed.join(', ')}`);
  return `\n- ${parts.join('. ')}.`;
}

// ─── Calendar writes ──────────────────────────────────────────────────────
//
// Each write tool:
//   - Routes by provider prefix on the unified ID, OR by an explicit
//     `provider` field for create.
//   - Returns a Danish status string the model paraphrases for the user.
//   - Disambiguates "no provider connected" vs "provider rejected" so the
//     model can suggest reconnecting if relevant.
//
// Calendar writes route by provider prefix on the unified ID (update/delete)
// or by an explicit `provider` field (create). All three providers - Google,
// Microsoft, iCloud - support full create/update/delete. Attendees are sent
// for Google and Microsoft; iCloud drops them (no iTIP support yet).

export type WriteEventInput = {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[]; // emails (Microsoft only - iCloud invitation flow is separate)
  // When true, skip the cross-calendar conflict check. The model only sets this
  // after the user has been shown a conflict and explicitly chose to proceed.
  forceOverlap?: boolean;
  // Target a specific sub-calendar within the chosen provider:
  //   - google:    calendar id (eg. "primary" or "abcdef@group.calendar.google.com")
  //   - microsoft: calendar id from /me/calendars
  //   - icloud:    full CalDAV calendar URL
  // Omit to write to the provider default (Google primary, Microsoft default
  // mailbox calendar, iCloud first calendar).
  calendarId?: string;
};

// Scan all connected calendars for timed events that overlap [start, end).
// All-day events are ignored - they're typically birthdays / OOO markers and
// shouldn't block creating a real meeting on the same day. iCloud failures
// fall back to "no conflicts found there" rather than blocking the create:
// the user explicitly asked for the event, and a flaky CalDAV reachability
// problem is the wrong reason to refuse.
type Conflict = {
  source: CalendarSource;
  title: string;
  start: Date;
  end: Date;
};

async function findConflicts(
  ctx: ChatCtx,
  start: Date,
  end: Date,
): Promise<Conflict[]> {
  const out: Conflict[] = [];
  const overlaps = (s: Date, e: Date) =>
    s.getTime() < end.getTime() && e.getTime() > start.getTime();

  if (ctx.googleCalendar) {
    try {
      const events = await listGoogleEventsAcrossCalendars(start, end);
      for (const e of events) {
        const allDay = !e.start.dateTime && !!e.start.date;
        if (allDay) continue;
        const s = e.start.dateTime ? new Date(e.start.dateTime) : null;
        const eEnd = e.end.dateTime ? new Date(e.end.dateTime) : null;
        if (!s || !eEnd) continue;
        if (overlaps(s, eEnd)) out.push({ source: 'google', title: e.summary ?? 'Uden titel', start: s, end: eEnd });
      }
    } catch {
      // Treat read failure as "no conflict found here" - see comment above.
    }
  }
  if (ctx.outlookCalendar) {
    try {
      const events = await listGraphEvents(start, end);
      for (const e of events) {
        if (e.isAllDay) continue;
        if (overlaps(e.start, e.end)) out.push({ source: 'microsoft', title: e.subject, start: e.start, end: e.end });
      }
    } catch {
      // ignore
    }
  }
  if (ctx.userId && ctx.icloud) {
    const r = await listIcloudEvents(ctx.userId, start, end);
    if (r.ok) {
      for (const e of r.data) {
        if (e.allDay) continue;
        if (overlaps(e.start, e.end)) out.push({ source: 'icloud', title: e.title, start: e.start, end: e.end });
      }
    }
  }
  return out;
}

function formatConflictsMessage(conflicts: Conflict[], start: Date, end: Date): string {
  const lines = conflicts.map((c) => `- [${c.source}] "${c.title}" (${c.start.toISOString()} → ${c.end.toISOString()})`);
  return [
    `KONFLIKT: Den nye begivenhed (${start.toISOString()} → ${end.toISOString()}) overlapper med eksisterende begivenheder:`,
    ...lines,
    'Begivenheden blev IKKE oprettet. Fortæl brugeren hvilke begivenheder der ligger i samme tidsrum og spørg om de vil oprette alligevel eller vælge et andet tidspunkt. Hvis brugeren bekræfter at oprette alligevel, kald create_calendar_event igen med præcis samme felter PLUS `force_overlap: true`.',
  ].join('\n');
}

// Models routinely confuse calendar NAMES with calendar IDs - the chat tool
// gets `calendar_id: "oioioi"` (the name) when it should be
// `abc@group.calendar.google.com` (the actual id). Rather than fail with a
// 404, accept either and resolve the name to an id by enumerating the
// user's calendars. Returns the original string on any miss so the
// provider's own error path still surfaces a real "not found" when it's
// genuinely wrong.
async function resolveGoogleCalendarId(idOrName: string): Promise<string> {
  if (idOrName === 'primary' || idOrName.includes('@')) return idOrName;
  try {
    const cals = await listGoogleCalendars({ writableOnly: false });
    const byId = cals.find((c) => c.id === idOrName);
    if (byId) return byId.id;
    const lower = idOrName.toLowerCase();
    const byName = cals.find((c) => c.name.toLowerCase() === lower);
    if (byName) return byName.id;
  } catch {
    // Fall through - let the provider 404 with the original.
  }
  return idOrName;
}

async function resolveMicrosoftCalendarId(idOrName: string): Promise<string> {
  // Microsoft calendar IDs are long opaque strings starting with "AAMk" or
  // similar. A short human name is almost certainly a display name.
  if (idOrName.length > 50) return idOrName;
  try {
    const { listMicrosoftCalendars } = await import('./calendar-providers');
    const cals = await listMicrosoftCalendars({ writableOnly: false });
    const byId = cals.find((c) => c.id === idOrName);
    if (byId) return byId.id;
    const lower = idOrName.toLowerCase();
    const byName = cals.find((c) => c.name.toLowerCase() === lower);
    if (byName) return byName.id;
  } catch {
    // Fall through.
  }
  return idOrName;
}

export async function createCalendarEvent(
  ctx: ChatCtx,
  provider: string,
  input: WriteEventInput,
): Promise<{ text: string; isError: boolean }> {
  if (!input.allDay && !input.forceOverlap) {
    const conflicts = await findConflicts(ctx, input.start, input.end);
    if (conflicts.length > 0) {
      return { text: formatConflictsMessage(conflicts, input.start, input.end), isError: true };
    }
  }
  // Resolve human names to provider-specific ids so the model can sloppily
  // pass the calendar's display name and we still hit the right calendar.
  const resolvedInput: WriteEventInput = { ...input };
  if (input.calendarId && provider === 'google') {
    resolvedInput.calendarId = await resolveGoogleCalendarId(input.calendarId);
  } else if (input.calendarId && provider === 'microsoft') {
    resolvedInput.calendarId = await resolveMicrosoftCalendarId(input.calendarId);
  }
  if (provider === 'google') {
    if (!ctx.googleCalendar) return { text: 'Google Kalender ikke forbundet.', isError: true };
    try {
      const r = await createGoogleEvent(toGoogleInput(resolvedInput));
      return { text: `Oprettet [google:${r.id}] "${resolvedInput.title}" ${rangeText(resolvedInput)}.`, isError: false };
    } catch (err) {
      const calId = resolvedInput.calendarId ?? 'primary';
      // Use a longer truncation than short() so the model sees Google's
      // actual JSON error body - invaluable when diagnosing 404 vs 403 vs
      // a malformed id, all of which surface as different text in the body.
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      return {
        text: `Google Kalender afviste oprettelsen (calendar_id="${calId}"): ${msg}`,
        isError: true,
      };
    }
  }
  if (provider === 'microsoft') {
    if (!ctx.outlookCalendar) return { text: 'Outlook ikke forbundet.', isError: true };
    try {
      const r = await createGraphEvent(toGraphInput(resolvedInput));
      return { text: `Oprettet [microsoft:${r.id}] "${resolvedInput.title}" ${rangeText(resolvedInput)}.`, isError: false };
    } catch (err) {
      return { text: `Outlook afviste oprettelsen: ${short(err)}`, isError: true };
    }
  }
  if (provider === 'icloud') {
    if (!ctx.userId) return { text: 'Ingen bruger-session.', isError: true };
    const icloudInput: IcloudEventInput & { calendarUrl?: string } = {
      ...toIcloudInput(resolvedInput),
      calendarUrl: resolvedInput.calendarId,
    };
    const r = await createIcloudEvent(ctx.userId, icloudInput);
    if (!r.ok) return { text: `iCloud afviste oprettelsen: ${r.error}`, isError: true };
    return { text: `Oprettet [icloud:${r.data.uid}] "${resolvedInput.title}" ${rangeText(resolvedInput)}.`, isError: false };
  }
  return { text: `Ukendt provider "${provider}". Brug google, microsoft eller icloud.`, isError: true };
}

export async function updateCalendarEvent(
  ctx: ChatCtx,
  unifiedId: string,
  patch: Partial<WriteEventInput>,
): Promise<{ text: string; isError: boolean }> {
  const idx = unifiedId.indexOf(':');
  if (idx < 1) return { text: 'Ugyldigt ID.', isError: true };
  const source = unifiedId.slice(0, idx);
  const id = unifiedId.slice(idx + 1);
  if (!id) return { text: 'Mangler event-ID.', isError: true };

  if (source === 'google') {
    if (!ctx.googleCalendar) return { text: 'Google Kalender ikke forbundet.', isError: true };
    try {
      await updateGoogleEvent(id, toGooglePartial(patch));
      return { text: `Opdateret [google:${id}].`, isError: false };
    } catch (err) {
      return { text: `Google Kalender afviste opdateringen: ${short(err)}`, isError: true };
    }
  }
  if (source === 'microsoft') {
    if (!ctx.outlookCalendar) return { text: 'Outlook ikke forbundet.', isError: true };
    try {
      await updateGraphEvent(id, toGraphPartial(patch));
      return { text: `Opdateret [microsoft:${id}].`, isError: false };
    } catch (err) {
      return { text: `Outlook afviste opdateringen: ${short(err)}`, isError: true };
    }
  }
  if (source === 'icloud') {
    if (!ctx.userId) return { text: 'Ingen bruger-session.', isError: true };
    const found = await findIcloudEventByUid(ctx.userId, id);
    if (!found.ok) return { text: `iCloud opslag fejlede: ${found.error}`, isError: true };
    if (!found.data) return { text: `Fandt ikke iCloud-begivenhed med UID ${id}.`, isError: true };
    // Merge: existing fields stay, patched fields override.
    const merged: IcloudEventInput & { uid: string } = {
      uid: found.data.uid,
      title: patch.title ?? found.data.title,
      start: patch.start ?? found.data.start,
      end: patch.end ?? found.data.end,
      allDay: patch.allDay ?? found.data.allDay,
      location: patch.location ?? found.data.location,
      description: patch.description ?? found.data.description,
    };
    const r = await updateIcloudEvent(ctx.userId, found.data.eventUrl, merged);
    if (!r.ok) return { text: `iCloud afviste opdateringen: ${r.error}`, isError: true };
    return { text: `Opdateret [icloud:${id}].`, isError: false };
  }
  return { text: `Ukendt provider "${source}".`, isError: true };
}

export async function deleteCalendarEvent(
  ctx: ChatCtx,
  unifiedId: string,
): Promise<{ text: string; isError: boolean }> {
  const idx = unifiedId.indexOf(':');
  if (idx < 1) return { text: 'Ugyldigt ID.', isError: true };
  const source = unifiedId.slice(0, idx);
  const id = unifiedId.slice(idx + 1);
  if (!id) return { text: 'Mangler event-ID.', isError: true };

  if (source === 'google') {
    if (!ctx.googleCalendar) return { text: 'Google Kalender ikke forbundet.', isError: true };
    try {
      await deleteGoogleEvent(id);
      return { text: `Slettet [google:${id}].`, isError: false };
    } catch (err) {
      return { text: `Google Kalender afviste sletningen: ${short(err)}`, isError: true };
    }
  }
  if (source === 'microsoft') {
    if (!ctx.outlookCalendar) return { text: 'Outlook ikke forbundet.', isError: true };
    try {
      await deleteGraphEvent(id);
      return { text: `Slettet [microsoft:${id}].`, isError: false };
    } catch (err) {
      return { text: `Outlook afviste sletningen: ${short(err)}`, isError: true };
    }
  }
  if (source === 'icloud') {
    if (!ctx.userId) return { text: 'Ingen bruger-session.', isError: true };
    const found = await findIcloudEventByUid(ctx.userId, id);
    if (!found.ok) return { text: `iCloud opslag fejlede: ${found.error}`, isError: true };
    if (!found.data) return { text: `Fandt ikke iCloud-begivenhed med UID ${id}.`, isError: true };
    const r = await deleteIcloudEvent(ctx.userId, found.data.eventUrl);
    if (!r.ok) return { text: `iCloud afviste sletningen: ${r.error}`, isError: true };
    return { text: `Slettet [icloud:${id}].`, isError: false };
  }
  return { text: `Ukendt provider "${source}".`, isError: true };
}

function toGoogleInput(input: WriteEventInput): GoogleEventInput {
  return {
    title: input.title,
    start: input.start,
    end: input.end,
    isAllDay: input.allDay,
    location: input.location,
    description: input.description,
    attendees: input.attendees?.map((email) => ({ email })),
    calendarId: input.calendarId,
  };
}

function toGooglePartial(patch: Partial<WriteEventInput>): Partial<GoogleEventInput> {
  const out: Partial<GoogleEventInput> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.start !== undefined) out.start = patch.start;
  if (patch.end !== undefined) out.end = patch.end;
  if (patch.allDay !== undefined) out.isAllDay = patch.allDay;
  if (patch.location !== undefined) out.location = patch.location;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.attendees !== undefined) {
    out.attendees = patch.attendees.map((email) => ({ email }));
  }
  return out;
}

function toGraphInput(input: WriteEventInput): GraphEventInput {
  return {
    title: input.title,
    start: input.start,
    end: input.end,
    isAllDay: input.allDay,
    location: input.location,
    description: input.description,
    attendees: input.attendees?.map((email) => ({ email })),
    calendarId: input.calendarId,
  };
}

function toGraphPartial(patch: Partial<WriteEventInput>): Partial<GraphEventInput> {
  const out: Partial<GraphEventInput> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.start !== undefined) out.start = patch.start;
  if (patch.end !== undefined) out.end = patch.end;
  if (patch.allDay !== undefined) out.isAllDay = patch.allDay;
  if (patch.location !== undefined) out.location = patch.location;
  if (patch.description !== undefined) out.description = patch.description;
  if (patch.attendees !== undefined) {
    out.attendees = patch.attendees.map((email) => ({ email }));
  }
  return out;
}

function toIcloudInput(input: WriteEventInput): IcloudEventInput {
  return {
    title: input.title,
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    location: input.location,
    description: input.description,
    // attendees intentionally dropped - iCloud's CalDAV invitation flow needs
    // ATTENDEE/ORGANIZER properties + iTIP/REQUEST handling that we don't
    // support. The model is told to mention this when relevant.
  };
}

function rangeText(input: WriteEventInput): string {
  if (input.allDay) return `${input.start.toISOString().slice(0, 10)} (hele dagen)`;
  return `${input.start.toISOString()} → ${input.end.toISOString()}`;
}
