# Mail Signature — Rich (HTML + Logo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plaintext-only manual mail signature with a structured-form signature (name, title, company, phone, email, website, custom lines, logo) that renders as HTML in Outlook send/draft/reply paths. Provider-agnostic builder so iCloud SMTP can plug in later.

**Architecture:** New `src/lib/mail-signature/` folder with `types.ts` (data shapes), `storage.ts` (AsyncStorage + migration from v1 plaintext), `template.ts` (pure HTML render), `image.ts` (pick + compress + base64), `build-outgoing-body.ts` (provider-agnostic helper), `index.ts` (public API). `microsoft-graph.ts` send paths switch from `appendManualSignature` to `buildOutgoingBody`; `replyToMessage` rewritten for HTML+inline-image. `SettingsScreen.tsx` `MailSignatureSection` becomes a structured form with live preview.

**Tech Stack:** TypeScript, React Native (Expo), AsyncStorage, expo-image-picker, expo-image-manipulator, Microsoft Graph REST, Jest.

**Spec:** `docs/superpowers/specs/2026-05-04-mail-signature-rich-design.md`

---

## Pre-flight

- The user is on `main` (no worktree); no PR workflow per `project_solo_no_pr` memory. Each task ends with a commit straight to `main`.
- All code goes in this repo (`/Users/albertfeldt/ZolvaApp`). The `zolva.io` marketing site is a separate Vercel repo and is **not** touched by this plan.
- Run `pnpm test` (or `npm test` if pnpm not configured) to execute the Jest test suite. Confirm with the user which package manager they use before the first test run if it's ambiguous.

---

### Task 1: Add Expo deps + photo permission string

**Files:**
- Modify: `package.json` (deps added by CLI)
- Modify: `app.json` (`expo.ios.infoPlist.NSPhotoLibraryUsageDescription`)

- [ ] **Step 1: Install Expo modules**

```bash
npx expo install expo-image-picker expo-image-manipulator
```

Expected output: both packages added with versions matching the Expo SDK in use.

- [ ] **Step 2: Add the iOS photo-library permission string**

Edit `app.json` — find the `"ios"` block's `"infoPlist"` (currently around line 84) and add this key alongside the existing `NSUserNotificationsUsageDescription`:

```json
"NSPhotoLibraryUsageDescription": "Vælg et logo til din mail-signatur."
```

Final shape:
```json
"infoPlist": {
  "NSUserNotificationsUsageDescription": "Zolva sender notifikationer om påmindelser, dagens overblik og kommende møder.",
  "NSPhotoLibraryUsageDescription": "Vælg et logo til din mail-signatur.",
  "ITSAppUsesNonExemptEncryption": false,
  "SupabaseAnonKey": "..."
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json app.json
git commit -m "feat(mail-signature): add expo-image-picker + image-manipulator + photo permission"
```

(If the project uses pnpm, the lockfile is `pnpm-lock.yaml`, not `package-lock.json` — adjust the `git add`.)

---

### Task 2: Create types module

**Files:**
- Create: `src/lib/mail-signature/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/lib/mail-signature/types.ts
//
// Data shapes for the rich mail signature feature. SignatureData is the
// form state persisted to AsyncStorage. RenderedSignature is what the
// pure renderSignature() returns — html + plaintext + optional inline
// image. InlineAttachmentSpec is the wire-format the provider-agnostic
// build-outgoing-body helper hands to send paths (Outlook today, iCloud
// SMTP later).

export type SignatureData = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;          // multiline freeform; also receives migrated plaintext
  logo: InlineImage | null;
};

export type InlineImage = {
  base64: string;               // raw base64, no data URI prefix
  mimeType: 'image/png' | 'image/jpeg';
  width: number;                // pixels — used for the <img> attribute, not for further compression
  height: number;
};

export type RenderedSignature = {
  html: string;
  plaintext: string;
  image: { contentId: 'zolva-sig'; bytes: string; mimeType: 'image/png' | 'image/jpeg' } | null;
};

export type InlineAttachmentSpec = {
  filename: string;             // 'signature.png' | 'signature.jpg'
  mimeType: string;
  contentBytes: string;         // base64
  contentId: string;            // matches the cid: in the HTML
};

export const EMPTY_SIGNATURE: SignatureData = {
  name: '',
  title: '',
  company: '',
  phone: '',
  email: '',
  website: '',
  customLines: '',
  logo: null,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/mail-signature/types.ts
git commit -m "feat(mail-signature): types module"
```

---

### Task 3: Pure HTML template (TDD)

