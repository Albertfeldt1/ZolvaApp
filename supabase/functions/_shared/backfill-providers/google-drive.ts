// supabase/functions/_shared/backfill-providers/google-drive.ts
//
// Metadata-only Drive backfill. Lists recent Google-native docs (Docs,
// Sheets, Slides) the user has touched, returns metadata-shaped candidates
// for the same Claude pipeline mail/calendar use. We never fetch file
// bodies here — the broader chat-tool already has drive.readonly for
// explicit user-initiated reads; the backfill stays metadata-level so
// onboarding doesn't sweep document content into the prompt.
//
// Filter: only files the user OWNS or has personally edited (writers
// includes the user). Pure view-only files (shared link recipients) are
// noise — they reflect what was sent to the user, not what the user
// is working on.

import type { CandidateMessage } from '../onboarding-backfill.ts';
import { fetchWithRetry } from '../onboarding-backfill.ts';

const BASE = 'https://www.googleapis.com/drive/v3';

const KEEP_MIME_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
];

const MIME_LABEL: Record<string, string> = {
  'application/vnd.google-apps.document': 'Doc',
  'application/vnd.google-apps.spreadsheet': 'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
};

type DriveUser = { displayName?: string; emailAddress?: string; me?: boolean };

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  ownedByMe?: boolean;
  shared?: boolean;
  trashed?: boolean;
};

export async function fetchDriveCandidates(
  accessToken: string,
  userOwnEmail: string,
  maxFetch = 100,
  keep = 50,
): Promise<CandidateMessage[]> {
  // Drive API q syntax: filter on mimeType + non-trashed in one call.
  // Order by modifiedTime desc so the freshest files come back first.
  // We don't filter ownedByMe at the API level — frequent co-editing
  // (you're a writer but not owner) is a strong collaboration signal,
  // so we let the post-filter decide.
  const mimeQ = KEEP_MIME_TYPES.map((m) => `mimeType='${m}'`).join(' or ');
  const q = `(${mimeQ}) and trashed=false`;
  const fields = 'files(id,name,mimeType,modifiedTime,createdTime,owners(displayName,emailAddress,me),lastModifyingUser(displayName,emailAddress,me),ownedByMe,shared)';
  const url = `${BASE}/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime%20desc&pageSize=${maxFetch}&fields=${encodeURIComponent(fields)}`;

  const res = await fetchWithRetry(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`drive list ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { files?: DriveFile[] };
  const files = json.files ?? [];

  const userEmail = userOwnEmail.toLowerCase().trim();

  const candidates: CandidateMessage[] = files
    .filter((f) => {
      // Keep only files the user is meaningfully connected to: they own
      // OR they were the most recent modifier. Pure shared-with-me files
      // they never edited are noise.
      if (f.ownedByMe) return true;
      const lastMod = f.lastModifyingUser;
      if (lastMod?.me) return true;
      if (lastMod?.emailAddress && lastMod.emailAddress.toLowerCase() === userEmail) return true;
      return false;
    })
    .map((f) => {
      const kind = MIME_LABEL[f.mimeType ?? ''] ?? 'Fil';
      const collaborators = (f.owners ?? [])
        .filter((o) => !o.me && o.emailAddress?.toLowerCase() !== userEmail)
        .map((o) => o.displayName || o.emailAddress || '')
        .filter(Boolean);
      const lastMod = f.lastModifyingUser;
      const lastModName = lastMod && !lastMod.me && lastMod.emailAddress?.toLowerCase() !== userEmail
        ? (lastMod.displayName || lastMod.emailAddress || '')
        : '';
      // Pack the metadata into the existing CandidateMessage shape so the
      // shared callClaudeBatch + insertPendingFacts pipeline can consume
      // it without changes. `from` becomes the file kind label (Doc/Sheet/
      // Slides), `subject` the file name, `snippet` the collaboration
      // summary the prompt will read.
      const snippetParts: string[] = [];
      if (f.ownedByMe) snippetParts.push('ejet af dig');
      else snippetParts.push('delt med dig');
      if (collaborators.length > 0) {
        snippetParts.push(`samarbejdere: ${collaborators.slice(0, 3).join(', ')}`);
      }
      if (lastModName) snippetParts.push(`senest redigeret af ${lastModName}`);
      if (f.shared) snippetParts.push('delt med flere');
      return {
        id: f.id,
        from: kind,
        fromEmail: '',
        subject: f.name ?? '(uden navn)',
        snippet: snippetParts.join(' · '),
        receivedAt: f.modifiedTime ?? f.createdTime ?? new Date().toISOString(),
        labels: [],
      };
    })
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, keep);

  return candidates;
}
