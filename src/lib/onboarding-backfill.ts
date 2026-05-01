// src/lib/onboarding-backfill.ts
//
// Client-side wrappers over the three onboarding-backfill edge functions.
// Polling and state management live in the screens; this is the network
// boundary only.

import { supabase } from './supabase';

export type BackfillJob = {
  id: string;
  kind: 'mail' | 'calendar';
  provider: 'google' | 'microsoft' | 'icloud';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  processed: number;
  total: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type StartResponse = { job_ids: string[]; idempotent?: boolean; reason?: string };
type StatusResponse = { jobs: Array<{
  id: string; kind: string; provider: string; status: string;
  processed: number; total: number | null;
  started_at: string | null; finished_at: string | null; error: string | null;
}> };

export async function startBackfill(opts: { force?: boolean } = {}): Promise<StartResponse> {
  const { data, error } = await supabase.functions.invoke<StartResponse>(
    'onboarding-backfill-start',
    { body: opts.force ? { force: true } : {} },
  );
  if (error) throw new Error(error.message);
  return data ?? { job_ids: [] };
}

// ─── Re-run trigger ──────────────────────────────────────────────────────
// MemoryScreen exposes a "Genscan" button; tapping it should reopen the
// onboarding chain in force-rerun mode. App.tsx owns the chain state, so
// we use a tiny module-level event bus to bridge them without prop-drilling.

const rerunSubscribers = new Set<() => void>();

export function subscribeBackfillRerun(fn: () => void): () => void {
  rerunSubscribers.add(fn);
  return () => { rerunSubscribers.delete(fn); };
}

export function triggerBackfillRerun(): void {
  for (const fn of rerunSubscribers) fn();
}

export async function fetchBackfillStatus(): Promise<BackfillJob[]> {
  const { data, error } = await supabase.functions.invoke<StatusResponse>(
    'onboarding-backfill-status',
    { method: 'GET' },
  );
  if (error) throw new Error(error.message);
  return (data?.jobs ?? []).map((j) => ({
    id: j.id,
    kind: j.kind as BackfillJob['kind'],
    provider: j.provider as BackfillJob['provider'],
    status: j.status as BackfillJob['status'],
    processed: j.processed,
    total: j.total,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
    error: j.error,
  }));
}

export async function cancelBackfill(): Promise<{ cancelled: number }> {
  const { data, error } = await supabase.functions.invoke<{ cancelled: number }>(
    'onboarding-backfill-cancel',
    { body: {} },
  );
  if (error) throw new Error(error.message);
  return data ?? { cancelled: 0 };
}

export function isAllDone(jobs: BackfillJob[]): boolean {
  if (jobs.length === 0) return true;
  return jobs.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
}

export function progressLabel(jobs: BackfillJob[]): string {
  if (jobs.length === 0) return 'Færdig';
  const running = jobs.find((j) => j.status === 'running');
  if (running) {
    const kind = running.kind === 'mail' ? 'emails' : 'kalender';
    if (running.total) return `Læser ${kind}… (${running.processed} af ${running.total})`;
    return `Læser ${kind}…`;
  }
  if (isAllDone(jobs)) return 'Færdig';
  return 'Forbereder…';
}
