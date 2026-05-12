// supabase/functions/_shared/agent/push.ts
//
// Pure helper: "is the user idle enough to push a notification?"
// Spec §6.3: push only when proposed_actions is written AND
// userIsForeground = false. We use last_active_at > 60s ago as the
// foreground proxy.

const IDLE_THRESHOLD_MS = 60 * 1000;

export function shouldPushForProposal(
  lastActiveAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (lastActiveAt === null) return true;
  return now.getTime() - lastActiveAt.getTime() > IDLE_THRESHOLD_MS;
}
