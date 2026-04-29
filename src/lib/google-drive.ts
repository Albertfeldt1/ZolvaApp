// Minimal Google Drive client. Searches and reads files using the OAuth
// provider_token returned by Supabase after signing in with Google
// (scope: drive.readonly). Read-only by design — no create/update/delete.

import { ProviderAuthError, tryWithRefresh } from './auth';
import { fetchWithTimeout } from './network-errors';

const BASE = 'https://www.googleapis.com/drive/v3';

// Native Google MIME types and the export format we ask Drive to convert
// them to. Anything not in this map is fetched raw via alt=media if its
// MIME type is text-shaped; otherwise we refuse to read it.
const GOOGLE_NATIVE_EXPORT: Record<string, { mime: string; label: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', label: 'Google Doc' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', label: 'Google Sheet' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', label: 'Google Slides' },
};

// Plain MIME types we accept directly via alt=media. Drive serves the raw
// bytes; we decode as UTF-8.
const READABLE_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
]);

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: Date;
  webViewLink: string;
  ownerEmail?: string;
  sizeBytes?: number;
};

export type DriveFileContent = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  text: string;
  truncated: boolean;
};

const SEARCH_FIELDS =
  'files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress),size)';

// Escape a query fragment so apostrophes don't terminate the Drive `q`
// string. Drive requires backslash-escaping inside single-quoted literals.
function escapeQueryLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function searchFiles(query: string, limit = 10): Promise<DriveFile[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const safe = escapeQueryLiteral(trimmed);
  // Match either body content OR filename, exclude trashed files. Drive's
  // fullText covers Doc/Sheet/Slide content + plain-text file bodies.
  const q = `(fullText contains '${safe}' or name contains '${safe}') and trashed = false`;

  return tryWithRefresh('google', async (accessToken) => {
    const params = new URLSearchParams({
      q,
      fields: SEARCH_FIELDS,
      pageSize: String(Math.max(1, Math.min(limit, 25))),
      orderBy: 'modifiedTime desc',
    });
    const url = `${BASE}/files?${params.toString()}`;
    const res = await fetchWithTimeout('google', url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('google', `Google Drive afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`Google Drive search failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        modifiedTime: string;
        webViewLink?: string;
        owners?: Array<{ emailAddress?: string }>;
        size?: string;
      }>;
    };
    return (json.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: new Date(f.modifiedTime),
      webViewLink: f.webViewLink ?? '',
      ownerEmail: f.owners?.[0]?.emailAddress,
      sizeBytes: f.size ? Number(f.size) : undefined,
    }));
  });
}

// Hard cap on how much body text we hand the model. ~12k chars ≈ 3k tokens
// — enough to answer "what does the doc say about X?" without blowing the
// chat context budget on a single file.
const MAX_BODY_CHARS = 12_000;

export async function getFileContent(id: string): Promise<DriveFileContent> {
  return tryWithRefresh('google', async (accessToken) => {
    // Step 1: fetch metadata so we know which extraction path to use.
    const metaUrl = `${BASE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink`;
    const metaRes = await fetchWithTimeout('google', metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaRes.status === 401 || metaRes.status === 403) {
      throw new ProviderAuthError('google', `Google Drive afvist (${metaRes.status}).`);
    }
    if (!metaRes.ok) {
      throw new Error(`Google Drive metadata failed: ${metaRes.status} ${await metaRes.text()}`);
    }
    const meta = (await metaRes.json()) as {
      id: string;
      name: string;
      mimeType: string;
      webViewLink?: string;
    };

    // Step 2: pick extraction strategy based on MIME type.
    const exportSpec = GOOGLE_NATIVE_EXPORT[meta.mimeType];
    let bodyUrl: string;
    if (exportSpec) {
      const params = new URLSearchParams({ mimeType: exportSpec.mime });
      bodyUrl = `${BASE}/files/${encodeURIComponent(id)}/export?${params.toString()}`;
    } else if (READABLE_TEXT_MIMES.has(meta.mimeType) || meta.mimeType.startsWith('text/')) {
      bodyUrl = `${BASE}/files/${encodeURIComponent(id)}?alt=media`;
    } else {
      throw new Error(
        `Filtype "${meta.mimeType}" understøttes ikke til tekstudtræk. ` +
          `Kun Google Docs/Sheets/Slides og rene tekstfiler kan læses.`,
      );
    }

    // Step 3: fetch the body, then truncate.
    const bodyRes = await fetchWithTimeout('google', bodyUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (bodyRes.status === 401 || bodyRes.status === 403) {
      throw new ProviderAuthError('google', `Google Drive afvist (${bodyRes.status}).`);
    }
    if (!bodyRes.ok) {
      throw new Error(`Google Drive download failed: ${bodyRes.status} ${await bodyRes.text()}`);
    }
    const fullText = await bodyRes.text();
    const truncated = fullText.length > MAX_BODY_CHARS;
    const text = truncated
      ? `${fullText.slice(0, MAX_BODY_CHARS)}\n\n…[afkortet — fuld fil ${fullText.length.toLocaleString('da-DK')} tegn]`
      : fullText;

    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      webViewLink: meta.webViewLink ?? '',
      text,
      truncated,
    };
  });
}
