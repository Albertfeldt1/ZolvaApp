# Mail Signature — Social-Media Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed `socials` array to both signature arms, a "Sociale medier" editor UI in both modes, and have the vision tool extract social-media link icons from the screenshot. Outgoing mail renders the social links in our template style as a row appended after the existing signature.

**Architecture:** `SocialType = 'linkedin'|'twitter'|'instagram'|'facebook'|'tiktok'|'youtube'|'github'|'other'`. `SocialLink = { type, url, label? }`. `SignatureData` arms gain `socials: SocialLink[]`. Pure `renderSocials(socials)` helper produces an Outlook-safe `<div>` of branded text-links joined by ` · `. `buildOutgoingBody` appends it after the existing signature render. `IMPORT_TOOL.input_schema` gains `socials`; system prompt tells Claude to extract icon-links and omit them from the html. `MailSignatureSection` gets a "Sociale medier" section in both modes with `+ tilføj sociale medier` button.

**Tech Stack:** TypeScript, React Native (Expo), Anthropic Claude tool-use, Jest.

**Spec:** `docs/superpowers/specs/2026-05-04-mail-signature-socials-design.md`

---

## Pre-flight

- Worktree: `/Users/albertfeldt/ZolvaApp/.worktrees/mail-signature-screenshot`, branch `feature/mail-signature-screenshot`. HEAD `e59bf66`.
- Solo project; commits go to the worktree branch and merge to main later.
- Run `npx tsc --noEmit && npx jest` after each task. Both must end green by Task 5.
- The proxy and client unions support `image` content blocks (no proxy redeploy needed for this feature).

---

### Task 1: SocialType + SocialLink types + EMPTY_SIGNATURE update

**Files:**
- Modify: `src/lib/mail-signature/types.ts`

Foundation step — adds `SocialLink` and `socials: SocialLink[]` to both arms. Like Pass 2's Task 1, this intentionally breaks consumers that construct signatures without `socials`; later tasks fix them.

- [ ] **Step 1: Update types**

In `src/lib/mail-signature/types.ts`, append these new types BEFORE `StructuredSignature`:

```ts
export type SocialType =
  | 'linkedin' | 'twitter' | 'instagram' | 'facebook'
  | 'tiktok' | 'youtube' | 'github' | 'other';

export type SocialLink = {
  type: SocialType;
  url: string;
  label?: string;  // optional override, used when type === 'other' (else falls back to URL host).
};
```

Add `socials: SocialLink[];` as the LAST field of both `StructuredSignature` and `ImportedSignature` (preserve all existing fields above it).

Update `EMPTY_SIGNATURE` to include `socials: [],` as its final field.

- [ ] **Step 2: Typecheck — expect failures**

```bash
npx tsc --noEmit
```

Expected: failures in `storage.ts`, `import-from-screenshot.ts`, `__tests__/storage.test.ts`, `__tests__/build-outgoing-body.test.ts`, possibly `template.test.ts` and `import-from-screenshot.test.ts`. The errors are about `socials` being missing in object literals. Do NOT fix consumers in this task.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/types.ts
git commit -m "feat(mail-signature): SocialLink type + socials field on both arms"
```

---

### Task 2: Storage migration + test fixtures (TDD)

**Files:**
- Modify: `src/lib/mail-signature/storage.ts`
- Modify: `src/lib/mail-signature/__tests__/storage.test.ts`

Default missing `socials` to `[]` on read for both arms. Update existing test fixtures to include `socials: []`.

- [ ] **Step 1: Add the failing migration tests**

Append a new `describe` block at the end of `src/lib/mail-signature/__tests__/storage.test.ts` (inside the same outer scope as the existing `discriminated-union migration` describe):

```ts
describe('loadSignature — socials migration', () => {
  beforeEach(async () => {
    __resetForTests();
    __setCurrentUserForTests('uid-soc');
    await AsyncStorage.clear();
  });

  it('legacy structured entry without socials loads with socials: []', async () => {
    await AsyncStorage.setItem(
      'zolva.mail.signature.v2.uid-soc',
      JSON.stringify({
        kind: 'structured',
        name: 'Albert', title: '', company: '', phone: '', email: '',
        website: '', customLines: '', logo: null,
      }),
    );
    const sig = await loadSignature('uid-soc');
    expect(sig?.kind).toBe('structured');
    if (sig?.kind === 'structured') {
      expect(sig.socials).toEqual([]);
    }
  });

  it('legacy imported entry without socials loads with socials: []', async () => {
    await AsyncStorage.setItem(
      'zolva.mail.signature.v2.uid-soc',
      JSON.stringify({
        kind: 'imported',
        html: '<table><tr><td>Hi</td></tr></table>',
        plaintext: 'Hi',
        image: null,
        importedAt: 1700000000000,
      }),
    );
    const sig = await loadSignature('uid-soc');
    expect(sig?.kind).toBe('imported');
    if (sig?.kind === 'imported') {
      expect(sig.socials).toEqual([]);
    }
  });

  it('round-trips socials through save/load', async () => {
    const withSocials: SignatureData = {
      kind: 'structured',
      name: 'Albert', title: '', company: '', phone: '', email: '',
      website: '', customLines: '', logo: null,
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
        { type: 'github', url: 'https://github.com/albert' },
      ],
    };
    __setCurrentUserForTests('uid-soc');
    await saveSignature(withSocials);
    __resetForTests();
    __setCurrentUserForTests('uid-soc');
    const loaded = await loadSignature('uid-soc');
    expect(loaded).toEqual(withSocials);
  });
});
```

Also update any existing tests in this file whose object-literal fixtures don't have `socials` — add `socials: []` to keep them compiling. Common spots: the `discriminated-union migration` block from the prior pass.

- [ ] **Step 2: Run the test file — observe**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts
```

