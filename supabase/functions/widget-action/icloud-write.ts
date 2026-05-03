// supabase/functions/widget-action/icloud-write.ts
//
// CalDAV write path for the voice action. Reads encrypted creds from
// user_icloud_calendar_creds (written by icloud-creds-link), decrypts via
// the pgcrypto helper using ICLOUD_CREDS_ENCRYPTION_KEY, then PUTs an
// iCalendar VEVENT against the user's chosen calendar URL.
//
// Mirrors src/lib/icloud-calendar.ts's createEvent on the client side; the
// helpers (VEVENT generation, UID, escaping) are duplicated rather than
// imported because client + edge are different runtimes (Hermes vs Deno).

import type { IcloudCredsBlob } from '../_shared/icloud-creds.ts';

export type IcloudWriteOutcome =
  | { ok: true; eventUrl: string; uid: string }
  | { ok: false; errorClass: 'oauth_invalid' }              // creds row missing or auth-failed
  | { ok: false; errorClass: 'permission_denied'; calendarName: string }
  | { ok: false; errorClass: 'provider_5xx' };

export async function writeIcloudEvent(args: {
  creds: IcloudCredsBlob;
  calendarUrl: string;        // user_profiles.work/personal_calendar_id when provider === 'icloud'
  title: string;
  startIso: string;
  endIso: string;
}): Promise<IcloudWriteOutcome> {
  const auth = basicAuth(args.creds.email, args.creds.password);
  if (!auth) return { ok: false, errorClass: 'oauth_invalid' };

  const uid = generateUid();
  const ics = buildVeventIcs({
    uid,
    title: args.title,
    start: new Date(args.startIso),
    end: new Date(args.endIso),
  });
  const eventUrl = `${args.calendarUrl.replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`;

  // If-None-Match: * → reject if a resource already exists at this URL.
  // Voice path won't retry on UID collision (probability is astronomical
  // with crypto.randomUUID); surface as provider_5xx.
  const res = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      authorization: auth,
      'content-type': 'text/calendar; charset=utf-8',
      'if-none-match': '*',
    },
    body: ics,
  });

  if (res.status === 401) return { ok: false, errorClass: 'oauth_invalid' };
  if (res.status === 403) {
    // For iCloud the only useful name is the URL slug; surface that.
    const slug = args.calendarUrl.replace(/\/$/, '').split('/').pop() ?? args.calendarUrl;
    return { ok: false, errorClass: 'permission_denied', calendarName: decodeURIComponent(slug) };
  }
  if (res.status >= 500) return { ok: false, errorClass: 'provider_5xx' };
  if (!res.ok) return { ok: false, errorClass: 'provider_5xx' };

  return { ok: true, eventUrl, uid };
}

function basicAuth(email: string, password: string): string | null {
  try {
    return 'Basic ' + btoa(`${email}:${password}`);
  } catch {
    return null;
  }
}

function generateUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `${c.randomUUID()}@zolva.io`;
  const rand = Math.random().toString(36).slice(2);
  return `${Date.now()}-${rand}@zolva.io`;
}

type VeventInput = { uid: string; title: string; start: Date; end: Date };

function buildVeventIcs(input: VeventInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zolva//Zolva 1.0//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(input.uid)}`,
    `DTSTAMP:${fmtUtcDateTime(new Date())}`,
    `DTSTART:${fmtUtcDateTime(input.start)}`,
    `DTEND:${fmtUtcDateTime(input.end)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function fmtUtcDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}
