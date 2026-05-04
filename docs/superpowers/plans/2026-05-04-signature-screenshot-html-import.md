# Mail Signature — Screenshot Import (HTML Reproduction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the user-visible behavior of the just-shipped screenshot importer so that imports produce a sanitized, Outlook-safe HTML reproduction of the screenshot (with logo cropped from the image), not a text-field overwrite.

**Architecture:** `SignatureData` becomes a discriminated union of `StructuredSignature` (today) and `ImportedSignature` (new HTML+image+plaintext). Vision call uses Anthropic tool-use to force a `{ html, plaintext, logoBox }` shape. A pure allowlist sanitizer (`sanitize.ts`) enforces an Outlook-Word-rendering-engine-safe HTML/CSS subset. Logo is cropped from the resized screenshot at the returned bbox and embedded as `cid:zolva-sig`. `MailSignatureSection` becomes mode-aware. `buildOutgoingBody` branches on `kind`.

**Tech Stack:** TypeScript, React Native (Expo), expo-image-picker, expo-image-manipulator, expo-file-system, react-native-webview (already in deps), Anthropic Claude API tool-use, Jest.

**Spec:** `docs/superpowers/specs/2026-05-04-signature-screenshot-html-design.md`

---

## Pre-flight

- Worktree: `/Users/albertfeldt/ZolvaApp/.worktrees/mail-signature-screenshot`, branch `feature/mail-signature-screenshot`. Already has 8 prior commits ending at `ccbd54f` (the spec). All npm deps installed; `.env` copied.
- Solo project (memory `project_solo_no_pr`); commits go to the worktree branch and merge to `main` later via the finishing-a-development-branch skill.
- The proxy `claude-proxy` was already redeployed in the prior pass to support `image` content blocks (commit `7bb0f69`). No re-deploy needed.
- The client `ClaudeContentBlock` already has the `image` arm (commit `7b5767c`).
- Run `npx tsc --noEmit && npx jest` after every task. Both must stay green by the end.
- All commits target `feature/mail-signature-screenshot`.

---

### Task 1: Discriminated-union types + EMPTY_SIGNATURE shape

**Files:**
- Modify: `src/lib/mail-signature/types.ts`

