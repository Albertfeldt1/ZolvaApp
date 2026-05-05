// supabase/functions/_shared/backfill-providers/icloud.ts
//
// Server-side iCloud IMAP reader for the onboarding mail backfill.
// Mirrors the role of gmail.ts / microsoft.ts: returns up to 50 recent
// CandidateMessages from the user's INBOX so the shared Claude pipeline
// can extract facts.
//
// Auth: app-specific password stored encrypted in user_icloud_calendar_creds
// (the same row used for CalDAV). No OAuth refresh path.
//
// Read posture: SELECT readOnly so opening the inbox does not flip \Seen
// flags upstream. Same posture imap-proxy uses.

import type { ImapFlow } from 'npm:imapflow@1.3.2';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { CandidateMessage } from '../onboarding-backfill.ts';
import { isAutomatedSender } from '../onboarding-backfill.ts';
import { loadIcloudCreds } from '../icloud-creds.ts';

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;

let _ImapFlowCtor: typeof ImapFlow | null = null;
async function getImapFlow(): Promise<typeof ImapFlow> {
  if (_ImapFlowCtor) return _ImapFlowCtor;
  const mod = await import('npm:imapflow@1.3.2');
  _ImapFlowCtor = mod.ImapFlow;
  return _ImapFlowCtor;
}

export async function fetchIcloudCandidates(
  client: SupabaseClient,
  userId: string,
  encryptionKey: string,
  userOwnEmail: string,
  maxFetch = 200,
  keep = 50,
): Promise<CandidateMessage[]> {
  const creds = await loadIcloudCreds(client, userId, encryptionKey);
  if (!creds) throw new Error('icloud creds missing');

  const Ctor = await getImapFlow();
  const imap = new Ctor({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: creds.email, pass: creds.password },
    logger: false,
    socketTimeout: COMMAND_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });

  const messages: CandidateMessage[] = [];
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
    try {
      const mbox = imap.mailbox;
      if (!mbox || typeof mbox === 'boolean') throw new Error('mailbox not open');
      const total = mbox.exists;
      if (total === 0) return [];
      const lo = Math.max(1, total - maxFetch + 1);
      const range = `${lo}:${total}`;
      for await (const m of imap.fetch(range, {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyParts: ['1'],
      })) {
        const env = m.envelope;
        if (!env) continue;
        const fromAddr = env.from?.[0]?.address ?? '';
        const fromName = env.from?.[0]?.name ?? '';
        const fromEmail = fromAddr.toLowerCase().trim();
        const fromDisplay = fromName && fromAddr ? `${fromName} <${fromAddr}>` : fromAddr;
        messages.push({
          id: String(m.uid),
          from: fromDisplay,
          fromEmail,
          subject: env.subject ?? '(uden emne)',
          snippet: extractPreview(m.bodyParts?.get('1')).slice(0, 200),
          receivedAt: pickMessageDate(m.internalDate, env.date),
          labels: [],
        });
      }
    } finally {
      try { lock.release(); } catch { /* release errors are secondary */ }
    }
    await imap.logout();
  } finally {
    if (imap.usable) {
      try { await imap.close(); } catch { /* ignore */ }
    }
  }

  return messages
    .filter((c) => !isAutomatedSender(c.fromEmail, c.subject, c.labels, undefined, userOwnEmail))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);
}

function pickMessageDate(internalDate: unknown, envelopeDate: unknown): string {
  const isoOf = (v: unknown): string | null => {
    if (!v) return null;
    if (v instanceof Date) {
      const t = v.getTime();
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    if (typeof v === 'string' || typeof v === 'number') {
      const t = new Date(v).getTime();
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    return null;
  };
  return isoOf(internalDate) ?? isoOf(envelopeDate) ?? new Date().toISOString();
}

// Naive HTML stripper — same lossy approach as imap-proxy's list-inbox
// preview. Full BODYSTRUCTURE traversal is future work.
function extractPreview(part: Uint8Array | undefined): string {
  if (!part) return '';
  const text = new TextDecoder().decode(part);
  if (text.length === 0) return '';
  const looksHtml = text.slice(0, 100).includes('<');
  const stripped = looksHtml
    ? text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    : text;
  return stripped.replace(/\s+/g, ' ').trim();
}