Expected: at minimum, the round-trip test fails because storage doesn't yet ensure `socials` is present on read. Possibly the legacy-entry tests already pass if the new EMPTY_SIGNATURE spread covers structured (it should). Run and read actual output.

- [ ] **Step 3: Make the migration explicit in `loadFromStorage`**

In `src/lib/mail-signature/storage.ts`, find the v2 branch of `loadFromStorage`. Modify both the imported and structured paths to ensure `socials` is always set:

For the imported path, change:
```ts
return {
  kind: 'imported',
  html: ...,
  plaintext: ...,
  image: parsed.image ?? null,
  importedAt: ...,
};
```
to:
```ts
return {
  kind: 'imported',
  html: ...,
  plaintext: ...,
  image: parsed.image ?? null,
  importedAt: ...,
  socials: Array.isArray(parsed.socials) ? parsed.socials as SocialLink[] : [],
};
```

For the structured fallback, change:
```ts
return { ...EMPTY_SIGNATURE, ...parsed, kind: 'structured' };
```
to:
```ts
return {
  ...EMPTY_SIGNATURE,
  ...parsed,
  kind: 'structured',
  socials: Array.isArray(parsed.socials) ? parsed.socials as SocialLink[] : [],
};
```

(The explicit override after the spread is necessary because `parsed` could supply a non-array value.)

Update the `import` line at the top of `storage.ts` to also bring in `SocialLink`:

```ts
import { EMPTY_SIGNATURE, type SignatureData, type SocialLink } from './types';
```

- [ ] **Step 4: Re-run storage tests**

```bash
npx jest src/lib/mail-signature/__tests__/storage.test.ts
```