**Files:**
- Create: `src/lib/mail-signature/__tests__/template.test.ts`
- Create: `src/lib/mail-signature/template.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/mail-signature/__tests__/template.test.ts
import { renderSignature, escapeWithBrBreaks, bodyToParagraphs } from '../template';
import { EMPTY_SIGNATURE, SignatureData } from '../types';

const fullData: SignatureData = {
  name: 'Albert Hangaard',
  title: 'CEO',
  company: 'Zolva',
  phone: '+45 12 34 56 78',
  email: 'albert@zolva.io',
  website: 'zolva.io',
  customLines: 'CVR 12345678\nFortroligt',
  logo: { base64: 'AAAA', mimeType: 'image/png', width: 120, height: 40 },
};

describe('renderSignature', () => {
  it('returns null when every field is empty and no logo', () => {
    expect(renderSignature(EMPTY_SIGNATURE)).toBeNull();
  });

  it('renders just the name when only name is set', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'Albert' });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('<strong>Albert</strong>');
    expect(out!.image).toBeNull();
    expect(out!.plaintext).toBe('Albert');
  });

  it('renders the full signature with image and customLines', () => {
    const out = renderSignature(fullData);
    expect(out).not.toBeNull();
    expect(out!.html).toContain('<strong>Albert Hangaard</strong>');
    expect(out!.html).toContain(' · CEO');
    expect(out!.html).toContain('Zolva');
    expect(out!.html).toContain('T: +45 12 34 56 78');
    expect(out!.html).toContain('mailto:albert@zolva.io');
    expect(out!.html).toContain('https://zolva.io');
    expect(out!.html).toContain('CVR 12345678<br>Fortroligt');
    expect(out!.html).toContain('<img src="cid:zolva-sig"');
    expect(out!.html).toContain('width="120"');
    expect(out!.image).toEqual({ contentId: 'zolva-sig', bytes: 'AAAA', mimeType: 'image/png' });
  });

  it('renders only the logo when text fields are empty', () => {
    const out = renderSignature({
      ...EMPTY_SIGNATURE,
      logo: { base64: 'BBBB', mimeType: 'image/jpeg', width: 200, height: 50 },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('cid:zolva-sig');
    expect(out!.image?.mimeType).toBe('image/jpeg');
  });

  it('escapes HTML entities in user input', () => {
    const out = renderSignature({
      ...EMPTY_SIGNATURE,
      name: '<script>alert(1)</script>',
      customLines: 'A & B',
    });
    expect(out!.html).not.toContain('<script>');
    expect(out!.html).toContain('&lt;script&gt;');
    expect(out!.html).toContain('A &amp; B');
  });

  it('prefixes website with https:// when no scheme present', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'A', website: 'zolva.io' });
    expect(out!.html).toContain('href="https://zolva.io"');
  });

  it('preserves existing scheme on website', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'A', website: 'http://zolva.io' });
    expect(out!.html).toContain('href="http://zolva.io"');
  });
});

describe('escapeWithBrBreaks', () => {
  it('escapes entities and converts \\n to <br>', () => {
    expect(escapeWithBrBreaks('A & B\nC')).toBe('A &amp; B<br>C');
  });
});

describe('bodyToParagraphs', () => {
  it('splits paragraphs on \\n\\n+ and uses <br> for single \\n', () => {
    expect(bodyToParagraphs('para1 line1\npara1 line2\n\npara2')).toBe(
      '<p>para1 line1<br>para1 line2</p><p>para2</p>',
    );
  });

  it('escapes HTML in body content', () => {
    expect(bodyToParagraphs('<b>x</b>')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('returns empty paragraph for empty input', () => {
    expect(bodyToParagraphs('')).toBe('<p></p>');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
npx jest src/lib/mail-signature/__tests__/template.test.ts
```

Expected: FAIL with "Cannot find module '../template'".

- [ ] **Step 3: Write the template implementation**

```ts
// src/lib/mail-signature/template.ts
//
// Pure HTML rendering for the rich mail signature. No I/O, no React,
// no provider knowledge — just SignatureData → HTML/plaintext.
//
// Layout uses a <table> wrapper because Outlook desktop on Windows uses
// Word's HTML rendering engine, which mishandles flexbox/grid. Inline
// styles only — Gmail strips <style> blocks.

import type { RenderedSignature, SignatureData } from './types';

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// For customLines inside the signature: escape, then \n → <br>. No <p>
// wrap (would nest paragraphs inside the <br>-joined line list).
export function escapeWithBrBreaks(s: string): string {
  return escapeHtml(s).replaceAll('\n', '<br>');
}

// For the user's email body: escape, split on blank lines into paragraphs,
// remaining \n become <br>, wrap each paragraph in <p>...</p>.
export function bodyToParagraphs(s: string): string {
  const escaped = escapeHtml(s);
  const paragraphs = escaped.split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.replaceAll('\n', '<br>')}</p>`).join('');
}

function renderPlaintext(data: SignatureData): string {
  const lines: string[] = [];
  const headerParts: string[] = [];
  if (data.name) headerParts.push(data.name);
  if (data.title) headerParts.push(data.title);
  if (headerParts.length) lines.push(headerParts.join(' · '));
  if (data.company) lines.push(data.company);
  const contactParts: string[] = [];
  if (data.phone) contactParts.push(`T: ${data.phone}`);
  if (data.email) contactParts.push(data.email);
  if (contactParts.length) lines.push(contactParts.join(' · '));
  if (data.website) lines.push(data.website);
  if (data.customLines.trim()) lines.push(data.customLines);
  return lines.join('\n');
}

export function renderSignature(data: SignatureData): RenderedSignature | null {
  const lines: string[] = [];
  const headerParts: string[] = [];

  if (data.name) headerParts.push(`<strong>${escapeHtml(data.name)}</strong>`);
  if (data.title) headerParts.push(escapeHtml(data.title));
  if (headerParts.length) lines.push(headerParts.join(' · '));

  if (data.company) lines.push(escapeHtml(data.company));

  const contactParts: string[] = [];
  if (data.phone) contactParts.push(`T: ${escapeHtml(data.phone)}`);
  if (data.email) {
    contactParts.push(`<a href="mailto:${escapeHtml(data.email)}">${escapeHtml(data.email)}</a>`);
  }
  if (contactParts.length) lines.push(contactParts.join(' · '));

  if (data.website) {
    const href = data.website.startsWith('http') ? data.website : `https://${data.website}`;
    lines.push(`<a href="${escapeHtml(href)}">${escapeHtml(data.website)}</a>`);
  }

  if (data.customLines.trim()) {
    lines.push(escapeWithBrBreaks(data.customLines));
  }

  if (lines.length === 0 && !data.logo) return null;

  const textBlock = lines.length
    ? `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">${lines.join('<br>')}</div>`
    : '';
  const imgBlock = data.logo
    ? `<div style="margin-top:8px"><img src="cid:zolva-sig" alt="" width="${data.logo.width}" height="${data.logo.height}" style="display:block;border:0"></div>`
    : '';
  const html = `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr><td>${imgBlock}${textBlock}</td></tr></table>`;

  return {
    html,
    plaintext: renderPlaintext(data),
    image: data.logo
      ? { contentId: 'zolva-sig', bytes: data.logo.base64, mimeType: data.logo.mimeType }
      : null,
  };
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
npx jest src/lib/mail-signature/__tests__/template.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/template.ts src/lib/mail-signature/__tests__/template.test.ts
git commit -m "feat(mail-signature): pure template + html escape helpers"
```

---

### Task 4: Storage with migration (TDD)

**Files:**
- Create: `src/lib/mail-signature/__tests__/storage.test.ts`
- Create: `src/lib/mail-signature/storage.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/mail-signature/__tests__/storage.test.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSignature, saveSignature, __resetForTests } from '../storage';
import { EMPTY_SIGNATURE } from '../types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    _store: new Map<string, string>(),
    async getItem(k: string) { return (this as any)._store.get(k) ?? null; },
    async setItem(k: string, v: string) { (this as any)._store.set(k, v); },
    async removeItem(k: string) { (this as any)._store.delete(k); },
    async clear() { (this as any)._store.clear(); },
  },
}));