This is the foundation — every later task narrows on the new `kind` field. The existing `SignatureData` becomes the union; later tasks update each consumer to narrow on `kind`. (`StructuredSignature` body matches today's `SignatureData` exactly so existing render/storage code keeps working until each consumer is touched.)

- [ ] **Step 1: Replace the type body**

Open `src/lib/mail-signature/types.ts`. Replace the entire file contents with:

```ts
// src/lib/mail-signature/types.ts
//
// Data shapes for the rich mail signature feature.
//
// SignatureData is a discriminated union of two modes:
//   - 'structured' — name/title/company/etc. + optional logo (the original
//     rich-mail-signature feature). Renders via template.ts.
//   - 'imported'   — sanitized Outlook-safe HTML + plaintext + optional
//     cropped logo, produced by the screenshot-import flow. Renders by
//     using its `html` directly.
//
// The `kind` field tags each entry. Migration on read defaults legacy
// entries (no `kind` field) to 'structured' — see storage.ts.

export type StructuredSignature = {
  kind: 'structured';
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;
  logo: InlineImage | null;
};

export type ImportedSignature = {
  kind: 'imported';
  html: string;
  plaintext: string;
  image: InlineImage | null;
  importedAt: number;
};

export type SignatureData = StructuredSignature | ImportedSignature;

export type InlineImage = {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
};

export type RenderedSignature = {
  html: string;
  plaintext: string;
  image: { contentId: 'zolva-sig'; bytes: string; mimeType: 'image/png' | 'image/jpeg' } | null;
};

export type InlineAttachmentSpec = {
  filename: string;
  mimeType: string;
  contentBytes: string;
  contentId: string;
};

export const EMPTY_SIGNATURE: StructuredSignature = {
  kind: 'structured',
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

- [ ] **Step 2: Typecheck — expect failures**

```bash
npx tsc --noEmit
```

Expected: failures in `storage.ts`, `template.ts`, `build-outgoing-body.ts`, `SettingsScreen.tsx`, `import-from-screenshot.ts` because they don't yet narrow on `kind`. Do NOT fix them yet — they're fixed in later tasks. Confirm the failures are about missing `kind`/property access and not anything else (e.g., a typo in the new types file).

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/types.ts
git commit -m "feat(mail-signature): discriminated-union types for structured vs imported"
```

NOTE: the project is in a "broken typecheck" state for the duration of Tasks 1-7. Each subsequent task fixes one consumer at a time. After Task 7, typecheck must be green.

---

### Task 2: Storage migration + narrowing (TDD)

**Files:**
- Modify: `src/lib/mail-signature/__tests__/storage.test.ts` (extend with new cases)
- Modify: `src/lib/mail-signature/storage.ts`

The discriminated-union types break `loadFromStorage` (which spreads `EMPTY_SIGNATURE` over arbitrary parsed JSON). Make migration explicit so legacy entries (no `kind` field) load as `'structured'`, and `'imported'` entries round-trip cleanly.

- [ ] **Step 1: Add the failing migration tests**

Read `src/lib/mail-signature/__tests__/storage.test.ts` first to find the existing test scaffolding (mocks, helpers, the closing `});` of the outer scope). Append a new `describe` block at the bottom inside the same outer scope:

```ts
describe('loadSignature — discriminated-union migration', () => {
  beforeEach(async () => {
    __resetForTests();
    __setCurrentUserForTests('uid-disc');
    await AsyncStorage.clear();
  });

  it('legacy v2 entry without kind loads as structured', async () => {
    await AsyncStorage.setItem(
      'zolva.mail.signature.v2.uid-disc',
      JSON.stringify({
        name: 'Albert', title: '', company: '', phone: '', email: '',
        website: '', customLines: '', logo: null,
      }),
    );
    const sig = await loadSignature('uid-disc');
    expect(sig).toEqual({
      kind: 'structured',
      name: 'Albert', title: '', company: '', phone: '', email: '',
      website: '', customLines: '', logo: null,
    });
  });

  it('imported signature round-trips through save/load', async () => {
    const imported: SignatureData = {
      kind: 'imported',
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: null,
      importedAt: 1700000000000,
    };
    __setCurrentUserForTests('uid-disc');
    await saveSignature(imported);
    __resetForTests();
    __setCurrentUserForTests('uid-disc');
    const loaded = await loadSignature('uid-disc');
    expect(loaded).toEqual(imported);
  });

  it('v1 plaintext migration produces a structured entry', async () => {
    await AsyncStorage.setItem('zolva.mail.signature.uid-disc', 'Med venlig hilsen\nAlbert');
    const sig = await loadSignature('uid-disc');
    expect(sig?.kind).toBe('structured');
    if (sig?.kind === 'structured') {
      expect(sig.customLines).toBe('Med venlig hilsen\nAlbert');
    }
  });
});
```

(Note: `__resetForTests` and `__setCurrentUserForTests` are existing test hooks in `storage.ts`. Use whatever import statements already exist at the top of the test file — `loadSignature`, `saveSignature`, `__resetForTests`, `__setCurrentUserForTests` are all already imported there.)

- [ ] **Step 2: Run the new tests — observe**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts -t "discriminated-union migration"
```

Expected: imported round-trip test fails (legacy v2 might already pass because of the way EMPTY_SIGNATURE spreads). The point of Step 3 is to make the migration explicit regardless.

- [ ] **Step 3: Make the migration explicit in `loadFromStorage`**

In `src/lib/mail-signature/storage.ts`, find the `loadFromStorage` function and replace its v2 branch with:

```ts
  const v2Raw = await AsyncStorage.getItem(v2Key(uid));
  if (v2Raw !== null) {
    try {
      const parsed = JSON.parse(v2Raw) as Partial<SignatureData> & { kind?: 'structured' | 'imported' };
      if (parsed.kind === 'imported') {
        return {
          kind: 'imported',
          html: typeof parsed.html === 'string' ? parsed.html : '',
          plaintext: typeof parsed.plaintext === 'string' ? parsed.plaintext : '',
          image: parsed.image ?? null,
          importedAt: typeof parsed.importedAt === 'number' ? parsed.importedAt : 0,
        };
      }
      // 'structured' OR missing kind (legacy v2 from before this feature)
      return { ...EMPTY_SIGNATURE, ...parsed, kind: 'structured' };
    } catch (err) {
      console.warn('[mail-signature] malformed v2 json, treating as no signature:', err);
      return null;
    }
  }
```

This makes the intent explicit: legacy entries → `'structured'`; `'imported'` entries → preserved as-is.

- [ ] **Step 4: Re-run the storage tests**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts
```

Expected: all storage tests PASS (existing + 3 new).

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: still failing (in template.ts, build-outgoing-body.ts, SettingsScreen.tsx, import-from-screenshot.ts) but storage.ts errors should be gone.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/storage.ts src/lib/mail-signature/__tests__/storage.test.ts
git commit -m "feat(mail-signature): storage migration for discriminated-union signatures"
```

---

### Task 3: HTML sanitizer (`sanitize.ts`) with TDD

**Files:**
- Create: `src/lib/mail-signature/__tests__/sanitize.test.ts`
- Create: `src/lib/mail-signature/sanitize.ts`

A pure tag/attr/style allowlist filter. No DOM dependency. Single export `sanitizeSignatureHtml(input: unknown): string`.

- [ ] **Step 1: Write the failing test file**

Create `src/lib/mail-signature/__tests__/sanitize.test.ts`:

```ts
// src/lib/mail-signature/__tests__/sanitize.test.ts
import { sanitizeSignatureHtml } from '../sanitize';

describe('sanitizeSignatureHtml — basic input handling', () => {
  it('returns empty string for null/undefined/non-string input', () => {
    expect(sanitizeSignatureHtml(null as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml(undefined as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml(42 as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml({} as unknown as string)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeSignatureHtml('')).toBe('');
  });

  it('preserves plain text without tags', () => {
    expect(sanitizeSignatureHtml('Albert Hangaard')).toBe('Albert Hangaard');
  });

  it('preserves HTML entities', () => {
    expect(sanitizeSignatureHtml('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
  });
});

describe('sanitizeSignatureHtml — tag allowlist', () => {
  it('keeps allowed structural tags', () => {
    const input = '<table><tr><td><div><span>Hi</span></div></td></tr></table>';
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain('<table>');
    expect(out).toContain('<span>');
  });

  it('keeps anchor and image and inline-format tags', () => {
    const input = '<a href="mailto:a@b.dk">x</a><img src="cid:zolva-sig"><b>x</b><strong>x</strong><i>x</i><em>x</em><br><hr>';
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain('<a ');
    expect(out).toContain('<img');
    expect(out).toContain('<b>');
    expect(out).toContain('<br>');
    expect(out).toContain('<hr>');
  });

  it('strips disallowed tags including their inner content', () => {
    expect(sanitizeSignatureHtml('<script>alert(1)</script>x')).not.toContain('<script>');
    expect(sanitizeSignatureHtml('<script>alert(1)</script>x')).toContain('x');
    expect(sanitizeSignatureHtml('<style>body{}</style>x')).not.toContain('<style>');
    expect(sanitizeSignatureHtml('<iframe src="x">x</iframe>')).not.toContain('<iframe');
    expect(sanitizeSignatureHtml('<object data="x"></object>')).not.toContain('<object');
    expect(sanitizeSignatureHtml('<svg><script>x</script></svg>')).not.toContain('<svg');
  });

  it('strips inner content of stripped tags', () => {
    const out = sanitizeSignatureHtml('<style>body{color:red}</style>visible');
    expect(out).not.toMatch(/body\{/);
    expect(out).toContain('visible');
  });

  it('strips HTML comments', () => {
    expect(sanitizeSignatureHtml('<!--evil-->ok')).toBe('ok');
  });

  it('strips DOCTYPE', () => {
    expect(sanitizeSignatureHtml('<!DOCTYPE html>x')).toBe('x');
  });
});

describe('sanitizeSignatureHtml — href and src URL schemes', () => {
  it('keeps mailto href', () => {
    expect(sanitizeSignatureHtml('<a href="mailto:a@b.dk">x</a>')).toContain('href="mailto:a@b.dk"');
  });

  it('keeps tel href', () => {
    expect(sanitizeSignatureHtml('<a href="tel:+4512345678">x</a>')).toContain('href="tel:+4512345678"');
  });

  it('keeps http and https href', () => {
    expect(sanitizeSignatureHtml('<a href="https://zolva.io">x</a>')).toContain('href="https://zolva.io"');
    expect(sanitizeSignatureHtml('<a href="http://zolva.io">x</a>')).toContain('href="http://zolva.io"');
  });

  it('strips javascript scheme href', () => {
    const out = sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript');
  });

  it('strips unknown scheme href', () => {
    const out = sanitizeSignatureHtml('<a href="data:text/html,abc">x</a>');
    expect(out).not.toContain('data:');
  });

  it('keeps cid:zolva-sig img src', () => {
    expect(sanitizeSignatureHtml('<img src="cid:zolva-sig">')).toContain('src="cid:zolva-sig"');
  });

  it('strips img with non-allowed src', () => {
    expect(sanitizeSignatureHtml('<img src="https://evil/x.png">')).not.toContain('src=');
    expect(sanitizeSignatureHtml('<img src="data:image/png;base64,AAA">')).not.toContain('src=');
    expect(sanitizeSignatureHtml('<img src="cid:other">')).not.toContain('src=');
  });
});

describe('sanitizeSignatureHtml — style attribute filtering', () => {
  it('keeps allowed CSS properties', () => {
    const out = sanitizeSignatureHtml('<div style="color:#1a1a1a;font-size:13px;text-align:left">x</div>');
    expect(out).toContain('color:#1a1a1a');
    expect(out).toContain('font-size:13px');
    expect(out).toContain('text-align:left');
  });

  it('strips disallowed CSS properties', () => {
    const out = sanitizeSignatureHtml('<div style="color:red;position:absolute;transform:rotate(5deg)">x</div>');
    expect(out).toContain('color:red');
    expect(out).not.toMatch(/position\s*:/);
    expect(out).not.toMatch(/transform\s*:/);
  });

  it('strips display:flex but keeps display:block and display:inline-block', () => {
    expect(sanitizeSignatureHtml('<div style="display:flex">x</div>')).not.toMatch(/display\s*:\s*flex/);
    expect(sanitizeSignatureHtml('<div style="display:block">x</div>')).toMatch(/display\s*:\s*block/);
    expect(sanitizeSignatureHtml('<div style="display:inline-block">x</div>')).toMatch(/display\s*:\s*inline-block/);
  });

  it('strips values containing url() with http schemes', () => {
    const out = sanitizeSignatureHtml('<div style="background-image:url(https://evil/x.png)">x</div>');
    expect(out).not.toMatch(/url\(/);
  });

  it('strips values containing dangerous tokens', () => {
    expect(sanitizeSignatureHtml('<div style="color:expression(alert(1))">x</div>')).not.toMatch(/expression/);
    expect(sanitizeSignatureHtml('<div style="background:javascript:foo">x</div>')).not.toContain('javascript');
    expect(sanitizeSignatureHtml('<div style="@import url(x)">x</div>')).not.toContain('@import');
  });

  it('collapses an empty style attribute', () => {
    const out = sanitizeSignatureHtml('<div style="position:absolute">x</div>');
    expect(out).not.toContain('style=""');
    expect(out).not.toContain('style=" "');
  });

  it('handles styles without trailing semicolon', () => {
    expect(sanitizeSignatureHtml('<div style="color:red">x</div>')).toContain('color:red');
  });
});

describe('sanitizeSignatureHtml — attribute allowlist per tag', () => {
  it('keeps table cellpadding/cellspacing/border', () => {
    const out = sanitizeSignatureHtml('<table cellpadding="0" cellspacing="0" border="0"><tr><td>x</td></tr></table>');
    expect(out).toContain('cellpadding="0"');
    expect(out).toContain('cellspacing="0"');
    expect(out).toContain('border="0"');
  });

  it('drops on* event handlers', () => {
    const out = sanitizeSignatureHtml('<div onclick="alert(1)" onmouseover="alert(2)">x</div>');
    expect(out).not.toMatch(/on(click|mouseover)/);
  });

  it('drops random unknown attributes', () => {
    const out = sanitizeSignatureHtml('<div data-evil="x" srcset="x">x</div>');
    expect(out).not.toContain('data-evil');
    expect(out).not.toContain('srcset');
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
npx jest src/lib/mail-signature/__tests__/sanitize.test.ts
```

Expected: FAIL with "Cannot find module '../sanitize'".

- [ ] **Step 3: Write `sanitize.ts`**

Create `src/lib/mail-signature/sanitize.ts`:

```ts
// src/lib/mail-signature/sanitize.ts
//
// Pure HTML/CSS allowlist filter for screenshot-imported signatures.
// Hand-rolled tokenizer (no DOM dependency — DOMPurify wants window).
// Output is guaranteed to be a strict Outlook-Word-rendering-engine-safe
// subset: <table> layout, inline styles, allowlisted attrs, allowlisted
// CSS properties, mailto/tel/https/http links, cid:zolva-sig images only.

const TAG_ALLOWLIST = new Set([
  'table', 'tr', 'td', 'tbody', 'thead', 'tfoot',
  'div', 'span', 'p', 'br', 'hr',
  'b', 'strong', 'i', 'em', 'u',
  'a', 'img',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'font',
]);

// Tags whose entire content (including text inside) gets dropped.
const STRIP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'noscript',
]);

const ATTR_ALLOWLIST: Record<string, Set<string>> = {
  table: new Set(['cellpadding', 'cellspacing', 'border', 'align', 'valign', 'bgcolor', 'width', 'height']),
  tr: new Set(['align', 'valign', 'bgcolor', 'width', 'height']),
  td: new Set(['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan']),
  a: new Set(['href', 'target']),
  img: new Set(['src', 'alt', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
};

const HREF_SCHEME_RE = /^(mailto:|tel:|https?:\/\/)/i;
const IMG_SRC_OK = 'cid:zolva-sig';

const STYLE_PROP_ALLOWLIST_RE =
  /^(font-(family|size|weight|style|variant)|color|background-color|text-align|text-decoration|padding(-\w+)?|margin(-\w+)?|border(-\w+)?(-\w+)?|line-height|vertical-align|white-space|display)$/;

function isDangerousStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes('expression(') ||
    lower.includes('javascript:') ||
    lower.includes('@import') ||
    /url\s*\(\s*['"]?https?:/.test(lower) ||
    lower.includes('<') ||
    lower.includes('>')
  );
}

function filterStyleAttr(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const prop = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!STYLE_PROP_ALLOWLIST_RE.test(prop)) continue;
    if (isDangerousStyleValue(value)) continue;
    if (prop === 'display') {
      const v = value.toLowerCase();
      if (v !== 'block' && v !== 'inline-block') continue;
    }
    out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'open'; tag: string; attrs: string }
  | { kind: 'close'; tag: string }
  | { kind: 'self'; tag: string; attrs: string }
  | { kind: 'comment' }
  | { kind: 'doctype' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '<') {
      // Comment
      if (input.startsWith('<!--', i)) {
        const end = input.indexOf('-->', i + 4);
        i = end < 0 ? input.length : end + 3;
        tokens.push({ kind: 'comment' });
        continue;
      }
      // DOCTYPE / processing instruction / CDATA
      if (input[i + 1] === '!' || input[i + 1] === '?') {
        const end = input.indexOf('>', i);
        i = end < 0 ? input.length : end + 1;
        tokens.push({ kind: 'doctype' });
        continue;
      }
      // Closing tag
      if (input[i + 1] === '/') {
        const end = input.indexOf('>', i);
        if (end < 0) { i = input.length; continue; }
        const tag = input.slice(i + 2, end).trim().toLowerCase();
        i = end + 1;
        tokens.push({ kind: 'close', tag });
        continue;
      }
      // Open or self-closing tag
      const end = input.indexOf('>', i);
      if (end < 0) {
        tokens.push({ kind: 'text', raw: input.slice(i) });
        i = input.length;
        continue;
      }
      const inner = input.slice(i + 1, end).trim();
      const selfClose = inner.endsWith('/');
      const head = selfClose ? inner.slice(0, -1).trim() : inner;
      const spaceIdx = head.search(/\s/);
      const tag = (spaceIdx < 0 ? head : head.slice(0, spaceIdx)).toLowerCase();
      const attrs = spaceIdx < 0 ? '' : head.slice(spaceIdx + 1);
      i = end + 1;
      if (selfClose || tag === 'br' || tag === 'hr' || tag === 'img') {
        tokens.push({ kind: 'self', tag, attrs });
      } else {
        tokens.push({ kind: 'open', tag, attrs });
      }
      continue;
    }
    // Text run
    const next = input.indexOf('<', i);
    if (next < 0) {
      tokens.push({ kind: 'text', raw: input.slice(i) });
      i = input.length;
    } else {
      tokens.push({ kind: 'text', raw: input.slice(i, next) });
      i = next;
    }
  }
  return tokens;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[name] = value;
  }
  return out;
}

function serializeAttrs(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === '') {
      parts.push(name);
    } else {
      parts.push(`${name}="${value.replaceAll('"', '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function filterAttrs(tag: string, raw: string): Record<string, string> {
  const parsed = parseAttrs(raw);
  const allowed = ATTR_ALLOWLIST[tag] ?? new Set<string>();
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(parsed)) {
    if (name.startsWith('on')) continue;
    if (name === 'style') {
      const filtered = filterStyleAttr(value);
      if (filtered) out.style = filtered;
      continue;
    }
    if (!allowed.has(name)) continue;

    if (tag === 'a' && name === 'href') {
      if (HREF_SCHEME_RE.test(value)) out.href = value;
      continue;
    }
    if (tag === 'a' && name === 'target') {
      if (value === '_blank') out.target = value;
      continue;
    }
    if (tag === 'img' && name === 'src') {
      if (value === IMG_SRC_OK) out.src = value;
      continue;
    }

    out[name] = value;
  }
  return out;
}

export function sanitizeSignatureHtml(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  const tokens = tokenize(input);
  const out: string[] = [];
  let dropDepth = 0;
  let dropTag = '';

  for (const tok of tokens) {
    if (dropDepth > 0) {
      if (tok.kind === 'close' && tok.tag === dropTag) {
        dropDepth = 0;
        dropTag = '';
      } else if (tok.kind === 'open' && tok.tag === dropTag) {
        dropDepth++;
      }
      continue;
    }

    if (tok.kind === 'comment' || tok.kind === 'doctype') continue;

    if (tok.kind === 'text') {
      out.push(tok.raw);
      continue;
    }

    if (tok.kind === 'open' || tok.kind === 'self') {
      if (STRIP_WITH_CONTENT.has(tok.tag)) {
        if (tok.kind === 'open') {
          dropDepth = 1;
          dropTag = tok.tag;
        }
        continue;
      }
      if (!TAG_ALLOWLIST.has(tok.tag)) continue;
      const attrs = filterAttrs(tok.tag, tok.attrs);
      // For img, if src didn't pass, drop the whole tag
      if (tok.tag === 'img' && !attrs.src) continue;
      const serialized = serializeAttrs(attrs);
      out.push(`<${tok.tag}${serialized}>`);
      continue;
    }

    if (tok.kind === 'close') {
      if (!TAG_ALLOWLIST.has(tok.tag)) continue;
      out.push(`</${tok.tag}>`);
      continue;
    }
  }

  return out.join('');
}
```

- [ ] **Step 4: Run the tests — confirm they pass**

```bash
npx jest src/lib/mail-signature/__tests__/sanitize.test.ts
```

Expected: all sanitize tests PASS (~28 across the describes).

If any fail, fix the implementation — do NOT relax the tests.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
npx jest
```

Expected: 47 baseline + new sanitize tests pass. Storage tests pass. Import-from-screenshot tests still pass (still using the v1 12 tests at this point).

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/sanitize.ts src/lib/mail-signature/__tests__/sanitize.test.ts
git commit -m "feat(mail-signature): outlook-safe HTML/CSS allowlist sanitizer"
```

---

### Task 4: `completeWithTool<T>` helper in `claude.ts` (TDD)

**Files:**
- Modify: `src/lib/claude.ts` (append a new exported function)
- Create: `src/lib/__tests__/claude-tool.test.ts`

A thin wrapper that calls `completeRaw`, finds a single tool_use block matching the requested tool name, and returns its `input` (typed as `T`). On a missing/wrong tool_use → throw `Error`. Callers catch and route through `mapClaudeError` → `parse-failed`.

- [ ] **Step 1: Write the failing test file**

Create `src/lib/__tests__/claude-tool.test.ts`:

```ts
// src/lib/__tests__/claude-tool.test.ts
//
// Tests the parsing layer of completeWithTool by mocking completeRaw.

jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
jest.mock('../profile', () => ({ buildProfilePreamble: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn().mockReturnValue(false) }));

import * as claude from '../claude';

describe('completeWithTool', () => {
  const TOOL = {
    name: 'extract',
    description: 'Extract things',
    input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the matching tool_use input', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'extract', input: { x: 'hello' } }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    const out = await claude.completeWithTool<{ x: string }>({
      maxTokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tool: TOOL,
    });
    expect(out).toEqual({ x: 'hello' });
  });

  it('throws when no tool_use is present', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: 'sorry',
      toolUses: [],
      stopReason: 'end_turn',
      rawContent: [],
    });
    await expect(
      claude.completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/no tool_use/);
  });

  it('throws when the wrong tool is invoked', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'something_else', input: {} }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    await expect(
      claude.completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/wrong tool/);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

```bash
npx jest src/lib/__tests__/claude-tool.test.ts
```

Expected: FAIL with "completeWithTool is not a function" (TypeScript may also error).

- [ ] **Step 3: Append `completeWithTool` to `src/lib/claude.ts`**

At the bottom of `src/lib/claude.ts` (after the existing `completeJson` function), append:

```ts
// Force a single tool_use response and return its parsed input. Use this
// instead of completeJson when the caller wants a guaranteed structured
// shape (Anthropic's tool-use is more reliable than JSON-mode for vision +
// extraction tasks). Throws on missing or wrong tool_use — callers should
// route the error through mapClaudeError to surface 'parse-failed'.
export async function completeWithTool<T>(opts: {
  system: CompleteOptions['system'];
  messages: ClaudeMessage[];
  maxTokens: number;
  temperature?: number;
  tool: ClaudeToolSchema;
  attachProfile?: boolean;
  model?: string;
}): Promise<T> {
  const result = await completeRaw({
    system: opts.system,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    tools: [opts.tool],
    attachProfile: opts.attachProfile,
    model: opts.model,
  });

  if (result.toolUses.length === 0) {
    throw new Error(`completeWithTool: no tool_use in response (stop_reason=${result.stopReason})`);
  }
  const match = result.toolUses.find((u) => u.name === opts.tool.name);
  if (!match) {
    throw new Error(
      `completeWithTool: wrong tool invoked (got ${result.toolUses[0].name}, expected ${opts.tool.name})`,
    );
  }
  return match.input as T;
}
```

- [ ] **Step 4: Run the test — confirm it passes**

```bash
npx jest src/lib/__tests__/claude-tool.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude.ts src/lib/__tests__/claude-tool.test.ts
git commit -m "feat(claude): completeWithTool wrapper for forced tool-use responses"
```

---

### Task 5: New orchestrator + replace import-from-screenshot module body

**Files:**
- Modify: `src/lib/mail-signature/import-from-screenshot.ts` (replace orchestrator + types; keep reused error helpers)
- Modify: `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts` (drop validateExtracted tests, add parseImportToolUse tests)

`pickAndExtractSignature`, `validateExtracted`, and `ExtractedSignatureFields` are gone. New: `pickAndImportSignature` (orchestrator, manual smoke only) and `parseImportToolUse` (pure validator, TDD). `mapClaudeError` and `importResultMessage` stay.

- [ ] **Step 1: Update the test file**

Replace the entire contents of `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts` with:

```ts
// src/lib/mail-signature/__tests__/import-from-screenshot.test.ts

jest.mock('../../claude', () => {
  class ClaudeRateLimitErrorMock extends Error {
    readonly retryAfterSec: number;
    readonly reason: 'rpm' | 'daily';
    constructor(retryAfterSec: number, reason: 'rpm' | 'daily') {
      super('rate limit');
      this.name = 'ClaudeRateLimitError';
      this.retryAfterSec = retryAfterSec;
      this.reason = reason;
    }
  }
  class ClaudeConfigErrorMock extends Error {
    constructor() {
      super('config');
      this.name = 'ClaudeConfigError';
    }
  }
  return {
    ClaudeRateLimitError: ClaudeRateLimitErrorMock,
    ClaudeConfigError: ClaudeConfigErrorMock,
    completeWithTool: jest.fn(),
  };
});

import {
  parseImportToolUse,
  mapClaudeError,
  importResultMessage,
} from '../import-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('parseImportToolUse', () => {
  const ok = {
    html: '<table><tr><td>Hi</td></tr></table>',
    plaintext: 'Hi',
    logoBox: null,
  };

  it('accepts a valid no-logo response', () => {
    expect(parseImportToolUse(ok)).toEqual({ ok: true, value: ok });
  });

  it('accepts a valid with-logo response', () => {
    const withLogo = { ...ok, logoBox: { x: 10, y: 20, w: 100, h: 50 } };
    expect(parseImportToolUse(withLogo)).toEqual({ ok: true, value: withLogo });
  });

  it('rejects missing html', () => {
    const bad = { plaintext: 'x', logoBox: null };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects missing plaintext', () => {
    const bad = { html: '<x>', logoBox: null };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects logoBox with non-number fields', () => {
    const bad = { ...ok, logoBox: { x: 'a', y: 0, w: 0, h: 0 } };
    expect(parseImportToolUse(bad)).toEqual({ ok: false });
  });

  it('rejects non-object inputs', () => {
    expect(parseImportToolUse(null)).toEqual({ ok: false });
    expect(parseImportToolUse('a string')).toEqual({ ok: false });
    expect(parseImportToolUse(42)).toEqual({ ok: false });
  });
});

describe('mapClaudeError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    expect(mapClaudeError(new ClaudeRateLimitError(60, 'rpm'))).toEqual({ ok: false, reason: 'rate-limit' });
  });

  it('maps ClaudeConfigError to unauthorized', () => {
    expect(mapClaudeError(new ClaudeConfigError())).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('maps a TypeError network failure to network', () => {
    expect(mapClaudeError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a generic Error to parse-failed', () => {
    expect(mapClaudeError(new Error('boom'))).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('maps unknown thrown values to parse-failed', () => {
    expect(mapClaudeError('string error')).toEqual({ ok: false, reason: 'parse-failed' });
    expect(mapClaudeError(undefined)).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('importResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(importResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(importResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(importResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(importResultMessage({ ok: false, reason: 'no-data' })).toContain('aflæse felter');
    expect(importResultMessage({ ok: false, reason: 'parse-failed' })).toContain('aflæse billedet');
    expect(importResultMessage({ ok: false, reason: 'network' })).toContain('forbindelse');
    expect(importResultMessage({ ok: false, reason: 'rate-limit' })).toContain('forsøg');
    expect(importResultMessage({ ok: false, reason: 'unauthorized' })).toContain('Log ind');
  });
});
```

- [ ] **Step 2: Run the test file**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: parseImportToolUse 6 tests fail (function not found); the 5 mapClaudeError + 1 importResultMessage still pass.

- [ ] **Step 3: Replace `import-from-screenshot.ts`**

Replace the entire contents of `src/lib/mail-signature/import-from-screenshot.ts` with:

```ts
// src/lib/mail-signature/import-from-screenshot.ts
//
// Vision-based signature import (HTML reproduction).
//
// Pipeline:
//   1. Pick image via expo-image-picker.
//   2. Resize to 1024px long side, JPEG q=0.85, base64.
//   3. Vision call via completeWithTool — Claude tool-use returns
//      { html, plaintext, logoBox }.
//   4. Sanitize html via sanitizeSignatureHtml.
//   5. Crop logo from the resized image at logoBox (sanity-checked).
//   6. Build ImportedSignature and return.
//
// Pure parts (parseImportToolUse, mapClaudeError, importResultMessage)
// are unit-tested. The orchestrator depends on Expo runtime + the live
// Claude call and is verified manually.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { ClaudeRateLimitError, ClaudeConfigError, completeWithTool } from '../claude';
import { sanitizeSignatureHtml } from './sanitize';
import type { ImportedSignature, InlineImage } from './types';

const VISION_MAX_DIMENSION = 1024;
const VISION_MAX_BASE64_LEN = 300_000;

const SIGNATURE_IMPORT_SYSTEM_PROMPT = `You reproduce the visual design of an email signature from a screenshot, as Outlook-safe HTML.

CRITICAL constraints — output that violates these will be sanitized away:
- Layout: use <table> elements only. No flexbox, grid, or modern positioning.
- Styling: inline style="..." attributes only. No <style>, <script>, <link>, <iframe>, no @import, no @font-face.
- Fonts: system stack only — e.g. font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif. No web fonts.
- Properties allowed: font-family, font-size, font-weight, font-style, color, background-color, text-align, text-decoration, padding, margin, border, line-height, vertical-align, white-space. Do not use position, transform, animation, opacity.
- URLs: <a href="..."> may use mailto:, tel:, https://, http://. <img> may ONLY be src="cid:zolva-sig" (we'll inject the cropped logo). No data: URIs, no remote URLs.

Reproduce the screenshot's visible content as faithfully as possible: text content, weights, italics, colors, alignment, dividers, and the visual structure (single line vs multi-line vs columns implemented as nested tables).

Return your output via the import_signature tool with three fields:
- html: the Outlook-safe HTML (typically wrapped in a <table>)
- plaintext: a plain-text version of the signature for multipart/alt
- logoBox: if a logo or photo is visible, an object { x, y, w, h } in pixel coordinates of the screenshot you were shown. If no logo/photo is visible, null.

If the screenshot doesn't appear to contain an email signature (e.g. it's a generic email body or unrelated content), return html: "", plaintext: "" and logoBox: null.`;

const IMPORT_TOOL = {
  name: 'import_signature',
  description: 'Output the reproduced signature HTML, plaintext fallback, and optional logo bounding box.',
  input_schema: {
    type: 'object',
    properties: {
      html: { type: 'string' },
      plaintext: { type: 'string' },
      logoBox: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
        ],
      },
    },
    required: ['html', 'plaintext', 'logoBox'],
  },
};

export type ImportResult =
  | { ok: true; data: ImportedSignature }
  | {
      ok: false;
      reason:
        | 'permission-denied'
        | 'cancelled'
        | 'too-large'
        | 'no-data'
        | 'parse-failed'
        | 'network'
        | 'rate-limit'
        | 'unauthorized';
    };

type ToolUseResult = {
  html: string;
  plaintext: string;
  logoBox: { x: number; y: number; w: number; h: number } | null;
};

type ParseOk = { ok: true; value: ToolUseResult };
type ParseFail = { ok: false };

export function parseImportToolUse(input: unknown): ParseOk | ParseFail {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.html !== 'string' || typeof obj.plaintext !== 'string') {
    return { ok: false };
  }
  let logoBox: ToolUseResult['logoBox'] = null;
  if (obj.logoBox !== null && obj.logoBox !== undefined) {
    if (typeof obj.logoBox !== 'object' || Array.isArray(obj.logoBox)) return { ok: false };
    const lb = obj.logoBox as Record<string, unknown>;
    if (
      typeof lb.x !== 'number' ||
      typeof lb.y !== 'number' ||
      typeof lb.w !== 'number' ||
      typeof lb.h !== 'number'
    ) {
      return { ok: false };
    }
    logoBox = { x: lb.x, y: lb.y, w: lb.w, h: lb.h };
  }
  return { ok: true, value: { html: obj.html, plaintext: obj.plaintext, logoBox } };
}

export function mapClaudeError(err: unknown): ImportResult {
  if (err instanceof ClaudeRateLimitError) return { ok: false, reason: 'rate-limit' };
  if (err instanceof ClaudeConfigError) return { ok: false, reason: 'unauthorized' };
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
  return { ok: false, reason: 'parse-failed' };
}

export function importResultMessage(result: Extract<ImportResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at importere fra screenshot.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'no-data':           return 'Vi kunne ikke aflæse felter fra dette billede. Prøv et tydeligere screenshot.';
    case 'parse-failed':      return 'Vi kunne ikke aflæse billedet. Prøv igen eller udfyld manuelt.';
    case 'network':           return 'Ingen forbindelse. Prøv igen.';
    case 'rate-limit':        return 'For mange forsøg. Prøv igen om lidt.';
    case 'unauthorized':      return 'Log ind igen for at importere.';
  }
}

function isImplausibleBox(box: { x: number; y: number; w: number; h: number }, imgW: number, imgH: number): boolean {
  if (box.w <= 0 || box.h <= 0) return true;
  if (box.x < 0 || box.y < 0) return true;
  if (box.x + box.w > imgW || box.y + box.h > imgH) return true;
  if (box.w * box.h > 0.5 * imgW * imgH) return true;
  return false;
}

async function cropLogo(
  resizedUri: string,
  imgW: number,
  imgH: number,
  box: { x: number; y: number; w: number; h: number },
): Promise<InlineImage | null> {
  if (isImplausibleBox(box, imgW, imgH)) return null;
  try {
    const cropped = await manipulateAsync(
      resizedUri,
      [{ crop: { originX: box.x, originY: box.y, width: box.w, height: box.h } }],
      { format: SaveFormat.PNG, base64: true },
    );
    if (!cropped.base64) return null;
    return {
      base64: cropped.base64,
      mimeType: 'image/png',
      width: Math.round(box.w),
      height: Math.round(box.h),
    };
  } catch {
    return null;
  }
}

export async function pickAndImportSignature(): Promise<ImportResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'permission-denied' };

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'] as ImagePicker.MediaType[],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) {
    return { ok: false, reason: 'cancelled' };
  }

  const asset = picked.assets[0];
  let base64: string;
  let resizedUri: string | null = null;
  let resizedWidth = 0;
  let resizedHeight = 0;
  try {
    const longSide = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longSide > VISION_MAX_DIMENSION ? VISION_MAX_DIMENSION / longSide : 1;
    const targetWidth = Math.round((asset.width ?? VISION_MAX_DIMENSION) * scale);
    const targetHeight = Math.round((asset.height ?? VISION_MAX_DIMENSION) * scale);

    const manipulated = await manipulateAsync(
      asset.uri,
      [{ resize: { width: targetWidth, height: targetHeight } }],
      { compress: 0.85, format: SaveFormat.JPEG, base64: true },
    );
    resizedUri = manipulated.uri;
    resizedWidth = manipulated.width ?? targetWidth;
    resizedHeight = manipulated.height ?? targetHeight;
    base64 = manipulated.base64 ?? '';
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  if (!base64 || !resizedUri) return { ok: false, reason: 'parse-failed' };
  if (base64.length > VISION_MAX_BASE64_LEN) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'too-large' };
  }

  let toolInput: unknown;
  try {
    toolInput = await completeWithTool<unknown>({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 2000,
      system: SIGNATURE_IMPORT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Reproduce this signature using the import_signature tool.' },
          ],
        },
      ],
      tool: IMPORT_TOOL,
      attachProfile: false,
    });
  } catch (err) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return mapClaudeError(err);
  }

  const parsed = parseImportToolUse(toolInput);
  if (!parsed.ok) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'parse-failed' };
  }

  const sanitized = sanitizeSignatureHtml(parsed.value.html);
  if (!sanitized) {
    try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}
    return { ok: false, reason: 'no-data' };
  }

  let image: InlineImage | null = null;
  if (parsed.value.logoBox) {
    image = await cropLogo(resizedUri, resizedWidth, resizedHeight, parsed.value.logoBox);
  }

  try { await FileSystem.deleteAsync(resizedUri, { idempotent: true }); } catch {}

  const data: ImportedSignature = {
    kind: 'imported',
    html: sanitized,
    plaintext: parsed.value.plaintext,
    image,
    importedAt: Date.now(),
  };
  return { ok: true, data };
}
```

- [ ] **Step 4: Run the test file — confirm it passes**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: 6 (parseImportToolUse) + 5 (mapClaudeError) + 1 (importResultMessage) = 12 tests PASS.

- [ ] **Step 5: Run all tests**

```bash
npx jest
```

Expected: storage, sanitize, claude-tool, and these new tests pass. The remaining tests in template + build-outgoing-body suites still pass (their `SignatureData` references compile because `EMPTY_SIGNATURE` is `StructuredSignature`, which is a subtype of the union — but the type errors get fully resolved in Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/import-from-screenshot.ts src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
git commit -m "feat(mail-signature): replace orchestrator with HTML import via tool-use"
```

