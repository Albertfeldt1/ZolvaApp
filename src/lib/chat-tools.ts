// Tools the chat exposes to the model so it can answer questions about
// the user's actual calendar and inbox. Each high-level tool fans out
// across whichever providers are connected and returns a compact text
// summary the model can reason over.
//
// Provider failures (no token, network, auth) degrade silently per
// provider — one failing source never poisons the whole call. The result
// always includes a footer line listing which sources contributed and
// which were skipped, so the model can disclose gaps to the user.

import { listEvents as listGoogleEvents, type GoogleCalendarEvent } from './google-calendar';
import {
  listCalendarEvents as listGraphEvents,
  listInboxMessages as listGraphMessages,
  getMessageBody as getGraphMessageBody,
  type GraphCalendarEvent,
  type GraphMessage,
} from './microsoft-graph';
import {
  listInboxMessages as listGmailMessages,
  getMessageBody as getGmailMessageBody,
  type GmailMessage,
} from './gmail';
import {
  listEvents as listIcloudEvents,
  type IcloudCalEvent,
} from './icloud-calendar';
import {
  listInbox as listIcloudInbox,
  getMessageBody as getIcloudMessageBody,
  type IcloudMessage,
} from './icloud-mail';

// ─── Calendar ─────────────────────────────────────────────────────────────

type CalendarSource = 'google' | 'microsoft' | 'icloud';

export type ChatCtx = {
  userId: string | null;
  hasGoogle: boolean;
  hasMicrosoft: boolean;
};

type SourceOutcome = { source: CalendarSource; ok: boolean; reason?: string };

export async function listCalendarEventsAcrossProviders(
  ctx: ChatCtx,
  from: Date,
  to: Date,
): Promise<{ text: string; isError: boolean }> {
  const lines: string[] = [];
  const outcomes: SourceOutcome[] = [];

  if (ctx.hasGoogle) {
    try {
      const events = await listGoogleEvents(from, to);
      lines.push(...events.map((e) => formatGoogleEvent(e)));
      outcomes.push({ source: 'google', ok: true });
    } catch (err) {
      outcomes.push({ source: 'google', ok: false, reason: short(err) });
    }
  }
  if (ctx.hasMicrosoft) {
    try {
      const events = await listGraphEvents(from, to);
      lines.push(...events.map((e) => formatGraphEvent(e)));
      outcomes.push({ source: 'microsoft', ok: true });
    } catch (err) {
      outcomes.push({ source: 'microsoft', ok: false, reason: short(err) });
    }
  }
  if (ctx.userId) {
    const r = await listIcloudEvents(ctx.userId, from, to);
    if (r.ok) {
      lines.push(...r.data.map((e) => formatIcloudEvent(e)));
      outcomes.push({ source: 'icloud', ok: true });
    } else if (r.error !== 'not-connected') {
      // 'not-connected' is the normal "no iCloud" case — silent.
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

function formatGoogleEvent(e: GoogleCalendarEvent): string {
  const start = e.start.dateTime ?? e.start.date ?? '';
  const end = e.end.dateTime ?? e.end.date ?? '';
  const allDay = !e.start.dateTime && !!e.start.date;
  const range = allDay ? `${start} (hele dagen)` : `${start} → ${end}`;
  const attendees = e.attendees ?? [];
  const meta: string[] = [];
  if (e.location) meta.push(`sted: ${e.location}`);
  if (attendees.length > 0) meta.push(`deltagere: ${attendees.length}`);
  return `[google:${e.id}] ${range} — ${e.summary ?? 'Uden titel'}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

function formatGraphEvent(e: GraphCalendarEvent): string {
  const range = e.isAllDay
    ? `${e.start.toISOString()} (hele dagen)`
    : `${e.start.toISOString()} → ${e.end.toISOString()}`;
  const meta: string[] = [];
  if (e.location) meta.push(`sted: ${e.location}`);
  if (e.attendeeList.length > 0) meta.push(`deltagere: ${e.attendeeList.length}`);
  return `[microsoft:${e.id}] ${range} — ${e.subject}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

function formatIcloudEvent(e: IcloudCalEvent): string {
  const range = e.allDay
    ? `${e.start.toISOString()} (hele dagen)`
    : `${e.start.toISOString()} → ${e.end.toISOString()}`;
  const meta: string[] = [];
  if (e.location) meta.push(`sted: ${e.location}`);
  if (e.calendarName) meta.push(`kalender: ${e.calendarName}`);
  return `[icloud:${e.uid}] ${range} — ${e.title}${meta.length ? ` (${meta.join(', ')})` : ''}`;
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

  if (ctx.hasGoogle) {
    try {
      const ms = await listGmailMessages(perProvider);
      ms.forEach((m) => rows.push(toGmailRow(m)));
      outcomes.push({ source: 'google', ok: true });
    } catch (err) {
      outcomes.push({ source: 'google', ok: false, reason: short(err) });
    }
  }
  if (ctx.hasMicrosoft) {
    try {
      const ms = await listGraphMessages(perProvider);
      ms.forEach((m) => rows.push(toGraphRow(m)));
      outcomes.push({ source: 'microsoft', ok: true });
    } catch (err) {
      outcomes.push({ source: 'microsoft', ok: false, reason: short(err) });
    }
  }
  if (ctx.userId) {
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
    `[${r.source}:${r.id}] ${r.receivedAt.toISOString()} — ${r.from} — "${r.subject}" — ${truncate(r.snippet, 120)}`,
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
      if (!ctx.hasGoogle) return { text: 'Gmail ikke forbundet.', isError: true };
      const b = await getGmailMessageBody(id);
      return { text: `Fra: ${b.from} <${b.fromEmail}>\nEmne: ${b.subject}\n\n${b.text}`, isError: false };
    }
    if (source === 'microsoft') {
      if (!ctx.hasMicrosoft) return { text: 'Outlook ikke forbundet.', isError: true };
      const b = await getGraphMessageBody(id);
      return { text: `Fra: ${b.from} <${b.fromEmail}>\nEmne: ${b.subject}\n\n${b.text}`, isError: false };
    }
    if (source === 'icloud') {
      if (!ctx.userId) return { text: 'Ingen bruger-session.', isError: true };
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
  return `\n— ${parts.join('. ')}.`;
}