const UID = 'user-1';
const OTHER_UID = 'user-2';

describe('storage / migration', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadSignature(UID)).toBeNull();
  });

  it('migrates v1 per-user plaintext into customLines and deletes v1 key', async () => {
    await AsyncStorage.setItem(`zolva.mail.signature.${UID}`, 'Med venlig hilsen\nAlbert');
    const out = await loadSignature(UID);
    expect(out).toEqual({ ...EMPTY_SIGNATURE, customLines: 'Med venlig hilsen\nAlbert' });
    expect(await AsyncStorage.getItem(`zolva.mail.signature.${UID}`)).toBeNull();
    expect(await AsyncStorage.getItem(`zolva.mail.signature.v2.${UID}`)).not.toBeNull();
  });

  it('migrates legacy global plaintext when no per-user v1 exists', async () => {
    await AsyncStorage.setItem('zolva.mail.signature', 'Legacy text');
    const out = await loadSignature(UID);
    expect(out).toEqual({ ...EMPTY_SIGNATURE, customLines: 'Legacy text' });
    expect(await AsyncStorage.getItem('zolva.mail.signature')).toBeNull();
  });

  it('does not migrate when v2 already exists', async () => {
    const v2 = { ...EMPTY_SIGNATURE, name: 'Already' };
    await AsyncStorage.setItem(`zolva.mail.signature.v2.${UID}`, JSON.stringify(v2));
    await AsyncStorage.setItem(`zolva.mail.signature.${UID}`, 'should be ignored');
    const out = await loadSignature(UID);
    expect(out).toEqual(v2);
    // v1 stays — we only delete v1 when migrating from it
    expect(await AsyncStorage.getItem(`zolva.mail.signature.${UID}`)).toBe('should be ignored');
  });

  it('returns null and warns when v2 JSON is malformed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await AsyncStorage.setItem(`zolva.mail.signature.v2.${UID}`, '{not json');
    expect(await loadSignature(UID)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('isolates signatures per user', async () => {
    await saveSignature(UID, { ...EMPTY_SIGNATURE, name: 'A' });
    await saveSignature(OTHER_UID, { ...EMPTY_SIGNATURE, name: 'B' });
    expect((await loadSignature(UID))?.name).toBe('A');
    expect((await loadSignature(OTHER_UID))?.name).toBe('B');
  });

  it('saveSignature persists JSON under the v2 per-user key', async () => {
    await saveSignature(UID, { ...EMPTY_SIGNATURE, name: 'Albert', title: 'CEO' });
    const raw = await AsyncStorage.getItem(`zolva.mail.signature.v2.${UID}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.name).toBe('Albert');
    expect(parsed.title).toBe('CEO');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts
```

Expected: FAIL with "Cannot find module '../storage'".

- [ ] **Step 3: Write the storage implementation**

```ts
// src/lib/mail-signature/storage.ts
//
// AsyncStorage persistence for SignatureData with per-user isolation
// and silent migration from v1 plaintext (per-user OR legacy global).
//
// Storage keys:
//   zolva.mail.signature.v2.{uid}  — current JSON shape
//   zolva.mail.signature.{uid}     — v1 plaintext (per-user, pre-rich)
//   zolva.mail.signature           — legacy global plaintext (pre-multi-account)

import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeUserId } from '../auth';
import { EMPTY_SIGNATURE, type SignatureData } from './types';

const v2Key = (uid: string) => `zolva.mail.signature.v2.${uid}`;
const v1Key = (uid: string) => `zolva.mail.signature.${uid}`;
const LEGACY_GLOBAL_KEY = 'zolva.mail.signature';

let cachedUserId: string | null = null;
let cachedData: SignatureData | null = null;
let cacheLoaded = false;

const listeners = new Set<(data: SignatureData | null) => void>();

subscribeUserId((uid) => {
  cachedUserId = uid;
  cachedData = null;
  cacheLoaded = false;
  notify();
});

function notify(): void {
  for (const fn of listeners) {
    try { fn(cachedData); } catch { /* swallow; one bad listener shouldn't sink others */ }
  }
}

export function subscribeSignature(fn: (data: SignatureData | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function loadFromStorage(uid: string): Promise<SignatureData | null> {
  const v2Raw = await AsyncStorage.getItem(v2Key(uid));
  if (v2Raw !== null) {
    try {
      const parsed = JSON.parse(v2Raw) as SignatureData;
      return { ...EMPTY_SIGNATURE, ...parsed };
    } catch (err) {
      console.warn('[mail-signature] malformed v2 json, treating as no signature:', err);
      return null;
    }
  }

  const v1Raw = await AsyncStorage.getItem(v1Key(uid));
  if (v1Raw !== null) {
    const migrated: SignatureData = { ...EMPTY_SIGNATURE, customLines: v1Raw };
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(migrated));
    await AsyncStorage.removeItem(v1Key(uid));
    return migrated;
  }

  const legacy = await AsyncStorage.getItem(LEGACY_GLOBAL_KEY);
  if (legacy !== null) {
    const migrated: SignatureData = { ...EMPTY_SIGNATURE, customLines: legacy };
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(migrated));
    await AsyncStorage.removeItem(LEGACY_GLOBAL_KEY);
    return migrated;
  }

  return null;
}

// Public API. Accepts an explicit uid for tests; runtime callers use the
// no-arg overload below which reads cachedUserId.
export async function loadSignature(uid?: string): Promise<SignatureData | null> {
  const targetUid = uid ?? cachedUserId;
  if (!targetUid) return null;

  // Cache only the current user's data so subscribers stay in sync.
  if (uid && uid !== cachedUserId) {
    return loadFromStorage(uid);
  }
  if (!cacheLoaded) {
    cachedData = await loadFromStorage(targetUid);
    cacheLoaded = true;
  }
  return cachedData;
}

export async function saveSignature(uid: string | null | undefined, data: SignatureData): Promise<void>;
export async function saveSignature(data: SignatureData): Promise<void>;
export async function saveSignature(a: any, b?: any): Promise<void> {
  const uid: string | null = typeof a === 'string' || a === null || a === undefined
    ? a ?? cachedUserId
    : cachedUserId;
  const data: SignatureData = typeof a === 'string' || a === null || a === undefined ? b : a;
  if (!uid) return;
  try {
    await AsyncStorage.setItem(v2Key(uid), JSON.stringify(data));
    if (uid === cachedUserId) {
      cachedData = data;
      cacheLoaded = true;
      notify();
    }
  } catch (err) {
    console.warn('[mail-signature] save failed:', err);
  }
}

// Test hooks — not exported via index.ts.
export function __resetForTests(): void {
  cachedUserId = null;
  cachedData = null;
  cacheLoaded = false;
  listeners.clear();
}

export function __setCurrentUserForTests(uid: string | null): void {
  cachedUserId = uid;
  cachedData = null;
  cacheLoaded = false;
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/storage.ts src/lib/mail-signature/__tests__/storage.test.ts
git commit -m "feat(mail-signature): storage layer with v1+legacy migration"
```

---

### Task 5: Build outgoing body helper (TDD)

**Files:**
- Create: `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts`
- Create: `src/lib/mail-signature/build-outgoing-body.ts`

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
import { buildOutgoingBody } from '../build-outgoing-body';
import { saveSignature, __resetForTests, __setCurrentUserForTests } from '../storage';
import { EMPTY_SIGNATURE } from '../types';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    _store: new Map<string, string>(),
    async getItem(k: string) { return (this as any)._store.get(k) ?? null; },
    async setItem(k: string, v: string) { (this as any)._store.set(k, v); },
    async removeItem(k: string) { (this as any)._store.delete(k); },
    async clear() { (this as any)._store.clear(); },
  },
}));

// stub subscribeUserId so the storage module's at-import-time binding is a no-op;
// tests set the current user explicitly via __setCurrentUserForTests.
jest.mock('../../auth', () => ({
  subscribeUserId: (_cb: (uid: string | null) => void) => () => {},
}));

describe('buildOutgoingBody', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
    __setCurrentUserForTests('user-1');
  });

  it('returns text body unchanged when no signature is configured', async () => {
    const out = await buildOutgoingBody('Hej Anne');
    expect(out).toEqual({ contentType: 'text', content: 'Hej Anne', attachments: [] });
  });

  it('returns html body with signature when text-only signature is configured', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'Albert', title: 'CEO' });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('<p>Hej Anne</p>');
    expect(out.content).toContain('<strong>Albert</strong>');
    expect(out.attachments).toEqual([]);
  });

  it('returns html body + inline attachment when logo is configured', async () => {
    await saveSignature('user-1', {
      ...EMPTY_SIGNATURE,
      name: 'Albert',
      logo: { base64: 'AAAA', mimeType: 'image/png', width: 100, height: 30 },
    });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('cid:zolva-sig');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]).toEqual({
      filename: 'signature.png',
      mimeType: 'image/png',
      contentBytes: 'AAAA',
      contentId: 'zolva-sig',
    });
  });

  it('uses .jpg filename for jpeg logos', async () => {
    await saveSignature('user-1', {
      ...EMPTY_SIGNATURE,
      name: 'Albert',
      logo: { base64: 'BBBB', mimeType: 'image/jpeg', width: 100, height: 30 },
    });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.attachments[0].filename).toBe('signature.jpg');
  });

  it('escapes HTML in the user body', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'A' });
    const out = await buildOutgoingBody('<script>x</script>');
    expect(out.content).toContain('&lt;script&gt;');
    expect(out.content).not.toContain('<script>');
  });

  it('preserves paragraph breaks in the user body', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'A' });
    const out = await buildOutgoingBody('para1\n\npara2');
    expect(out.content).toContain('<p>para1</p><p>para2</p>');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