Expected: all storage tests PASS (including the 3 new socials cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/storage.ts src/lib/mail-signature/__tests__/storage.test.ts
git commit -m "feat(mail-signature): storage migration for socials field"
```

---

### Task 3: `renderSocials` helper + buildOutgoingBody integration (TDD)

**Files:**
- Modify: `src/lib/mail-signature/template.ts`
- Modify: `src/lib/mail-signature/build-outgoing-body.ts`
- Modify: `src/lib/mail-signature/__tests__/template.test.ts`
- Modify: `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts`

Add a pure `renderSocials(socials: SocialLink[]): string` helper that emits an Outlook-safe `<div>` of branded text-links. Both `buildOutgoingBody` paths append it after the existing signature render.

- [ ] **Step 1: Add failing tests for `renderSocials`**

In `src/lib/mail-signature/__tests__/template.test.ts`, append at the bottom (inside the outer scope):

```ts
import { renderSocials } from '../template';

describe('renderSocials', () => {
  it('returns empty string for empty array', () => {
    expect(renderSocials([])).toBe('');
  });

  it('renders one social as a single link', () => {
    const out = renderSocials([
      { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
    ]);
    expect(out).toContain('LinkedIn');
    expect(out).toContain('href="https://linkedin.com/in/albert"');
    expect(out).toContain('<div');
    expect(out).toContain('</div>');
    expect(out).not.toContain(' · ');  // no separator for a single link
  });

  it('joins multiple socials with middot separator', () => {
    const out = renderSocials([
      { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
      { type: 'github', url: 'https://github.com/albert' },
    ]);
    expect(out).toContain('LinkedIn');
    expect(out).toContain('GitHub');
    expect(out).toContain(' · ');
  });

  it('uses label when type is "other" and label is set', () => {
    const out = renderSocials([
      { type: 'other', url: 'https://bsky.app/profile/albert', label: 'Bluesky' },
    ]);
    expect(out).toContain('Bluesky');
  });

  it('falls back to URL host when type is "other" and no label', () => {
    const out = renderSocials([
      { type: 'other', url: 'https://bsky.app/profile/albert' },
    ]);
    expect(out).toContain('bsky.app');
  });

  it('skips items with empty URL', () => {
    const out = renderSocials([
      { type: 'linkedin', url: '' },
      { type: 'github', url: 'https://github.com/albert' },
    ]);
    expect(out).not.toContain('LinkedIn');
    expect(out).toContain('GitHub');
  });

  it('escapes HTML in URLs and labels', () => {
    const out = renderSocials([
      { type: 'other', url: 'https://x.com/<script>', label: '<b>Evil</b>' },
    ]);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>Evil</b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  it('returns empty string when all items have empty URLs', () => {
    const out = renderSocials([
      { type: 'linkedin', url: '' },
      { type: 'twitter', url: '   ' },
    ]);
    expect(out).toBe('');
  });
});
```

- [ ] **Step 2: Add failing tests for the build-outgoing-body integration**

In `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts`, append at the bottom (inside the outer scope, same pattern as the existing imported tests). Look at the existing tests for the loadSignature mock pattern and reuse it. Add 2 cases:

```ts
describe('buildOutgoingBody — socials integration', () => {
  // Use the same loadSignature mock pattern as the existing tests.

  it('appends socials row to structured-mode html', async () => {
    const sig: SignatureData = {
      kind: 'structured',
      name: 'Albert', title: '', company: '', phone: '', email: '',
      website: '', customLines: '', logo: null,
      socials: [{ type: 'linkedin', url: 'https://linkedin.com/in/albert' }],
    };
    // ...prime the loadSignature mock to return `sig`...
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('LinkedIn');
    expect(out.content).toContain('href="https://linkedin.com/in/albert"');
  });

  it('appends socials row to imported-mode html', async () => {
    const sig: SignatureData = {
      kind: 'imported',
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: null,
      importedAt: 1700000000000,
      socials: [{ type: 'github', url: 'https://github.com/albert' }],
    };
    // ...prime the loadSignature mock to return `sig`...
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('Hi');
    expect(out.content).toContain('GitHub');
  });
});
```

- [ ] **Step 3: Run tests — confirm new tests fail**

```bash
npx jest src/lib/mail-signature/__tests__/template.test.ts src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: `renderSocials` tests fail (function not found); build-outgoing-body socials tests fail (socials not in output).

- [ ] **Step 4: Add `renderSocials` to `template.ts`**

In `src/lib/mail-signature/template.ts`, update the import to include `SocialLink, SocialType`:

```ts
import type { ImportedSignature, RenderedSignature, StructuredSignature, SocialLink, SocialType } from './types';
```

Add at the bottom of the file (after `renderImported`):

```ts
const SOCIAL_LABELS: Record<SocialType, string> = {
  linkedin:  'LinkedIn',
  twitter:   'Twitter',
  instagram: 'Instagram',
  facebook:  'Facebook',
  tiktok:    'TikTok',
  youtube:   'YouTube',
  github:    'GitHub',
  other:     '',
};

const SOCIAL_COLORS: Record<SocialType, string> = {
  linkedin:  '#0a66c2',
  twitter:   '#1da1f2',
  instagram: '#e4405f',
  facebook:  '#1877f2',
  tiktok:    '#1a1a1a',
  youtube:   '#ff0000',
  github:    '#1a1a1a',
  other:     '#1a1a1a',
};

function urlHost(url: string): string {
  // Light parse — sufficient for label fallback. Doesn't need to be perfect.
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : url;
}

function socialDisplayName(link: SocialLink): string {
  if (link.type === 'other') {
    return link.label && link.label.trim() ? link.label : urlHost(link.url);
  }
  return SOCIAL_LABELS[link.type];
}

export function renderSocials(socials: SocialLink[]): string {
  const items = socials.filter((s) => s.url.trim() !== '');
  if (items.length === 0) return '';

  const linkHtml = items
    .map((s) => {
      const color = SOCIAL_COLORS[s.type];
      const name = escapeHtml(socialDisplayName(s));
      const href = escapeHtml(s.url);
      return `<a href="${href}" style="color:${color};text-decoration:none">${name}</a>`;
    })
    .join('<span style="color:#888"> · </span>');

  return `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin-top:6px">${linkHtml}</div>`;
}
```

- [ ] **Step 5: Wire socials into `buildOutgoingBody`**

In `src/lib/mail-signature/build-outgoing-body.ts`, update the import to bring in `renderSocials`:

```ts
import { bodyToParagraphs, renderImported, renderSignature, renderSocials } from './template';
```

Find the section where `rendered` is constructed and `content` is assembled. Append the socials row to `rendered.html` BEFORE building `content`:

```ts
  if (data) {
    rendered = data.kind === 'imported' ? renderImported(data) : renderSignature(data);
  }

  if (!rendered) {
    return { contentType: 'text', content: rawBody, attachments: [] };
  }

  const socialsHtml = data ? renderSocials(data.socials) : '';
  const fullSignatureHtml = rendered.html + socialsHtml;

  const bodyHtml = bodyToParagraphs(rawBody);
  const content = `${bodyHtml}${fullSignatureHtml}`;
  // ...attachments unchanged...
```

- [ ] **Step 6: Run tests — confirm green**

```bash
npx jest src/lib/mail-signature/__tests__/template.test.ts src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
```

Expected: all PASS (including the new socials tests).

- [ ] **Step 7: Run the full suite**

```bash
npx jest
```

Expected: all green (no regressions in other files; storage tests still pass).

- [ ] **Step 8: Commit**

```bash
git add src/lib/mail-signature/template.ts src/lib/mail-signature/build-outgoing-body.ts src/lib/mail-signature/__tests__/template.test.ts src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
git commit -m "feat(mail-signature): renderSocials helper + outgoing body integration"
```

---

### Task 4: Vision tool extracts socials (TDD on the parser)

**Files:**
- Modify: `src/lib/mail-signature/import-from-screenshot.ts`
- Modify: `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts`

Extend the IMPORT_TOOL schema with `socials`, update the system prompt to extract them and exclude from html, extend `parseImportToolUse` to validate, and store extracted socials in `ImportedSignature.socials`.

- [ ] **Step 1: Add failing parser tests**

In `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts`, append at the bottom of the existing `describe('parseImportToolUse', ...)` block (inside its `describe`, after the existing tests):

```ts
  it('accepts a socials array with valid items', () => {
    const ok = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
        { type: 'github',   url: 'https://github.com/albert' },
      ],
    };
    const out = parseImportToolUse(ok);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual(ok.socials);
    }
  });

  it('drops socials items with bad type or missing url', () => {
    const input = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
      socials: [
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },  // ok
        { type: 'invalid',  url: 'https://x.com' },                    // bad type
        { type: 'github' },                                            // missing url
        { type: 'twitter', url: 42 },                                  // non-string url
      ],
    };
    const out = parseImportToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([
        { type: 'linkedin', url: 'https://linkedin.com/in/albert' },
      ]);
    }
  });

  it('treats missing socials field as empty array', () => {
    const input = {
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      logoBox: null,
    };
    const out = parseImportToolUse(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.socials).toEqual([]);
    }
  });
