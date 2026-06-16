// Completion logic for the onboarding backfill progress screen.
//
// Pulled out as a pure function so the "empty set vs not-yet-polled"
// distinction is testable. An empty job set is only "complete" once a status
// poll has actually confirmed it — otherwise the screen would finish before
// the first poll resolves. A non-empty set is complete when every job has
// reached a terminal state.

type JobLike = { status: string };

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function isBackfillComplete(jobs: JobLike[], firstPollDone: boolean): boolean {
  if (jobs.length === 0) return firstPollDone;
  return jobs.every((j) => TERMINAL_STATUSES.has(j.status));
}

// The jobs to report as failures when finishing the screen. Crucially this is
// NOT "everything not done": a run that times out or hits the animation ceiling
// with jobs still running/queued must not report those as failed — they keep
// processing server-side. Only genuinely failed/cancelled jobs count.
export function failedJobs<T extends JobLike>(jobs: T[]): T[] {
  return jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled');
}