npx jest src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: FAIL with "Cannot find module '../build-outgoing-body'".

- [ ] **Step 3: Write the helper implementation**

```ts
// src/lib/mail-signature/build-outgoing-body.ts
//
// Provider-agnostic body+attachments builder. Outlook calls this from
// microsoft-graph.ts; iCloud SMTP will call it when that path is built.
// Returns the contentType, the assembled content (text or html), and the
// list of inline attachments to include in the outgoing message.

import { loadSignature } from './storage';
import { bodyToParagraphs, renderSignature } from './template';
import type { InlineAttachmentSpec } from './types';

export type OutgoingBody = {
  contentType: 'text' | 'html';
  content: string;
  attachments: InlineAttachmentSpec[];
};

export async function buildOutgoingBody(rawBody: string): Promise<OutgoingBody> {
  const data = await loadSignature();
  const rendered = data ? renderSignature(data) : null;

  if (!rendered) {
    return { contentType: 'text', content: rawBody, attachments: [] };
  }

  const bodyHtml = bodyToParagraphs(rawBody);
  const content = `${bodyHtml}${rendered.html}`;

  const attachments: InlineAttachmentSpec[] = rendered.image
    ? [{
        filename: rendered.image.mimeType === 'image/png' ? 'signature.png' : 'signature.jpg',
        mimeType: rendered.image.mimeType,
        contentBytes: rendered.image.bytes,
        contentId: rendered.image.contentId,
      }]
    : [];

  return { contentType: 'html', content, attachments };
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
npx jest src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/build-outgoing-body.ts src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
git commit -m "feat(mail-signature): provider-agnostic build-outgoing-body helper"
```

