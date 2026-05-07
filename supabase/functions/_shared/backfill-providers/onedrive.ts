// supabase/functions/_shared/backfill-providers/onedrive.ts
//
// Metadata-only OneDrive backfill. Lists items the user has touched
// recently and returns CandidateMessage rows for the same Claude pipeline
// mail/calendar/Google-Drive use. Mirrors google-drive.ts in shape - only
// the API surface differs.
//
// Filter: keep Office docs (Word/Excel/PowerPoint) plus OneNote. Limit to
// files the user OWNS (createdBy is them) OR files where they were the
// most recent modifier. Pure shared-with-me items the user never touched
// are noise - they reflect what was sent to the user, not what the user
// is working on.

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { fetchWithRetry } from '../onboarding-backfill.ts';

const BASE = 'https://graph.microsoft.com/v1.0';

const KEEP_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/onenote',
]);

const MIME_LABEL: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/onenote': 'OneNote',
};

type GraphIdentity = { displayName?: string; email?: string; id?: string };
type GraphIdentitySet = { user?: GraphIdentity; application?: GraphIdentity };

type GraphDriveItem = {
  id: string;
  name?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  createdBy?: GraphIdentitySet;
  lastModifiedBy?: GraphIdentitySet;
  shared?: { scope?: string };
  remoteItem?: unknown;
};

export async function fetchOnedriveCandidates(
  accessToken: string,
  userOwnEmail: string,
  maxFetch = 100,
  keep = 50,
): Promise<CandidateMessage[]> {
  // /me/drive/recent returns items the user has accessed recently across
  // all locations (own drive, shared, group). Microsoft already orders
  // by recency; we don't have to specify $orderby.
  const url = `${BASE}/me/drive/recent?$top=${maxFetch}`;
  const res = await fetchWithRetry(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`onedrive list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { value?: GraphDriveItem[] };
  const items = json.value ?? [];

  const userEmail = userOwnEmail.toLowerCase().trim();
  const isUser = (id?: GraphIdentity) =>
    !!id?.email && id.email.toLowerCase() === userEmail;

  const candidates: CandidateMessage[] = items
    .filter((it) => !it.folder && it.file && KEEP_MIME_TYPES.has(it.file?.mimeType ?? ''))
    .filter((it) => {
      // Keep only files the user is meaningfully connected to: they
      // created it OR they were the most recent modifier. Files merely
      // viewed via a shared link are noise.
      if (isUser(it.createdBy?.user)) return true;
      if (isUser(it.lastModifiedBy?.user)) return true;
      return false;
    })
    .map((it) => {
      const mime = it.file?.mimeType ?? '';
      const kind = MIME_LABEL[mime] ?? 'Fil';
      const ownedByUser = isUser(it.createdBy?.user);
      const lastMod = it.lastModifiedBy?.user;
      const lastModName = lastMod && !isUser(lastMod)
        ? (lastMod.displayName || lastMod.email || '')
        : '';
      const snippetParts: string[] = [];
      snippetParts.push(ownedByUser ? 'oprettet af dig' : 'delt med dig');
      if (lastModName) snippetParts.push(`senest redigeret af ${lastModName}`);
      if (it.shared?.scope) snippetParts.push(`delt: ${it.shared.scope}`);
      // Pack into the shared CandidateMessage shape so callClaudeBatch +
      // insertPendingFacts consume it without changes.
      return {
        id: it.id,
        from: kind,
        fromEmail: '',
        subject: it.name ?? '(uden navn)',
        snippet: snippetParts.join(' · '),
        receivedAt: it.lastModifiedDateTime ?? it.createdDateTime ?? new Date().toISOString(),
        labels: [],
      };
    })
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);

  return candidates;
}