```

- [ ] **Step 2: Run the test file — confirm new tests fail**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: 3 new socials tests fail because `parseImportToolUse` doesn't yet handle the `socials` field, and the `ToolUseResult` type doesn't include `socials`.

- [ ] **Step 3: Update `import-from-screenshot.ts`**

Update the imports to include `SocialLink` and `SocialType`:

```ts
import type { ImportedSignature, InlineImage, SocialLink, SocialType } from './types';
```

Add the social type constant:

```ts
const SOCIAL_TYPES: ReadonlyArray<SocialType> = [
  'linkedin', 'twitter', 'instagram', 'facebook',
  'tiktok', 'youtube', 'github', 'other',
];
```

Update the `IMPORT_TOOL.input_schema` to include `socials`:

```ts
const IMPORT_TOOL = {
  name: 'import_signature',
  description: 'Output the reproduced signature HTML, plaintext fallback, optional logo bounding box, and any social-media link icons.',
  input_schema: {
    type: 'object',
    properties: {
      html: { type: 'string' },
      plaintext: { type: 'string' },
      logoBox: { /* unchanged */ },
      socials: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: SOCIAL_TYPES as unknown as string[] },
            url: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['type', 'url'],
        },
      },
    },
    required: ['html', 'plaintext', 'logoBox'],
  },
};
```

(Note: `socials` is NOT in `required` — Claude may legitimately return without it for screenshots that have no social icons. We default to `[]` in the parser.)

Append to `SIGNATURE_IMPORT_SYSTEM_PROMPT` (just before the final paragraph about empty signatures):

```
Social-media icons:
- If the screenshot contains social-media link icons (LinkedIn, Twitter/X, Instagram, Facebook, TikTok, YouTube, GitHub, or others), extract them as a "socials" array. Each entry has a "type" (one of: linkedin, twitter, instagram, facebook, tiktok, youtube, github, other) and a "url". Use "other" with a "label" field for platforms not in this list.
- IMPORTANT: Do NOT include these icon links in the html output. We render the social row separately. The html should not have any <a> tags wrapping social-media icons or icon-replacements for them.
- If no social-media icons are visible, return socials: [].
```

Update the `ToolUseResult` type to include socials:

```ts
type ToolUseResult = {
  html: string;
  plaintext: string;
  logoBox: { x: number; y: number; w: number; h: number } | null;
  socials: SocialLink[];
};
```

Extend `parseImportToolUse`. After the existing logoBox validation and before the final return, add socials validation:

```ts
  let socials: SocialLink[] = [];
  if (Array.isArray(obj.socials)) {
    for (const item of obj.socials) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const it = item as Record<string, unknown>;
      const type = it.type;
      const url = it.url;
      if (typeof type !== 'string') continue;
      if (typeof url !== 'string') continue;
      if (!(SOCIAL_TYPES as ReadonlyArray<string>).includes(type)) continue;
      const link: SocialLink = { type: type as SocialType, url };
      if (typeof it.label === 'string') link.label = it.label;
      socials.push(link);
    }
  }
  return { ok: true, value: { html: obj.html, plaintext: obj.plaintext, logoBox, socials } };