---

### Task 6: `template.ts` + `build-outgoing-body.ts` branch on `kind` (TDD on the build helper)

**Files:**
- Modify: `src/lib/mail-signature/template.ts` (narrow `renderSignature` to `StructuredSignature`; add `renderImported`)
- Modify: `src/lib/mail-signature/build-outgoing-body.ts` (branch on `kind`)
- Modify: `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts` (add cases for the imported branch)

`renderSignature` currently typechecks against the union and accesses `.name`, `.title`, etc. After Task 1 it stops compiling. Narrow its parameter type to `StructuredSignature` and add `renderImported(sig: ImportedSignature)`.

- [ ] **Step 1: Update `template.ts`**

Open `src/lib/mail-signature/template.ts`. Change the `import` at the top to:

```ts
import type { ImportedSignature, RenderedSignature, StructuredSignature } from './types';
```

Find `function renderPlaintext(data: SignatureData)` and change its parameter type to `StructuredSignature`.

Find `export function renderSignature(data: SignatureData): RenderedSignature | null` and change its parameter type to `StructuredSignature`.

After `renderSignature`, add:

```ts
export function renderImported(sig: ImportedSignature): RenderedSignature | null {
  if (!sig.html.trim() && !sig.image) return null;
  return {
    html: sig.html,
    plaintext: sig.plaintext,
    image: sig.image
      ? { contentId: 'zolva-sig', bytes: sig.image.base64, mimeType: sig.image.mimeType }
      : null,
  };
}
```

