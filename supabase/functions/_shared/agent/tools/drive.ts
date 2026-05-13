// Read-only Google Drive search for the agent. OneDrive support deferred.

export type DriveFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modified_at: string;
  webViewLink: string | null;
}

function escapeQueryLiteral(s: string): string {
  // Drive query language: single quotes inside a string literal must be
  // backslash-escaped (\\' in JS source → \' on the wire).
  return s.replace(/'/g, "\\'");
}

export async function driveSearchFiles(input: {
  fetch: DriveFetch;
  accessToken: string;
  query: string;
  limit?: number;
}): Promise<DriveFile[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 25);
  const escaped = escapeQueryLiteral(input.query.trim());
  const q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    orderBy: 'modifiedTime desc',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const res = await input.fetch(url, { headers: { authorization: `Bearer ${input.accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`drive.files.list ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    files?: Array<{
      id: string;
      name: string;
      mimeType: string;
      modifiedTime?: string;
      webViewLink?: string;
    }>;
  };
  return (json.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modified_at: f.modifiedTime ?? '',
    webViewLink: f.webViewLink ?? null,
  }));
}