```

In `pickAndImportSignature`, the final `data: ImportedSignature` construction must include `socials: parsed.value.socials`:

```ts
  const data: ImportedSignature = {
    kind: 'imported',
    html: sanitized,
    plaintext: parsed.value.plaintext,
    image,
    importedAt: Date.now(),
    socials: parsed.value.socials,
  };
```

- [ ] **Step 4: Run tests — confirm green**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: all 15 tests pass (12 prior + 3 new socials cases).

- [ ] **Step 5: Run full suite**

```bash
npx jest
```

Expected: green across the board.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mail-signature/import-from-screenshot.ts src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
git commit -m "feat(mail-signature): vision tool extracts social-media link icons"
```

---

### Task 5: "Sociale medier" section in `MailSignatureSection` (manual + imported)

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Optional create: `src/screens/SettingsScreen.tsx` already houses `MailSignatureSection`. Define the new `SocialLinkRow` as a file-local component within the same file to keep it close to its caller.

Add a "Sociale medier" section that appears in BOTH structured and imported branches. Each row: type dropdown, URL field, optional label field (only shown when `type === 'other'`), delete button. `+ tilføj sociale medier` button at the bottom appends a fresh row with `type: 'linkedin', url: ''`.

- [ ] **Step 1: Add `SocialLinkRow` component**

Above `MailSignatureSection` in `src/screens/SettingsScreen.tsx`, add:

