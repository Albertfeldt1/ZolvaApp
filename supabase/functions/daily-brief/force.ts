// Forced ("on-demand first brief") path helpers for daily-brief. The live
// fallback exists because a brand-new user has no mail_events rows yet
// (poll-mail hasn't run), and an all-empty input set is otherwise skipped.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// `force` is only honored from an authenticated user; the cron sweep must
// never generate outside each user's configured window.
export function parseForceRequest(rawBody: unknown, isCron: boolean): boolean {
  if (isCron) return false;
  if (!rawBody || typeof rawBody !== 'object') return false;
  return (rawBody as { force?: unknown }).force === true;
}

export function kindForHour(hour: number): 'morning' | 'midday' | 'evening' {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'midday';
  return 'evening';
}

type CandidateLike = { from?: string; subject?: string };

export type LiveUnreadDeps = {
  loadRefreshToken: (
    client: SupabaseClient, userId: string, provider: 'google' | 'microsoft',
  ) => Promise<string | null>;
  refreshAccessToken: (
    client: SupabaseClient, userId: string, provider: 'google' | 'microsoft',
    refreshToken: string, opts?: { microsoftScope?: string },
  ) => Promise<{ accessToken: string; expiresIn: number }>;
  fetchGmail: (accessToken: string, ownEmail: string, maxFetch?: number, keep?: number) => Promise<CandidateLike[]>;
  fetchGraph: (accessToken: string, ownEmail: string, maxFetch?: number, keep?: number) => Promise<CandidateLike[]>;
  // iCloud-only users have no OAuth refresh token, so the live fallback reaches
  // their INBOX over IMAP instead. Optional: the caller wires it only when the
  // iCloud encryption key is available.
  fetchIcloud?: (client: SupabaseClient, userId: string, ownEmail: string) => Promise<CandidateLike[]>;
};

export type UnreadItem = { from: string; subject: string };

function toUnread(candidates: CandidateLike[]): UnreadItem[] {
  return candidates.slice(0, 3).map((c) => ({
    from: c.from || 'ukendt',
    subject: c.subject || '(intet emne)',
  }));
}

// Try google then microsoft (OAuth), then iCloud over IMAP; the first provider
// that yields anything wins. iCloud is last because the IMAP round trip is the
// slowest path and most users have an OAuth provider connected.
export async function fetchLiveUnread(
  deps: LiveUnreadDeps,
  client: SupabaseClient,
  userId: string,
  ownEmail: string,
): Promise<UnreadItem[]> {
  for (const provider of ['google', 'microsoft'] as const) {
    try {
      const rt = await deps.loadRefreshToken(client, userId, provider);
      if (!rt) continue;
      const { accessToken } = await deps.refreshAccessToken(client, userId, provider, rt);
      const candidates = provider === 'google'
        ? await deps.fetchGmail(accessToken, ownEmail, 10, 3)
        : await deps.fetchGraph(accessToken, ownEmail, 10, 3);
      if (candidates.length > 0) return toUnread(candidates);
    } catch (err) {
      console.warn('[daily-brief] live unread fallback failed', provider,
        err instanceof Error ? err.message : err);
    }
  }
  if (deps.fetchIcloud) {
    try {
      const candidates = await deps.fetchIcloud(client, userId, ownEmail);
      if (candidates.length > 0) return toUnread(candidates);
    } catch (err) {
      console.warn('[daily-brief] live unread fallback failed', 'icloud',
        err instanceof Error ? err.message : err);
    }
  }
  return [];
}
