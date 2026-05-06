// Minimal OneDrive client. Searches and reads files in the signed-in
// Microsoft account's personal OneDrive using Microsoft Graph (scope:
// Files.Read). Read-only by design — no create/update/delete.

import { ProviderAuthError, tryWithRefresh } from './auth';
import { fetchWithTimeout } from './network-errors';

const BASE = 'https://graph.microsoft.com/v1.0';

// Plain MIME types we accept directly. Graph serves the raw bytes; we
// decode as UTF-8. Office formats (.docx, .xlsx, .pptx) are refused —
// extracting text from them needs a separate Graph endpoint we don't
// wire here yet.
const READABLE_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
]);

export type OnedriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: Date;
  webUrl: string;
  ownerEmail?: string;
  sizeBytes?: number;
};

export type OnedriveFileContent = {
  id: string;
  name: string;
  mimeType: string;
  webUrl: string;
  text: string;
  truncated: boolean;
};

// Escape a query fragment for the OData $search parameter. Graph's
// $search uses double-quoted strings, so we escape backslashes and quotes.
function escapeSearchLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function searchFiles(query: string, limit = 10): Promise<OnedriveFile[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const safe = escapeSearchLiteral(trimmed);
  const top = String(Math.max(1, Math.min(limit, 25)));

  return tryWithRefresh('microsoft', async (accessToken) => {
    // /me/drive/root/search matches both filenames and indexed file
    // contents (Graph builds a full-text index for Office docs and PDFs).
    const url = `${BASE}/me/drive/root/search(q='${encodeURIComponent(safe)}')?$top=${top}`;
    const res = await fetchWithTimeout('microsoft', url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError('microsoft', `OneDrive afvist (${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(`OneDrive search failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      value?: Array<{
        id: string;
        name: string;
        file?: { mimeType?: string };
        folder?: unknown;
        lastModifiedDateTime?: string;
        webUrl?: string;
        size?: number;
        createdBy?: { user?: { email?: string } };
      }>;
    };
    return (json.value ?? [])
      .filter((it) => !it.folder && it.file)
      .map((it) => ({
        id: it.id,
        name: it.name,
        mimeType: it.file?.mimeType ?? 'application/octet-stream',
        modifiedTime: it.lastModifiedDateTime ? new Date(it.lastModifiedDateTime) : new Date(0),
        webUrl: it.webUrl ?? '',
        ownerEmail: it.createdBy?.user?.email,
        sizeBytes: typeof it.size === 'number' ? it.size : undefined,
      }));
  });
}

// Hard cap on body text handed to the model. Same budget as Drive.
const MAX_BODY_CHARS = 12_000;

export async function getFileContent(id: string): Promise<OnedriveFileContent> {
  return tryWithRefresh('microsoft', async (accessToken) => {
    // Step 1: fetch metadata so we know the MIME type before downloading.
    const metaUrl = `${BASE}/me/drive/items/${encodeURIComponent(id)}?$select=id,name,file,webUrl`;
    const metaRes = await fetchWithTimeout('microsoft', metaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (metaRes.status === 401 || metaRes.status === 403) {
      throw new ProviderAuthError('microsoft', `OneDrive afvist (${metaRes.status}).`);
    }
    if (!metaRes.ok) {
      throw new Error(`OneDrive metadata failed: ${metaRes.status} ${await metaRes.text()}`);
    }
    const meta = (await metaRes.json()) as {
      id: string;
      name: string;
      file?: { mimeType?: string };
      webUrl?: string;
    };
    const mime = meta.file?.mimeType ?? 'application/octet-stream';

    if (!READABLE_TEXT_MIMES.has(mime) && !mime.startsWith('text/')) {
      throw new Error(
        `Filtype "${mime}" understøttes ikke til tekstudtræk. ` +
          `Kun rene tekstfiler (txt, markdown, csv, json, html, xml) kan læses fra OneDrive ` +
          `lige nu — Word, Excel og PowerPoint kommer senere.`,
      );
    }

    // Step 2: download the raw bytes. /content follows a redirect to a
    // pre-signed URL; fetch handles that transparently.
    const bodyUrl = `${BASE}/me/drive/items/${encodeURIComponent(id)}/content`;
    const bodyRes = await fetchWithTimeout('microsoft', bodyUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (bodyRes.status === 401 || bodyRes.status === 403) {
      throw new ProviderAuthError('microsoft', `OneDrive afvist (${bodyRes.status}).`);
    }
    if (!bodyRes.ok) {
      throw new Error(`OneDrive download failed: ${bodyRes.status} ${await bodyRes.text()}`);
    }
    const fullText = await bodyRes.text();
    const truncated = fullText.length > MAX_BODY_CHARS;
    const text = truncated
      ? `${fullText.slice(0, MAX_BODY_CHARS)}\n\n…[afkortet — fuld fil ${fullText.length.toLocaleString('da-DK')} tegn]`
      : fullText;

    return {
      id: meta.id,
      name: meta.name,
      mimeType: mime,
      webUrl: meta.webUrl ?? '',
      text,
      truncated,
    };
  });
}