---

### Task 6: Image picker module (manual smoke-test only)

**Files:**
- Create: `src/lib/mail-signature/image.ts`

No automated tests — depends on Expo runtime + native pickers. We'll smoke-test in dev after Task 11.

- [ ] **Step 1: Write the image module**

```ts
// src/lib/mail-signature/image.ts
//
// Image picker + compression for signature logos. Picks via
// expo-image-picker, compresses via expo-image-manipulator (max 400px on
// the long side), preserves PNG transparency, falls back to JPEG @ 0.8
// for everything else. Hard cap at ~150KB final base64.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import type { InlineImage } from './types';

export type PickResult =
  | { ok: true; image: InlineImage }
  | { ok: false; reason: 'permission-denied' | 'cancelled' | 'too-large' | 'failed' };

const MAX_DIMENSION = 400;
const MAX_BASE64_LEN = 150_000;

export async function pickAndCompressLogo(): Promise<PickResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'permission-denied' };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { ok: false, reason: 'cancelled' };
  }

  const asset = result.assets[0];
  const isPng = (asset.mimeType ?? '').toLowerCase() === 'image/png'
    || asset.uri.toLowerCase().endsWith('.png');

  try {
    const longSide = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longSide > MAX_DIMENSION ? MAX_DIMENSION / longSide : 1;
    const targetWidth = Math.round((asset.width ?? MAX_DIMENSION) * scale);
    const targetHeight = Math.round((asset.height ?? MAX_DIMENSION) * scale);

    const manipulated = await manipulateAsync(
      asset.uri,
      [{ resize: { width: targetWidth, height: targetHeight } }],
      {
        compress: isPng ? 1 : 0.8,
        format: isPng ? SaveFormat.PNG : SaveFormat.JPEG,
        base64: true,
      },
    );

    const base64 = manipulated.base64 ?? '';
    if (!base64) return { ok: false, reason: 'failed' };
    if (base64.length > MAX_BASE64_LEN) return { ok: false, reason: 'too-large' };

    // Best-effort cleanup of the manipulator's tmp file. Failures are silent.
    try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}

    return {
      ok: true,
      image: {
        base64,
        mimeType: isPng ? 'image/png' : 'image/jpeg',
        width: manipulated.width,
        height: manipulated.height,
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function pickResultMessage(result: Extract<PickResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at tilføje et logo.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'failed':            return 'Kunne ikke læse billedet. Prøv et andet.';
  }
}
```

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

```bash
npx jest src/lib/mail-signature
```

Expected: all tests PASS (Task 6 didn't add any).

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/image.ts
git commit -m "feat(mail-signature): image picker + compression module"
```

---

### Task 7: Public API + delete legacy module + rewire imports

**Files:**
- Create: `src/lib/mail-signature/index.ts`
- Delete: `src/lib/mail-signature.ts`
- Modify: `src/lib/microsoft-graph.ts:5` (import line)
- Modify: `src/screens/SettingsScreen.tsx:60-67` (import line — actual UI rewrite happens in Task 11)

- [ ] **Step 1: Write the public API barrel**

```ts
// src/lib/mail-signature/index.ts
//
// Public API for the rich mail signature module. Internal files import
// from each other directly; everywhere else imports from this barrel.

export type {
  SignatureData,
  InlineImage,
  RenderedSignature,
  InlineAttachmentSpec,
} from './types';
export { EMPTY_SIGNATURE } from './types';
export { loadSignature, saveSignature, subscribeSignature } from './storage';
export { renderSignature } from './template';
export { buildOutgoingBody } from './build-outgoing-body';
export type { OutgoingBody } from './build-outgoing-body';
export { pickAndCompressLogo, pickResultMessage } from './image';
export type { PickResult } from './image';
```

- [ ] **Step 2: Delete the legacy file**

```bash
git rm src/lib/mail-signature.ts
```

- [ ] **Step 3: Rewire microsoft-graph.ts import**

In `src/lib/microsoft-graph.ts`, change line 5 from:

```ts
import { loadManualSignature } from './mail-signature';
```

to (the function disappears in Task 8 along with `appendManualSignature`; this just keeps the file compiling for now):

```ts
import { buildOutgoingBody } from './mail-signature';
```

The unused import will cause a TS warning until Task 8. That's fine — Task 8 lands immediately after.

- [ ] **Step 4: Rewire SettingsScreen.tsx imports**

In `src/screens/SettingsScreen.tsx`, change lines 60–67 from:

```ts
import {
  loadManualSignature,
  saveManualSignature,
  subscribeManualSignature,
} from '../lib/mail-signature';
```

to:

```ts
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
} from '../lib/mail-signature';
```

Then update the three references inside `MailSignatureSection` (currently around lines 133, 138, 149):
- `loadManualSignature` → `loadSignature`
- `subscribeManualSignature` → `subscribeSignature`
- `saveManualSignature(value)` → `saveSignature({ ...EMPTY_SIGNATURE, customLines: value })`

Add `EMPTY_SIGNATURE` to the same import. Update the `useState` to hold `customLines` text (still a string), so the section keeps working with the legacy plaintext UX until Task 11 rebuilds it. Specifically, replace the `useEffect` body's `setValue(s ?? '')` call sites:
- `loadSignature().then((s) => { ... setValue(s?.customLines ?? '') })`
- `subscribeSignature((s) => { ... setValue(s?.customLines ?? '') })`

This keeps the existing TextInput working as a minimal-disruption shim until Task 11.

- [ ] **Step 5: Run all signature tests + typecheck**

```bash
npx jest src/lib/mail-signature
```

Expected: all PASS.

```bash
npx tsc --noEmit
```

Expected: passes (or at most one unused-import warning on `buildOutgoingBody` in `microsoft-graph.ts` — gone in Task 8). If the project has stricter unused-import rules, comment out the import line and re-add in Task 8.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/index.ts src/lib/microsoft-graph.ts src/screens/SettingsScreen.tsx
git commit -m "refactor(mail-signature): promote to folder + rewire imports"
```

