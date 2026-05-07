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
// 30s, not 10s. The backfill fetches a window of message bodies in a
// single IMAP transaction - over Supabase's edge → me.com path that
// regularly exceeds 10s of wall time, especially when iCloud throttles or
// a single message body is multi-MB. imap-proxy gets away with 10s because
// it fetches ≤50 messages on the live-inbox path.
const COMMAND_TIMEOUT_MS = 30_000;
// Hard ceiling on the entire fetchIcloudCandidates call. Backstop for the
// imapflow race where socket errors escape as event-loop rejections instead
// of bubbling through the active fetch's promise - without this, a stalled
// connection left the worker hanging until function-level wall clock killed
// it, and the backfill_jobs row stuck in 'queued' forever.
const FETCH_DEADLINE_MS = 60_000;

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
  // 50, matching imap-proxy's working volume for the live-inbox path.
  // Larger windows (100, 200) routinely stalled mid-fetch over Supabase's
  // edge → me.com path on slower mailboxes. The downstream `keep` cap is
  // already 50, so reducing maxFetch only narrows the candidate pool the
  // automated-sender filter chooses from.
  maxFetch = 50,
  keep = 50,
): Promise<CandidateMessage[]> {
  // One retry with 5s backoff on transient transport errors. Apple's IMAP
  // path is intermittently unstable for Supabase edge IPs (TLS close-on-
  // greeting, socket idle-timeouts) - single-shot fetches fail the user's
  // entire onboarding when one attempt unluckily lands in a 30s window
  // when Apple is hiccuping. Two attempts catch most of these without
  // exceeding the 150s function wall-clock (60+5+60 = 125s worst case).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5_000));
    try {
      return await raceWithDeadline(
        fetchIcloudCandidatesInner(client, userId, encryptionKey, userOwnEmail, maxFetch, keep),
        FETCH_DEADLINE_MS,
      );
    } catch (err) {
      lastErr = err;
      if (!isTransientImapError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[backfill:icloud] attempt ${attempt + 1} failed (${msg}), retrying`);
    }
  }
  throw lastErr;
}

function isTransientImapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? '';
  return (
    /timeout|connection not available|closed.*after.*connect|unexpected close|deadline/i.test(msg) ||
    code === 'ClosedAfterConnectTLS' ||
    code === 'ClosedAfterConnect'
  );
}

// Race the inner work against an explicit deadline. imapflow's socket-timeout
// can emit an unhandled rejection on the client's 'error' event instead of
// rejecting the active fetch's promise - caller's try/catch never fires and
// the worker hangs until function wall-clock kills it. Our timeout always
// reaches our own catch, so finishJob can mark the row 'failed'.
function raceWithDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`icloud fetch deadline ${ms}ms exceeded`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fetchIcloudCandidatesInner(
  client: SupabaseClient,
  userId: string,
  encryptionKey: string,
  userOwnEmail: string,
  maxFetch: number,
  keep: number,
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

  // Subscribe to the imapflow client error event so socket-level errors
  // surface as visible logs instead of escaping silently to Deno's event
  // loop. The deadline race above is what actually rescues the caller;
  // this is just for diagnostics.
  imap.on('error', (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[backfill:icloud] imapflow client error: ${msg}`);
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

// Naive HTML stripper - same lossy approach as imap-proxy's list-inbox
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