- [ ] **Step 2: Update the build-outgoing-body test file**

Read `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts` first to see how `loadSignature` is mocked — likely via `jest.mock('../storage', ...)` with a settable variable, or via `jest.spyOn(...)` on a re-imported module. Use that exact pattern below.

Append a new `describe` block at the end of the test file:

```ts
describe('buildOutgoingBody — imported signatures', () => {
  // Uses whatever loadSignature mock pattern the existing tests use.

  it('returns html with the imported signature appended and logo as attachment', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: { base64: 'AAAA', mimeType: 'image/png' as const, width: 100, height: 50 },
      importedAt: 1700000000000,
    };
    // PRIME loadSignature MOCK with `imported` — adapt to existing pattern.
    const out = await buildOutgoingBody('Hello world');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('<table>');
    expect(out.content).toContain('Hi');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].contentId).toBe('zolva-sig');
    expect(out.attachments[0].mimeType).toBe('image/png');
  });

  it('returns html with no attachments when imported signature has no logo', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: null,
      importedAt: 1700000000000,
    };
    // PRIME loadSignature MOCK with `imported`
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.attachments).toHaveLength(0);
  });

  it('returns text when imported signature has empty html and no image', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '',
      plaintext: '',
      image: null,
      importedAt: 1700000000000,
    };
    // PRIME loadSignature MOCK with `imported`
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('text');
    expect(out.attachments).toHaveLength(0);
  });
});
```