---

### Task 8: Wire Outlook send paths — sendMail + new-mail createDraft

**Files:**
- Modify: `src/lib/microsoft-graph.ts` (lines 256–319 plus the helper at 321–326)

This task switches `sendMail` and `createDraft` (new-mail branch) to `buildOutgoingBody`. Reply branches stay untouched until Tasks 9 and 10.

- [ ] **Step 1: Add a Graph attachment mapper just below the imports**

In `src/lib/microsoft-graph.ts`, just below line 5 (after the import line you updated in Task 7), add:

```ts
import type { InlineAttachmentSpec, OutgoingBody } from './mail-signature';

type GraphFileAttachment = {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
  isInline: boolean;
  contentId: string;
};

function toGraphAttachments(specs: InlineAttachmentSpec[]): GraphFileAttachment[] {
  return specs.map((s) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: s.filename,
    contentType: s.mimeType,
    contentBytes: s.contentBytes,
    isInline: true,
    contentId: s.contentId,
  }));
}
```

- [ ] **Step 2: Replace `appendManualSignature` (lines 321–326) with the helper**

Delete the `appendManualSignature` function. Nothing else depends on it after Tasks 8/9/10.

- [ ] **Step 3: Update `sendMail` (lines 292–319)**

Replace the function body so the new-mail branch uses `buildOutgoingBody` and the reply branch is left calling `replyToMessage` (which Task 10 will fix). Replace lines 292–319 with:

```ts
export async function sendMail(input: GraphComposeInput): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    if (input.replyToId) {
      // Defensive: route to replyToMessage so the rich-signature reply
      // path (Task 10) handles inline attachments correctly.
      return replyToMessage(input.replyToId, input.body);
    }
    const built: OutgoingBody = await buildOutgoingBody(input.body);
    const attachments = toGraphAttachments(built.attachments);
    await graphFetch<void>(token, `/me/sendMail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: built.contentType, content: built.content },
          toRecipients: buildRecipients(input.to),
          ccRecipients: input.cc && input.cc.length > 0 ? buildRecipients(input.cc) : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        saveToSentItems: true,
      }),
    });
  });
}
```

- [ ] **Step 4: Update `createDraft` new-mail branch**

In `createDraft` (lines 256–287), replace the new-mail branch (the `else`/fallthrough after `replyToId`) so it uses `buildOutgoingBody` and posts attachments. Reply branch stays for Task 9. Replace the function body with:

```ts
export async function createDraft(input: GraphComposeInput): Promise<{ id: string }> {
  return tryWithRefresh('microsoft', async (token) => {
    const built: OutgoingBody = await buildOutgoingBody(input.body);
    const attachments = toGraphAttachments(built.attachments);

    if (input.replyToId) {
      // Reply draft path — Task 9 will switch this to the createReply
      // dance for HTML+attachments. Until then we keep the legacy text
      // path so this task stays minimal.
      const draft = await graphFetch<{ id: string }>(
        token,
        `/me/messages/${input.replyToId}/createReplyDraft`,
        { method: 'POST' },
      );
      await graphFetch<void>(token, `/me/messages/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: { contentType: 'text', content: input.body },
        }),
      });
      return { id: draft.id };
    }

    const data = await graphFetch<{ id: string }>(token, `/me/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: built.contentType, content: built.content },
        toRecipients: buildRecipients(input.to),
        ccRecipients: input.cc && input.cc.length > 0 ? buildRecipients(input.cc) : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });
    return { id: data.id };
  });
}
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/microsoft-graph.ts
git commit -m "feat(mail-signature): wire outlook sendMail + new-mail createDraft to rich body"
```

---

### Task 9: Wire Outlook createDraft reply branch (HTML + attachments)

**Files:**
- Modify: `src/lib/microsoft-graph.ts` (createDraft reply branch from Task 8)

- [ ] **Step 1: Replace the reply branch in `createDraft`**

In `createDraft`, replace the `if (input.replyToId)` block (the version from Task 8) with:

```ts
    if (input.replyToId) {
      const draft = await graphFetch<{ id: string }>(
        token,
        `/me/messages/${input.replyToId}/createReplyDraft`,
        { method: 'POST' },
      );
      await graphFetch<void>(token, `/me/messages/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: { contentType: built.contentType, content: built.content },
        }),
      });
      for (const att of attachments) {
        await graphFetch<void>(token, `/me/messages/${draft.id}/attachments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(att),
        });
      }
      return { id: draft.id };
    }
```

The `built` and `attachments` locals are already in scope from Task 8.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/microsoft-graph.ts
git commit -m "feat(mail-signature): wire outlook reply-draft path to rich body+attachments"
```

---

### Task 10: Rewrite `replyToMessage` for HTML + inline attachments