```ts
const SOCIAL_OPTIONS: { value: SocialType; label: string }[] = [
  { value: 'linkedin',  label: 'LinkedIn' },
  { value: 'twitter',   label: 'Twitter' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook',  label: 'Facebook' },
  { value: 'tiktok',    label: 'TikTok' },
  { value: 'youtube',   label: 'YouTube' },
  { value: 'github',    label: 'GitHub' },
  { value: 'other',     label: 'Andet' },
];

function SocialLinkRow(props: {
  link: SocialLink;
  onChange: (next: SocialLink) => void;
  onRemove: () => void;
}) {
  const { link, onChange, onRemove } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const currentLabel =
    SOCIAL_OPTIONS.find((o) => o.value === link.type)?.label ?? 'LinkedIn';

  return (
    <View style={styles.sigSocialRow}>
      <Pressable
        onPress={() => setPickerOpen((v) => !v)}
        style={styles.sigSocialTypeBtn}
        accessibilityRole="button"
      >
        <Text style={styles.sigSocialTypeBtnText}>{currentLabel}</Text>
        <ChevronDown size={14} color={colors.fg2} />
      </Pressable>
      {pickerOpen && (
        <View style={styles.sigSocialTypeMenu}>
          {SOCIAL_OPTIONS.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => {
                onChange({ ...link, type: opt.value });
                setPickerOpen(false);
              }}
              style={styles.sigSocialTypeMenuItem}
            >
              <Text style={styles.sigSocialTypeMenuItemText}>{opt.label}</Text>
              {opt.value === link.type && <Check size={14} color={colors.ink} />}
            </Pressable>
          ))}
        </View>
      )}
      <TextInput
        value={link.url}
        onChangeText={(url) => onChange({ ...link, url })}
        placeholder="https://..."
        placeholderTextColor={colors.fg3}
        style={styles.sigSocialUrlInput}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {link.type === 'other' && (
        <TextInput
          value={link.label ?? ''}
          onChangeText={(label) => onChange({ ...link, label })}
          placeholder="Visningsnavn"
          placeholderTextColor={colors.fg3}
          style={styles.sigSocialLabelInput}
        />
      )}
      <Pressable
        onPress={onRemove}
        style={styles.sigSocialRemoveBtn}
        accessibilityRole="button"
      >
        <Text style={styles.sigSocialRemoveBtnText}>×</Text>
      </Pressable>
    </View>
  );
}
```

- [ ] **Step 2: Update imports**

In the `from '../lib/mail-signature'` import block, add `SocialLink` and `SocialType` to the type imports:

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
  type SocialLink,
  type SocialType,
} from '../lib/mail-signature';
```

Verify `TextInput` is in the `react-native` import list (should be — it's used elsewhere in this file).

- [ ] **Step 3: Add socials handlers inside `MailSignatureSection`**

Add three handlers inside the component (near the other handlers):

```ts
  const addSocial = () => {
    setData((prev) => {
      const next: SignatureData = {
        ...prev,
        socials: [...prev.socials, { type: 'linkedin', url: '' }],
      };
      void saveSignature(next);
      return next;
    });
  };

  const updateSocialAt = (idx: number, link: SocialLink) => {
    setData((prev) => {
      const nextSocials = prev.socials.map((s, i) => (i === idx ? link : s));
      const next: SignatureData = { ...prev, socials: nextSocials };
      void saveSignature(next);
      return next;
    });
  };

  const removeSocialAt = (idx: number) => {
    setData((prev) => {
      const nextSocials = prev.socials.filter((_, i) => i !== idx);
      const next: SignatureData = { ...prev, socials: nextSocials };
      void saveSignature(next);
      return next;
    });
  };
```

Note: these handlers spread `prev` directly — TypeScript's discriminated-union narrowing means `next` is correctly typed as the same kind as `prev`.

- [ ] **Step 4: Render the section in both modes**

Define a `socialsBlock` JSX expression near the bottom of the component (just before the `return`):

```tsx
  const socialsBlock = (
    <>
      <Text style={[styles.sigFieldLabel, { marginTop: 16 }]}>Sociale medier</Text>
      {data.socials.map((link, idx) => (
        <SocialLinkRow
          key={idx}
          link={link}
          onChange={(next) => updateSocialAt(idx, next)}
          onRemove={() => removeSocialAt(idx)}
        />
      ))}
      <Pressable onPress={addSocial} style={styles.sigSocialAddBtn} accessibilityRole="button">
        <Text style={styles.sigSocialAddBtnText}>+ tilføj sociale medier</Text>
      </Pressable>
    </>
  );
