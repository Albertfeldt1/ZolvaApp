import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { driveSearchFiles, type DriveFetch } from './drive.ts';

Deno.test('driveSearchFiles: returns mapped files with name/mime/modified/webViewLink', async () => {
  let urlCalled = '';
  const fetch: DriveFetch = async (url) => {
    urlCalled = url;
    return new Response(JSON.stringify({
      files: [{
        id: 'f-1',
        name: 'Forslag Q3.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-05-10T10:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/f-1/view',
      }],
    }), { status: 200 });
  };
  const files = await driveSearchFiles({ fetch, accessToken: 'tok', query: 'Forslag Q3', limit: 5 });
  assertEquals(files.length, 1);
  assertEquals(files[0].id, 'f-1');
  assertEquals(files[0].name, 'Forslag Q3.pdf');
  assertEquals(files[0].mimeType, 'application/pdf');
  assertEquals(files[0].modified_at, '2026-05-10T10:00:00Z');
  assertEquals(files[0].webViewLink, 'https://drive.google.com/file/d/f-1/view');
  // q clause must contain BOTH name contains and fullText contains
  assertEquals(urlCalled.includes('name+contains+'), true);
  assertEquals(urlCalled.includes('fullText+contains+'), true);
  // pageSize must reflect the limit
  assertEquals(urlCalled.includes('pageSize=5'), true);
  // trashed = false guard
  assertEquals(urlCalled.includes('trashed+%3D+false'), true);
});

Deno.test('driveSearchFiles: escapes single quotes in query (Drive query language requires \\)', async () => {
  let urlCalled = '';
  const fetch: DriveFetch = async (url) => {
    urlCalled = url;
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  };
  await driveSearchFiles({ fetch, accessToken: 'tok', query: "Albert's tilbud" });
  // The escaped backslash before the apostrophe lands url-encoded as %5C%27
  assertEquals(urlCalled.includes("Albert%5C%27s+tilbud") || urlCalled.includes("Albert%5C's+tilbud"), true);
});

Deno.test('driveSearchFiles: clamps limit to 25 max', async () => {
  let urlCalled = '';
  const fetch: DriveFetch = async (url) => {
    urlCalled = url;
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  };
  await driveSearchFiles({ fetch, accessToken: 'tok', query: 'foo', limit: 100 });
  assertEquals(urlCalled.includes('pageSize=25'), true);
});

Deno.test('driveSearchFiles: throws with status + detail on non-2xx', async () => {
  const fetch: DriveFetch = async () =>
    new Response('{"error":{"message":"invalid grant"}}', { status: 401 });
  await assertRejects(
    () => driveSearchFiles({ fetch, accessToken: 'tok', query: 'foo' }),
    Error,
    'drive.files.list 401',
  );
});