**Files:**
- Modify: `src/lib/microsoft-graph.ts` (replace lines 227–236)

- [ ] **Step 1: Replace `replyToMessage`**

Replace the existing `replyToMessage` function (currently lines 227–236) with:

```ts
// Sends an immediate reply. For users with no signature configured this
// stays a single API call (POST /reply with `comment`). For users with
// a rich signature we createReply → PATCH HTML body → POST inline
// attachments → POST send. 4 round-trips when a signature is configured;
// 1 when it isn't. Acceptable — replies aren't latency-critical and the
// /reply endpoint can't carry inline attachments.
export async function replyToMessage(id: string, body: string): Promise<void> {
  return tryWithRefresh('microsoft', async (token) => {
    const built: OutgoingBody = await buildOutgoingBody(body);

    if (built.contentType === 'text' && built.attachments.length === 0) {
      await graphFetch<void>(token, `/me/messages/${id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: built.content }),
      });
      return;
    }

    const draft = await graphFetch<{ id: string }>(
      token,
      `/me/messages/${id}/createReply`,
      { method: 'POST' },
    );
    await graphFetch<void>(token, `/me/messages/${draft.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: { contentType: built.contentType, content: built.content },
      }),
    });
    const attachments = toGraphAttachments(built.attachments);
    for (const att of attachments) {
      await graphFetch<void>(token, `/me/messages/${draft.id}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(att),
      });
    }
    await graphFetch<void>(token, `/me/messages/${draft.id}/send`, { method: 'POST' });
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run the full Jest suite to confirm nothing else regressed**

```bash
npx jest
```

Expected: all PASS (no test changes since Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/lib/microsoft-graph.ts
git commit -m "feat(mail-signature): rewrite outlook replyToMessage for html+inline-image"
```

---

### Task 11: Settings UI — structured form + preview + image picker

**Files:**
- Modify: `src/screens/SettingsScreen.tsx` (`MailSignatureSection`, currently lines 123–173, plus styles around lines 1305–1315)

- [ ] **Step 1: Replace the imports block at lines 60–67**

Replace the import block from Task 7 with the full set of pieces the new section needs:

```ts
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
} from '../lib/mail-signature';
```

- [ ] **Step 2: Replace `MailSignatureSection`**

Replace lines 123–173 with:

```tsx
// Manual mail signature — structured form with optional logo. Renders
// as HTML in Outlook send paths (and iCloud SMTP when that lands).
// Gmail still uses the auto-fetched server signature.
function MailSignatureSection() {
  const [data, setData] = useState<SignatureData>(EMPTY_SIGNATURE);
  const [hydrated, setHydrated] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSignature().then((s) => {
      if (cancelled) return;
      setData(s ?? EMPTY_SIGNATURE);
      setHydrated(true);
    });
    const unsub = subscribeSignature((s) => {
      if (!cancelled) setData(s ?? EMPTY_SIGNATURE);
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const update = (patch: Partial<SignatureData>) => {
    setData((prev) => ({ ...prev, ...patch }));
  };
  const commit = () => {
    if (!hydrated) return;
    void saveSignature(data);
  };

  const onPickLogo = async () => {
    setPickerError(null);
    setPickerBusy(true);
    const result = await pickAndCompressLogo();
    setPickerBusy(false);
    if (!result.ok) {
      const msg = pickResultMessage(result);
      if (msg) setPickerError(msg);
      return;
    }
    const next = { ...data, logo: result.image };
    setData(next);
    void saveSignature(next);
  };

  const onRemoveLogo = () => {
    const next = { ...data, logo: null };
    setData(next);
    void saveSignature(next);
  };

  const rendered = renderSignature(data);

  return (
    <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
      <Text style={styles.sectionTitle}>Mail-signatur</Text>
      <View style={styles.inkRule} />
      <Text style={styles.signatureBody}>
        Bruges ved mails sendt fra Outlook (og iCloud, når mail-afsendelse fra Zolva er tilføjet senere).
        Gmail bruger den signatur, du allerede har sat op i Gmail-indstillingerne.
      </Text>

      <SigField label="Navn"        value={data.name}        onChange={(v) => update({ name: v })}        onBlur={commit} editable={hydrated} />
      <SigField label="Titel"       value={data.title}       onChange={(v) => update({ title: v })}       onBlur={commit} editable={hydrated} />
      <SigField label="Virksomhed"  value={data.company}     onChange={(v) => update({ company: v })}     onBlur={commit} editable={hydrated} />
      <SigField label="Telefon"     value={data.phone}       onChange={(v) => update({ phone: v })}       onBlur={commit} editable={hydrated} keyboardType="phone-pad" />
      <SigField label="Email"       value={data.email}       onChange={(v) => update({ email: v })}       onBlur={commit} editable={hydrated} keyboardType="email-address" autoCapitalize="none" />
      <SigField label="Website"     value={data.website}     onChange={(v) => update({ website: v })}     onBlur={commit} editable={hydrated} autoCapitalize="none" />
      <SigField label="Egne linjer" value={data.customLines} onChange={(v) => update({ customLines: v })} onBlur={commit} editable={hydrated} multiline />

      <Text style={styles.sigFieldLabel}>Logo</Text>
      <View style={styles.sigLogoRow}>
        {data.logo ? (
          <>
            <Image
              source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
              style={styles.sigLogoThumb}
              resizeMode="contain"
            />
            <Pressable onPress={onRemoveLogo} style={styles.sigLogoBtn} accessibilityRole="button">
              <Text style={styles.sigLogoBtnText}>Fjern</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={onPickLogo}
            disabled={pickerBusy}
            style={[styles.sigLogoBtn, pickerBusy && { opacity: 0.5 }]}
            accessibilityRole="button"
          >
            <Text style={styles.sigLogoBtnText}>{pickerBusy ? 'Indlæser…' : 'Vælg billede'}</Text>
          </Pressable>
        )}
      </View>
      {pickerError && <Text style={styles.sigError}>{pickerError}</Text>}

      <Text style={[styles.sigFieldLabel, { marginTop: 24 }]}>Forhåndsvisning</Text>
      <View style={styles.sigPreviewCard}>
        {rendered ? <SignaturePreview data={data} /> : <Text style={styles.sigPreviewEmpty}>Udfyld felterne ovenfor for at se en forhåndsvisning.</Text>}
      </View>
    </Animated.View>
  );
}

function SigField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  editable: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences';
}) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={styles.sigFieldLabel}>{props.label}</Text>
      <TextInput
        style={[styles.input, props.multiline && styles.signatureInput]}
        value={props.value}
        onChangeText={props.onChange}
        onBlur={props.onBlur}
        editable={props.editable}
        multiline={props.multiline}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.autoCapitalize ?? 'sentences'}
        autoCorrect={false}
        textAlignVertical={props.multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function SignaturePreview({ data }: { data: SignatureData }) {
  // Structural preview using RN components — not pixel-perfect against
  // every email client, but shows what fields are present.
  const headerParts = [data.name, data.title].filter(Boolean).join(' · ');
  const contactParts = [
    data.phone ? `T: ${data.phone}` : '',
    data.email,
  ].filter(Boolean).join(' · ');
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      {data.logo && (
        <Image
          source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
          style={{ width: 48, height: 48 }}
          resizeMode="contain"
        />
      )}
      <View style={{ flex: 1 }}>
        {!!headerParts && <Text style={{ fontWeight: '600', color: colors.ink }}>{headerParts}</Text>}
        {!!data.company && <Text style={{ color: colors.ink }}>{data.company}</Text>}
        {!!contactParts && <Text style={{ color: colors.ink }}>{contactParts}</Text>}
        {!!data.website && <Text style={{ color: colors.ink }}>{data.website}</Text>}
        {!!data.customLines.trim() && <Text style={{ color: colors.ink }}>{data.customLines}</Text>}
      </View>
    </View>
  );
}
```

- [ ] **Step 3: Append the new styles to the StyleSheet**

In the existing `StyleSheet.create({ ... })` block (look near `signatureInput` around line 1305), add these style keys:

```ts
sigFieldLabel: {
  marginTop: 8,
  marginBottom: 4,
  fontSize: 13,
  color: colors.fg3,
  fontWeight: '500',
},
sigLogoRow: {
  marginTop: 8,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
},
sigLogoThumb: {
  width: 56,
  height: 56,
  backgroundColor: colors.mist,
  borderRadius: 8,
},
sigLogoBtn: {
  paddingHorizontal: 14,
  paddingVertical: 10,
  borderRadius: 8,
  backgroundColor: colors.ink,
},
sigLogoBtnText: {
  color: colors.paper,
  fontWeight: '500',
},
sigError: {
  marginTop: 8,
  color: colors.warningInk,
  fontSize: 13,
},
sigPreviewCard: {
  marginTop: 8,
  padding: 16,
  borderRadius: 12,
  backgroundColor: colors.mist,
  minHeight: 80,
},
sigPreviewEmpty: {
  color: colors.fg3,
  fontStyle: 'italic',
},
```

If `colors.surface` doesn't exist in the theme module (`src/theme.ts`), use the literal `#f4f0e8` as written. If `colors.warningInk` doesn't exist, use `#a13a3a`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS. Theme tokens used (`colors.mist`, `colors.warningInk`, `colors.ink`, `colors.paper`, `colors.fg3`) are all confirmed present in `src/theme.ts`.

