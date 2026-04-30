// supabase/functions/_shared/backfill-providers/gmail.ts

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { isAutomatedSender } from '../onboarding-backfill.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Fetch up to `maxFetch` recent inbox messages, run through the filter,
// return the most recent `keep` survivors. We fetch more than we need
// because filtering may discard a lot.
export async function fetchGmailCandidates(
  accessToken: string,
  userOwnEmail: string,
  maxFetch = 200,
  keep = 50,
): Promise<CandidateMessage[]> {
  // Step 1: list IDs from inbox, excluding category labels via Gmail's q syntax.
  // The q= filter doesn't catch every newsletter, but cuts the pre-filter set.
  const q = encodeURIComponent('in:inbox -category:promotions -category:social -category:updates -category:forums');
  const listRes = await fetch(`${BASE}/messages?q=${q}&maxResults=${maxFetch}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`gmail list ${listRes.status}: ${await listRes.text()}`);
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);

  // Step 2: fetch metadata for each (parallel batches of 10).
  const candidates: CandidateMessage[] = [];
  const BATCH = 10;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const metas = await Promise.all(
      batch.map((id) =>
        fetch(
          `${BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        ).then((r) => r.ok ? r.json() : null).catch(() => null),
      ),
    );
    for (const meta of metas) {
      if (!meta) continue;
      const m = meta as {
        id: string;
        labelIds?: string[];
        snippet?: string;
        internalDate?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = m.payload?.headers ?? [];
      const fromRaw = headers.find((h) => h.name === 'From')?.value ?? '';
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(uden emne)';
      const fromEmail = extractEmail(fromRaw);
      const receivedAt = m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date().toISOString();
      candidates.push({
        id: m.id,
        from: fromRaw,
        fromEmail,
        subject,
        snippet: (m.snippet ?? '').slice(0, 200),
        receivedAt,
        labels: m.labelIds ?? [],
      });
    }
  }

  // Step 3: filter and keep the most recent `keep`.
  return candidates
    .filter((c) => !isAutomatedSender(c.fromEmail, c.subject, c.labels, undefined, userOwnEmail))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);
}

function extractEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  return raw.toLowerCase().trim();
}