Replace the `// PRIME loadSignature MOCK with imported` comments with the actual mock setup matching the existing tests' pattern.

- [ ] **Step 3: Run the tests — confirm new ones fail**

```bash
npx jest src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: 3 new tests fail (the imported branch isn't implemented yet).

- [ ] **Step 4: Update `build-outgoing-body.ts`**

Replace the body of `src/lib/mail-signature/build-outgoing-body.ts` with:

```ts
// src/lib/mail-signature/build-outgoing-body.ts
//
// Provider-agnostic body+attachments builder. Branches on signature.kind:
// 'structured' goes through the existing template.ts pipeline, 'imported'
// uses the pre-sanitized html directly.

import { loadSignature } from './storage';
import { bodyToParagraphs, renderImported, renderSignature } from './template';
import type { InlineAttachmentSpec, RenderedSignature } from './types';

export type OutgoingBody = {
  contentType: 'text' | 'html';
  content: string;
  attachments: InlineAttachmentSpec[];
};

export async function buildOutgoingBody(rawBody: string): Promise<OutgoingBody> {
  const data = await loadSignature();
  let rendered: RenderedSignature | null = null;
  if (data) {
    rendered = data.kind === 'imported' ? renderImported(data) : renderSignature(data);
  }

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

- [ ] **Step 5: Run the tests — confirm they pass**

```bash
npx jest src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: all build-outgoing-body tests PASS (existing + 3 new).

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: errors should now be confined to `SettingsScreen.tsx`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mail-signature/template.ts src/lib/mail-signature/build-outgoing-body.ts src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
git commit -m "feat(mail-signature): build-outgoing-body branches on signature kind"
```

---

### Task 7: Mode-aware `MailSignatureSection` in Settings

**Files:**
- Modify: `src/screens/SettingsScreen.tsx` (the `MailSignatureSection` component)

This task is large but mechanical. After it, the component branches on `data.kind`: structured mode shows the existing form + import button; imported mode shows a WebView preview + "Importér nyt screenshot" + "Skift til manuel redigering" (with confirmation prompt).

The button's `onPress` switches from `pickAndExtractSignature` → `pickAndImportSignature`, and the success path swaps the form-overwrite logic for `setData(result.data)` (the new ImportResult returns a fully-formed `ImportedSignature`).

- [ ] **Step 1: Update the imports**

In `src/screens/SettingsScreen.tsx`, find the `from '../lib/mail-signature'` import block and replace it with:

```ts
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  pickAndImportSignature,
  importResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
  type StructuredSignature,
} from '../lib/mail-signature';
```

(Removed: `pickAndExtractSignature`. Added: `pickAndImportSignature`, `StructuredSignature`.)

Verify `WebView` and `Alert` are imported. If not, add them. `WebView` is from `react-native-webview` (verify it's in `package.json` first); `Alert` is from `react-native`.

- [ ] **Step 2: Replace `onImportFromScreenshot`**

Find the existing `onImportFromScreenshot` handler in `MailSignatureSection` and replace with:

```ts
  const onImportFromScreenshot = async () => {
    setImportError(null);
    setImporting(true);
    try {
      const result = await pickAndImportSignature();
      if (!result.ok) {
        const msg = importResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      setData(result.data);
      void saveSignature(result.data);
    } finally {
      setImporting(false);
    }
  };
```

(Note: the `try/finally` improvement is the one the final code-reviewer flagged in the previous pass. It's correct here because the orchestrator's contract is "no throw," but `finally` is belt-and-suspenders.)

Add a new handler for switching back to manual:

```ts
  const onSwitchToManual = () => {
    Alert.alert(
      'Skift til manuel redigering?',
      'Dit importerede design slettes.',
      [
        { text: 'Annuller', style: 'cancel' },
        {
          text: 'Skift',
          style: 'destructive',
          onPress: () => {
            setData(EMPTY_SIGNATURE);
            void saveSignature(EMPTY_SIGNATURE);
          },
        },
      ],
    );
  };
```

- [ ] **Step 3: Narrow structured-only logic**

Find `const update = (patch: Partial<SignatureData>) => {` and change it to:

```ts
  const update = (patch: Partial<StructuredSignature>) => {
    setData((prev) => {
      if (prev.kind !== 'structured') return prev;
      const next = { ...prev, ...patch };
      void saveSignature(next);
      return next;
    });
  };
```

Find `onPickLogo` and `onRemoveLogo` and add a guard at the top of each:

```ts
    if (data.kind !== 'structured') return;
```

Find `const rendered = renderSignature(data);` and change to:

```ts
  const rendered = data.kind === 'structured' ? renderSignature(data) : null;
```

- [ ] **Step 4: Render mode-aware JSX**

Find the JSX returned by `MailSignatureSection`. After the existing intro `<Text style={styles.signatureBody}>` paragraph, the current import button + form fields render. Restructure so the import button stays at the top (always visible) and the structured/imported branches render below it. Conceptually:

```tsx
      <Text style={styles.signatureBody}>...</Text>

      <Pressable
        onPress={onImportFromScreenshot}
        disabled={importing}
        style={[styles.sigImportBtn, importing && { opacity: 0.5 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sigImportBtnTitle}>
          {importing ? 'Læser signatur…' : '📷 Importér fra screenshot'}
        </Text>
        <Text style={styles.sigImportBtnSub}>
          Lad Zolva udfylde felterne fra et billede af din nuværende signatur.
        </Text>
      </Pressable>
      {importError && <Text style={styles.sigError}>{importError}</Text>}

      {data.kind === 'structured' ? (
        <>
          {/* Existing structured-mode JSX: SigField components, logo
              picker, signature preview, etc. — keep verbatim from today. */}
        </>
      ) : (
        <View style={styles.sigImportedPreviewWrap}>
          <View style={styles.sigImportedPreview}>
            <WebView
              originWhitelist={['*']}
              javaScriptEnabled={false}
              scrollEnabled={true}
              source={{ html: buildPreviewHtml(data) }}
              style={styles.sigImportedWebView}
            />
          </View>
          <Text style={styles.sigImportedCaption}>
            {`Importeret · ${formatImportedDate(data.importedAt)}`}
          </Text>
          <Pressable onPress={onSwitchToManual} style={styles.sigSwitchBtn} accessibilityRole="button">
            <Text style={styles.sigSwitchBtnText}>Skift til manuel redigering</Text>
          </Pressable>
        </View>
      )}
```

- [ ] **Step 5: Add the two helpers (file-local)**

Above `MailSignatureSection` in the same file, add:

```ts
function buildPreviewHtml(sig: { html: string; image: { base64: string; mimeType: 'image/png' | 'image/jpeg' } | null }): string {
  // Resolve cid:zolva-sig to a data URL so the WebView preview can render the
  // logo without an external load. The outgoing-mail path keeps cid: as-is —
  // this transformation is preview-only.
  const cidDataUrl = sig.image
    ? `data:${sig.image.mimeType};base64,${sig.image.base64}`
    : '';
  const html = sig.image
    ? sig.html.replaceAll('cid:zolva-sig', cidDataUrl)
    : sig.html;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;}</style></head><body>${html}</body></html>`;
}

function formatImportedDate(unixMs: number): string {
  if (!unixMs) return '';
  const d = new Date(unixMs);
  try {
    return new Intl.DateTimeFormat('da-DK', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
```

- [ ] **Step 6: Add the new style keys**

In the `StyleSheet.create({ ... })` block at the bottom of the file, add (alongside the other `sig*` keys):

```ts
sigImportedPreviewWrap: {
  marginTop: 16,
},
sigImportedPreview: {
  height: 180,
  borderRadius: 12,
  overflow: 'hidden',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  backgroundColor: '#fff',
},
sigImportedWebView: {
  flex: 1,
  backgroundColor: 'transparent',
},
sigImportedCaption: {
  marginTop: 8,
  fontSize: 12,
  color: colors.fg3,
},
sigSwitchBtn: {
  marginTop: 14,
  padding: 12,
  borderRadius: 12,
  backgroundColor: 'transparent',
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  alignItems: 'center',
},
sigSwitchBtnText: {
  fontSize: 14,
  fontWeight: '500',
  color: colors.ink,
},
```

- [ ] **Step 7: Typecheck + tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: typecheck exit 0 (clean across the project); all jest tests pass.

If `tsc` still errors, common spots:
- `data.name`, `data.title` etc. accessed without narrowing → wrap in `if (data.kind === 'structured')`.
- `<SignaturePreview data={...}>` — narrow the prop type to `StructuredSignature` and pass `data` only inside the structured-mode branch.

- [ ] **Step 8: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(mail-signature): mode-aware settings UI for imported signatures"
```

---

### Task 8: Public API barrel + dead-export cleanup

**Files:**
- Modify: `src/lib/mail-signature/index.ts`

- [ ] **Step 1: Replace `index.ts`**

Replace the contents of `src/lib/mail-signature/index.ts` with:

```ts
// src/lib/mail-signature/index.ts
//
// Public API for the rich mail signature module. Internal files import
// from each other directly; everywhere else imports from this barrel.

export type {
  SignatureData,
  StructuredSignature,
  ImportedSignature,
  InlineImage,
  RenderedSignature,
  InlineAttachmentSpec,
} from './types';
export { EMPTY_SIGNATURE } from './types';
export { loadSignature, saveSignature, subscribeSignature } from './storage';
export { renderSignature, renderImported } from './template';
export { buildOutgoingBody } from './build-outgoing-body';
export type { OutgoingBody } from './build-outgoing-body';
export { pickAndCompressLogo, pickResultMessage } from './image';
export type { PickResult } from './image';
export {
  pickAndImportSignature,
  importResultMessage,
} from './import-from-screenshot';
export type { ImportResult } from './import-from-screenshot';
export { sanitizeSignatureHtml } from './sanitize';
```

(Removed: `pickAndExtractSignature`, `ExtractedSignatureFields`. Added: `StructuredSignature`, `ImportedSignature`, `pickAndImportSignature`, `renderImported`, `sanitizeSignatureHtml`.)

- [ ] **Step 2: Typecheck + tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: typecheck 0; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/index.ts
git commit -m "feat(mail-signature): publish HTML-import API from barrel"
```

---

### Task 9: Manual smoke-test pass (verification only — no code changes)

- [ ] **Step 1: Start dev build**

```bash
npx expo start --clear --dev-client
```

Open in a connected dev build (not Expo Go — `feedback_expo_go_limits` memory).

- [ ] **Step 2: Run through the QA checklist from the spec**

- [ ] **Robert Johnson AV Media-style screenshot** → import succeeds; preview shows the reproduced signature with logo cropped from the screenshot region; "Skift til manuel redigering" button present.
- [ ] **Signature with photo (round or square)** → photo crops as a square at the bbox coordinates; HTML reproduces text styling.
- [ ] **Signature with gradient background** → vision generates a flat-color approximation; sanitizer doesn't strip the result; preview renders.
- [ ] **Plain "Sendt fra min iPhone"** → `no-data` banner appears (sanitized html is empty).
- [ ] **Existing structured user** → import overrides into imported mode; "Skift til manuel redigering" → confirmation → form returns with EMPTY_SIGNATURE.
- [ ] **Send through Outlook desktop on Windows:** signature renders correctly, logo inline, mailto/https links clickable.
- [ ] **Send through Apple Mail iOS, Gmail web, OWA web:** signature renders correctly.
- [ ] **Airplane mode during import** → `network` banner: "Ingen forbindelse. Prøv igen."
- [ ] **Tap import 60+ times in a minute** → `rate-limit` banner appears.
- [ ] **Reject media library permission** → `permission-denied` banner.

- [ ] **Step 3: If everything passes, mark the plan task complete**

No commit needed — verification only.

---

## Done criteria

- All 9 tasks committed.
- `npx tsc --noEmit` and `npx jest` both clean at HEAD.
- `feature/mail-signature-screenshot` branch ready for merge to main.
- Manual QA checklist in Task 9 fully passed against real screenshots.
- No regression for users with structured signatures who never tap import.
- The previously-shipped text-extraction code (`validateExtracted`, `ExtractedSignatureFields`, `pickAndExtractSignature`) is fully removed.