- [ ] **Step 5: Run the full Jest suite**

```bash
npx jest
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(mail-signature): structured form + image picker + preview in settings"
```

---

### Task 12: Manual smoke-test pass (the spec's QA checklist)

No file changes — this task validates the build end-to-end before declaring done.

- [ ] **Step 1: Start the dev server**

```bash
npx expo start --clear
```

Open in a dev build (not Expo Go — see `feedback_expo_go_limits` memory).

- [ ] **Step 2: Run through the spec's manual QA checklist**

Test each scenario; check off as you go. If any fail, file a follow-up task and DO NOT mark the plan complete.

- [ ] New install (or AsyncStorage cleared) + no v1 plaintext → Settings shows empty form, mail to yourself has no signature appended (text mode, single API call).
- [ ] Existing install with v1 plaintext (manually re-create the v1 key in dev to simulate, or test against an upgraded prod install) → Settings shows old text in `Egne linjer`, mail still sends with same content.
- [ ] Fill `name` + `title` + `phone` + no logo → reply to a thread renders HTML signature, no attachment.
- [ ] Add a logo (try a PNG with transparency and a JPEG) → reply renders HTML signature with inline image.
  - Verify in: **Outlook desktop (Windows + Mac), OWA web, Apple Mail iOS, Gmail web**.
- [ ] Remove logo → reply goes back to no-attachment HTML.
- [ ] Clear all fields and the logo → mail sends with no signature; confirm in Network tab that contentType is `text` and no attachments are posted.
- [ ] Try uploading an image >2MB → see "Billedet er for stort, vælg en mindre fil." (the picker compresses, but if the source is huge enough the post-compress base64 still exceeds 150K — pick a high-res photo to trigger).
- [ ] Try reply path on a thread (uses `replyToMessage`) and on a draft path (uses `createDraft` with `replyToId`). Both should produce identical signature rendering.

- [ ] **Step 3: If everything passes, mark the plan task complete**

No commit needed — this task is verification only.

---

## Done criteria

- All 12 tasks committed.
- `npx jest` clean.
- `npx tsc --noEmit` clean.
- Manual QA checklist in Task 12 fully passed across the 4 mail clients listed.
- No regression for users without a configured signature (text mode, single API call per send/reply).