```

Insert `{socialsBlock}` in TWO places in the JSX:
- **Structured branch:** AFTER the existing logo picker and BEFORE the "Forhåndsvisning" preview heading.
- **Imported branch:** AFTER the WebView preview wrapper and BEFORE the "Skift til manuel redigering" button.

- [ ] **Step 5: Add the new style keys**

In the `StyleSheet.create({ ... })` block, alongside the other `sig*` keys, add:

```ts
sigSocialRow: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  marginTop: 8,
  flexWrap: 'wrap',
},
sigSocialTypeBtn: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
  paddingHorizontal: 10,
  paddingVertical: 8,
  borderRadius: 8,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  backgroundColor: colors.mist,
},
sigSocialTypeBtnText: {
  fontSize: 13,
  color: colors.ink,
  fontWeight: '500',
},
sigSocialTypeMenu: {
  width: '100%',
  marginTop: 4,
  borderRadius: 8,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  backgroundColor: '#fff',
  overflow: 'hidden',
},
sigSocialTypeMenuItem: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingHorizontal: 12,
  paddingVertical: 10,
},
sigSocialTypeMenuItemText: {
  fontSize: 14,
  color: colors.ink,
},
sigSocialUrlInput: {
  flex: 1,
  minWidth: 140,
  paddingHorizontal: 10,
  paddingVertical: 8,
  borderRadius: 8,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  backgroundColor: '#fff',
  fontSize: 13,
  color: colors.ink,
},
sigSocialLabelInput: {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 8,
  borderRadius: 8,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  backgroundColor: '#fff',
  fontSize: 13,
  color: colors.ink,
},
sigSocialRemoveBtn: {
  width: 32,
  height: 32,
  borderRadius: 16,
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: colors.mist,
},
sigSocialRemoveBtnText: {
  fontSize: 18,
  color: colors.fg3,
  fontWeight: '300',
},
sigSocialAddBtn: {
  marginTop: 12,
  paddingVertical: 10,
  alignItems: 'center',
  borderRadius: 8,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
  borderStyle: 'dashed',
  backgroundColor: 'transparent',
},
sigSocialAddBtnText: {
  fontSize: 13,
  fontWeight: '500',
  color: colors.fg2,
},
```

(Verify `colors.mist`, `colors.line`, `colors.ink`, `colors.fg2`, `colors.fg3` exist — they're already used in this file so they should.)

- [ ] **Step 6: Typecheck + tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: typecheck exit 0; all jest tests green.

If `tsc` errors, common spots:
- `addSocial`/`updateSocialAt`/`removeSocialAt` accessing `.socials` — make sure both arms have it (Task 1 added it).
- `link.label` access — TypeScript narrows when `type === 'other'`; if you guard correctly the union should resolve.

- [ ] **Step 7: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(mail-signature): Sociale medier section in settings (manual + imported)"
```

---

### Task 6: Manual smoke-test pass (verification only)

- [ ] **Step 1: Restart Metro from worktree**

```bash
npx expo start --clear --dev-client
```

Open the dev build on the simulator (already installed from the earlier WebView pass).

- [ ] **Step 2: QA checklist**

- [ ] Manual mode: tap `+ tilføj sociale medier` → row appears with LinkedIn default. Type a URL → outgoing test mail shows the linked LinkedIn label.
- [ ] Manual mode: change type to GitHub → label updates immediately.
- [ ] Manual mode: change type to "Andet" → label input appears alongside URL → enter a custom label → outgoing mail shows custom label.
- [ ] Manual mode: leave URL empty → no row in outgoing mail.
- [ ] Manual mode: add 3 socials → outgoing mail shows them joined with ` · `.
- [ ] Manual mode: tap × on a row → removed; persisted across re-open.
- [ ] Imported mode: import a screenshot with LinkedIn icon-link (e.g. AV Media-style signature) → socials list pre-filled with the extracted LinkedIn entry (verify URL is correct).
- [ ] Imported mode: WebView preview does NOT show the social icons (Claude was instructed to omit them); they only appear in our rendered socials row in outgoing mail.
- [ ] Imported mode: edit/delete extracted socials → outgoing mail uses the corrected list.
- [ ] Send through Outlook desktop on Windows: socials row renders, links are clickable.
- [ ] Send through Apple Mail iOS: same.

- [ ] **Step 3: If everything passes, mark plan task complete.** No commit.

---

## Done criteria

- All 6 tasks committed.
- `npx tsc --noEmit && npx jest` clean at HEAD.
- `feature/mail-signature-screenshot` branch ready for merge to main.
- Manual QA checklist in Task 6 fully passed.
- No regression for users who never add a social or never import a screenshot.
