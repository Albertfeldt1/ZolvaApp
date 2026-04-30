// supabase/functions/_shared/backfill-providers/microsoft.ts

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { isAutomatedSender, fetchWithRetry } from '../onboarding-backfill.ts';

const BASE = 'https://graph.microsoft.com/v1.0';

export async function fetchGraphCandidates(
  accessToken: string,
  userOwnEmail: string,
  maxFetch = 200,
  keep = 50,
): Promise<CandidateMessage[]> {
  // Graph supports $top up to 1000. We use 200 since we filter aggressively
  // and want recent mail.
  const url = `${BASE}/me/mailFolders/Inbox/messages?$top=${maxFetch}&$select=id,subject,from,bodyPreview,receivedDateTime,categories,inferenceClassification&$orderby=receivedDateTime desc`;
  const res = await fetchWithRetry(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`graph list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    value?: Array<{
      id: string;
      subject?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
      bodyPreview?: string;
      receivedDateTime?: string;
      categories?: string[];
      inferenceClassification?: 'focused' | 'other';
    }>;
  };

  const candidates: CandidateMessage[] = (json.value ?? []).map((m) => {
    const fromEmail = (m.from?.emailAddress?.address ?? '').toLowerCase().trim();
    const fromName = m.from?.emailAddress?.name ?? '';
    return {
      id: m.id,
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      fromEmail,
      subject: m.subject ?? '(uden emne)',
      snippet: (m.bodyPreview ?? '').slice(0, 200),
      receivedAt: m.receivedDateTime ?? new Date().toISOString(),
      labels: m.categories ?? [],
      inferenceClassification: m.inferenceClassification,
    };
  });

  return candidates
    .filter((c) => !isAutomatedSender(c.fromEmail, c.subject, c.labels, c.inferenceClassification, userOwnEmail))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);
}
