// supabase/functions/agent-commitments/index.ts
//
// Commitment sweep (~every 2h). Per agent_enabled user:
//   Phase 1 (watermark-gated): scan recent sent mail → extract you_owe commitments.
//   Phase 2 (every run): reconcile (expire-only in Slice 1), then fire one
//   templated nudge per due loop. A nudged loop stays status='open' — only
//   nudged_at is stamped — so you_owe re-nudges daily until resolved/expired
//   and the row stays visible to reconcile. (Do NOT set status='nudged'.)
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runCommitmentScan } from '../_shared/agent/runner.ts';
import {
  buildDeps,
  listSentCandidates,
  listStaleSentThreads,
  listOutlookSentCandidates,
  listOutlookStaleSentThreads,
  selectOpenCommitments,
  updateCommitment,
  markScanned,
  loadGmailAccessToken,
  loadOutlookAccessToken,
  loadOutlookUserAddress,
  readThreadState,
  readOutlookThreadState,
} from '../_shared/agent/build-deps.ts';
import { applyReconcile, selectDue, buildCommitmentNudge, copenhagenDay } from '../_shared/agent/commitments.ts';
import type { CommitmentRow, ThreadState } from '../_shared/agent/commitments.ts';
import type { ScanCandidate } from '../_shared/agent/prompt.ts';
import { isQuietHours } from '../_shared/agent/quiet-hours.ts';
import { deriveIdemKey } from '../_shared/agent/idem.ts';

