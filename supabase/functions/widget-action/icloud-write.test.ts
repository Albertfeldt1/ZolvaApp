// Tests for the SSRF guard in writeIcloudEvent. calendarUrl comes from a
// user-writable profile row, so a tampered value must never trigger an
// outbound fetch carrying the user's iCloud app-password.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/assert_equals.ts';
import { writeIcloudEvent } from './icloud-write.ts';
import type { IcloudCredsBlob } from '../_shared/icloud-creds.ts';

const creds: IcloudCredsBlob = {
  email: 'user@icloud.com',
  password: 'abcd-efgh-ijkl-mnop',
  calendar_home_url: 'https://p1-caldav.icloud.com/1/calendars/home/',
};

// Fail the test loudly if any fetch escapes the guard.
function withNoFetchAllowed(run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('fetch must not be called for a rejected calendarUrl');
  };
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const badUrls = [
  'https://evil.example.com/steal',
  'http://p1-caldav.icloud.com/1/calendars/home/', // not https
  'https://caldav.icloud.com.evil.com/x',
  'file:///etc/passwd',
  'not-a-url',
  '',
];

for (const url of badUrls) {
  Deno.test(`writeIcloudEvent rejects non-iCloud calendarUrl: ${url || '(empty)'}`, async () => {
    await withNoFetchAllowed(async () => {
      const out = await writeIcloudEvent({
        creds,
        calendarUrl: url,
        title: 'x',
        startIso: '2026-07-15T15:00:00Z',
        endIso: '2026-07-15T16:00:00Z',
      });
      assertEquals(out.ok, false);
      if (!out.ok) assertEquals(out.errorClass, 'invalid_target');
    });
  });
}

Deno.test('writeIcloudEvent accepts a real iCloud CalDAV host (reaches fetch)', async () => {
  const original = globalThis.fetch;
  let reached = false;
  globalThis.fetch = () => {
    reached = true;
    return Promise.resolve(new Response('', { status: 201 }));
  };
  try {
    const out = await writeIcloudEvent({
      creds,
      calendarUrl: 'https://p1-caldav.icloud.com/1/calendars/home/',
      title: 'x',
      startIso: '2026-07-15T15:00:00Z',
      endIso: '2026-07-15T16:00:00Z',
    });
    assertEquals(reached, true);
    assertEquals(out.ok, true);
  } finally {
    globalThis.fetch = original;
  }
});