const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET');
if (!CRON_SECRET) {
  throw new Error('[agent-commitments] CRON_SHARED_SECRET is not set — refusing to start');
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SCAN_STALE_MS = 6 * 60 * 60 * 1000; // re-extract at most every 6h per user

async function selectAgentEnabledUsers(
  client: SupabaseClient,
): Promise<Array<{ userId: string; timezone: string; scannedAt: string | null }>> {
  const { data, error } = await client
    .from('user_profiles')
    .select('user_id, timezone, commitments_scanned_at')
    .eq('agent_enabled', true);
  if (error) throw error;
  const seen = new Set<string>();
  const out: Array<{ userId: string; timezone: string; scannedAt: string | null }> = [];
  for (const r of (data ?? []) as Array<{ user_id: string; timezone: string | null; commitments_scanned_at: string | null }>) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    out.push({ userId: r.user_id, timezone: r.timezone || 'Europe/Copenhagen', scannedAt: r.commitments_scanned_at });
  }
  return out;
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  const users = await selectAgentEnabledUsers(client);

  const results: Array<{ userId: string; scanned: boolean; nudged: number; reason?: string; error?: string }> = [];

  for (const { userId: uid, timezone, scannedAt } of users) {
    try {
      // Quiet hours: skip the whole run so the daily dedup isn't consumed during
      // the user's sleep window — the nudge fires at the first sweep after quiet
      // hours end. Mirrors agent-reflect's quiet-hours gating exactly.
      if (isQuietHours(now, timezone)) {
        results.push({ userId: uid, scanned: false, nudged: 0, reason: 'quiet_hours' });
        continue;
      }

      const deps = buildDeps(client, uid);

      // Phase 1 — extraction, watermark-gated (at most every SCAN_STALE_MS).
      let scanned = false;
      const stale = !scannedAt || (now.getTime() - new Date(scannedAt).getTime() > SCAN_STALE_MS);
      if (stale) {
        // Candidate streams across both providers: recent sent mail (→ you_owe
        // promises) and stale threads the user spoke last in (→ owed_to_you).
        // Gmail + Outlook each contribute both streams; per-provider failures are
        // swallowed inside the readers so one bad provider can't blank the scan.
        const [recent, staleSent, recentO, staleO] = await Promise.all([
          listSentCandidates(client, uid),
          listStaleSentThreads(client, uid),
          listOutlookSentCandidates(client, uid),
          listOutlookStaleSentThreads(client, uid),
        ]);
        // Dedup by thread_id: the 3–7d windows overlap, and showing one thread
        // under both labels lets Claude record BOTH a you_owe and an owed_to_you
        // row for it — the direction-agnostic nudge idem then strands one as a
        // zombie. Prefer the recent (you_owe) view: promises are time-sensitive,
        // and a thread that's only "waiting" ages out of the 7d recent window and
        // is then seen solely as stale → owed_to_you.
        // Dedup by thread_id, preferring the recent (you_owe) view. IDs are
        // provider-scoped (Gmail threadId vs Graph conversationId) so they never
        // collide across providers — the dedup only fuses the 3–7d window overlap
        // within a provider.
        const byThread = new Map<string, ScanCandidate>();
        for (const c of [...recent, ...staleSent, ...recentO, ...staleO]) {
          if (!byThread.has(c.thread_id) || c.kind === 'sent_recent') byThread.set(c.thread_id, c);
        }
        const candidates = [...byThread.values()];
        if (candidates.length > 0) {
          await runCommitmentScan({ userId: uid, candidates, deps });
          scanned = true;
        }
        await markScanned(client, uid, now.toISOString());
      }

      // Phase 2 — reconcile with real thread state (Slice 3) then fire one
      // templated nudge per still-open due loop. Reconcile closes loops that
      // moved: a sent follow-up resolves you_owe, an inbound reply resolves
      // owed_to_you. This is the "stop nudging me about things I've already
      // done" path — it runs before selectDue so a resolved loop never nudges.
      const open = await selectOpenCommitments(client, uid);
      // Load each provider's token once, only if a row of that provider needs
      // reconciling. A token-load failure degrades to expire-only (the reader is
      // skipped), matching Slice 1 behaviour rather than crashing the sweep.
      let gmailToken: string | null = null;
      if (open.some((r) => r.provider === 'google')) {
        try {
          gmailToken = await loadGmailAccessToken(client, uid);
        } catch (err) {
          console.warn('[agent-commitments] gmail token for reconcile failed for', uid, err instanceof Error ? err.message : String(err));
        }
      }
      let outlookToken: string | null = null;
      let outlookOwner: string | null = null;
      if (open.some((r) => r.provider === 'microsoft')) {
        try {
          outlookToken = await loadOutlookAccessToken(client, uid);
          if (outlookToken) outlookOwner = await loadOutlookUserAddress(outlookToken);
        } catch (err) {
          console.warn('[agent-commitments] outlook token for reconcile failed for', uid, err instanceof Error ? err.message : String(err));
        }
      }
      const stillOpen: CommitmentRow[] = [];
      for (const row of open) {
        let thread: ThreadState = { lastMessageAt: null, lastDirection: null };
        if (row.provider === 'google' && gmailToken) {
          thread = await readThreadState(gmailToken, row.thread_id);
        } else if (row.provider === 'microsoft' && outlookToken && outlookOwner) {
          thread = await readOutlookThreadState(outlookToken, row.thread_id, outlookOwner);
        }
        const change = applyReconcile(row, thread, now);
        if (change) {
          await updateCommitment(client, row.id, change);
        } else {
          stillOpen.push(row);
        }
      }

      const due = selectDue(stillOpen, now);
      let nudged = 0;

      if (due.length > 0) {
        const runId = await deps.openRun(uid, 'commitments.nudge', []);
        try {
          const day = copenhagenDay(now);

          for (const row of due) {
            const n = buildCommitmentNudge(row);
            // Mirror runner.ts lines 470-488 exactly:
            //   idemKey = deriveIdemKey('nudge.push', { ...recordPayload, day })
            // Here recordPayload is { action_kind, target_id, title, body } (what
            // buildCommitmentNudge returns). day is appended the same way the runner
            // appends it to exec.recordPayload before hashing.
            const recordPayload = {
              action_kind: n.action_kind,
              target_id: n.target_id,
              title: n.title,
              body: n.body,
            };
            const idemKey = deriveIdemKey('nudge.push', { ...recordPayload, day });
            const { sent } = await deps.fireNudge({
              user_id: uid,
              run_id: runId,
              payload: { ...recordPayload, day, idem_key: idemKey },
              title: n.title,
              body: n.body,
              data: { type: 'nudge', action_kind: n.action_kind, target_id: n.target_id },
            });
            // Stamp only nudged_at; keep status='open' so the loop stays visible to
            // reconcile and re-nudges daily (you_owe) until resolved/expired.
            if (sent) {
              await updateCommitment(client, row.id, { nudged_at: now.toISOString() });
              nudged++;
            }
          }
        } finally {
          await deps.finishRun(runId, 'ok', { input_tokens: 0, output_tokens: 0 }, undefined, []);
        }
      }

      results.push({ userId: uid, scanned, nudged });
    } catch (err) {
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}`
        : (() => {
            try { return JSON.stringify(err); } catch { return String(err); }
          })();
      console.error('[agent-commitments] error for', uid, msg);
      results.push({ userId: uid, scanned: false, nudged: 0, error: msg });
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { 'content-type': 'application/json' },
  });
});
