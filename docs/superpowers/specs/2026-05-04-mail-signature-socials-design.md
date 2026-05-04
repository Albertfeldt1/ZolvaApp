# Mail Signature — Social-Media Links — Design

**Date:** 2026-05-04
**Builds on:** `2026-05-04-mail-signature-rich-design.md` and `2026-05-04-signature-screenshot-html-design.md`.

## Goal

Let users include working social-media links (LinkedIn, Twitter/X, Instagram, Facebook, TikTok, YouTube, GitHub, other) in their outgoing mail signature. Available in both **manual (structured)** and **auto (imported from screenshot)** modes. Replaces the broken-icon-link gap exposed during testing — today the screenshot importer either drops icon-links entirely or emits empty `<a>` tags around stripped `<img>`s.

## In scope

- A typed `SocialLink` shape and a `socials: SocialLink[]` field on both arms of `SignatureData` (structured + imported).
- Storage migration: legacy entries default to `socials: []`.
- Manual editor: a new "Sociale medier" section in `MailSignatureSection` with `+ tilføj sociale medier` button. Each row has a type dropdown (LinkedIn / Twitter / Instagram / Facebook / TikTok / YouTube / GitHub / Other), a URL input, and a delete button.
- Imported flow: vision tool extracts any visible social-media link icons in the screenshot, populates the `socials` array, and **omits** them from the imported HTML so we don't double-render. User can correct/edit/delete after import.
- Render: a labelled-link row appended to the outgoing signature HTML (after the existing block). Plain text labels — `LinkedIn · Twitter · GitHub` — each wrapped in `<a href="…">` with a brand-tinted color. Same render path for both manual and imported modes.
- Sanitizer relaxation: anchors with the listed social hosts (`linkedin.com`, `twitter.com`, `x.com`, `instagram.com`, etc.) keep working as today (the existing `https://` rule already permits them — no allowlist change needed).

## Out of scope

- **Icon-font / SVG rendering of brand glyphs.** Text labels only for v1. Brand-icon support is a separate brainstorm.
- **Multi-image cropping.** The `iconBoxes` approach (return multiple cropped logos for a faithful icon row inside the imported HTML) stays deferred — text labels in our render style are good enough for v1, simpler, and avoid the multi-`cid:` infrastructure work.
- **Per-user-defined social platforms** beyond the listed seven + "other". If you want to add Bluesky later, that's a small const update, not a user-facing feature.
- **Auto-detection of social URLs from `customLines` text.** The structured form's `customLines` field stays freeform; users have to add socials explicitly via the new section.
- **Validation of URL format/host.** The URL field accepts any string. Bad URLs render as broken links — no warning. (Adding validation is YAGNI for a personal-use signature builder.)

## Architecture

### Storage shape

```ts
export type SocialType =
  | 'linkedin' | 'twitter' | 'instagram' | 'facebook'
  | 'tiktok' | 'youtube' | 'github' | 'other';

export type SocialLink = {
  type: SocialType;
  url: string;
  label?: string;  // optional override (used when type === 'other'; otherwise display name comes from a const map)
};

// Both arms gain a `socials` field. Null/empty array = no row rendered.
export type StructuredSignature = {
  kind: 'structured';
  ...existing fields...
  socials: SocialLink[];
};

export type ImportedSignature = {
  kind: 'imported';
  ...existing fields...
  socials: SocialLink[];
};
```

`EMPTY_SIGNATURE` gains `socials: []`.

**Migration on read:** `loadFromStorage` defaults `socials` to `[]` for any entry that doesn't have it. Storage is otherwise unchanged.

### Display name map

A small const in `template.ts` (or a new `socials.ts`):

```ts
const SOCIAL_LABELS: Record<SocialType, string> = {
  linkedin:  'LinkedIn',
  twitter:   'Twitter',
  instagram: 'Instagram',
  facebook:  'Facebook',
  tiktok:    'TikTok',
  youtube:   'YouTube',
  github:    'GitHub',
  other:     '',  // falls back to label || url-host
};
```

For `type === 'other'`, render uses `link.label` if set, otherwise the URL host (e.g. `bsky.app`).

### Render

A new pure helper in `template.ts`:

```ts
export function renderSocials(socials: SocialLink[]): string;
```

Output is a single `<div>` wrapping `<a>` elements joined by ` · `. Inline styles only — same Outlook-safe constraints as today's template. Returns empty string if the array is empty (caller decides whether to render).

Example output:
```html
<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;margin-top:6px">
  <a href="https://linkedin.com/in/albert" style="color:#0a66c2;text-decoration:none">LinkedIn</a>
  <span style="color:#888"> · </span>
  <a href="https://twitter.com/albert" style="color:#1da1f2;text-decoration:none">Twitter</a>
  <span style="color:#888"> · </span>
  <a href="https://github.com/albert" style="color:#1a1a1a;text-decoration:none">GitHub</a>
</div>
```

Brand colors are a const map; `'other'` uses the default ink color.

### Integration with outgoing mail

`buildOutgoingBody` already branches on `kind`. Both branches now also call `renderSocials(data.socials)` and append the result to `rendered.html` (and to the plaintext) before assembling the final body. Single helper, called from one place.

### Settings UI — manual mode

In `MailSignatureSection`'s structured branch, after the existing logo picker and before the live preview, add:

```tsx
<Text style={styles.sigFieldLabel}>Sociale medier</Text>
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
```

`SocialLinkRow` is a small file-local component:
- Type dropdown (uses the same picker pattern as elsewhere in Settings — modal or inline action sheet)
- URL `TextInput`
- Optional label `TextInput` shown ONLY when `type === 'other'`
- Delete `Pressable`

`addSocial` appends `{ type: 'linkedin', url: '' }` to the array (most common starter; user changes the type if needed). `updateSocialAt`/`removeSocialAt` are simple immutable updates that go through the existing `update` setter (which already calls `saveSignature`).

### Settings UI — imported mode

Same "Sociale medier" section appears in the imported branch, **above** the WebView preview (so users see the editable list before the rendered HTML — they're more likely to interact with the list than the preview). Same `SocialLinkRow` component. Initial values come from Claude's extracted socials.

Both modes share the same row component and the same add/update/remove handlers.

### Vision tool extension

`IMPORT_TOOL.input_schema` gains:

```json
"socials": {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "enum": ["linkedin","twitter","instagram","facebook","tiktok","youtube","github","other"]
      },
      "url": { "type": "string" },
      "label": { "type": "string" }
    },
    "required": ["type", "url"]
  }
}
```

System prompt addendum (appended to the existing prompt):

> If the screenshot contains social-media link icons (e.g. LinkedIn, Twitter/X, Instagram, Facebook, TikTok, YouTube, GitHub, or similar), extract them as a `socials` array with `type` and `url` for each. Infer the type from the icon shape and/or the URL. **Do NOT include these icon links in the `html` output** — we'll render the social row separately. If no social-media icons are visible, return `socials: []`.

Parser (`parseImportToolUse`) gains a `socials` field validation: must be an array; each item must have a string `type` (in the enum) and a string `url`. Items failing validation are dropped silently (don't reject the whole tool result over one bad social).

## Failure modes (additions only)

| Path | Trigger | Behavior |
|---|---|---|
| Vision returns malformed `socials` item | One item missing `url` or with bad `type` | Item dropped silently. Other valid items kept. |
| Vision returns no `socials` field at all | Old tool schema or model output without it | Treated as `socials: []` — no error. |
| User adds a social with empty URL | Manual entry, user taps `+` and doesn't fill | `renderSocials` skips items with `url.trim() === ''`. Outgoing mail shows no row for that entry. |

## Tests

**New unit tests:**

- `__tests__/template.test.ts` extension — `renderSocials` cases:
  - empty array → empty string
  - one social → `<div>...<a href...>LinkedIn</a></div>`
  - three socials → joined with ` · ` separators
  - `type: 'other'` with `label` → uses label
  - `type: 'other'` without `label` → uses URL host
  - skips items with empty URL
  - HTML-escapes URL and label
- `__tests__/storage.test.ts` extension — legacy entry without `socials` migrates to `[]`; `socials` round-trips for both arms.
- `__tests__/build-outgoing-body.test.ts` extension — outgoing html includes the socials row when `socials.length > 0` for both kinds.
- `__tests__/import-from-screenshot.test.ts` extension — `parseImportToolUse` accepts/rejects various social shapes.

**Manual QA additions:**

- Manual mode: add 3 socials with different types → outgoing mail shows them.
- Manual mode: add 1 social, leave URL empty → no row in output.
- Imported mode: import a screenshot with LinkedIn + Twitter icons → socials populated; user sees them in the list; preview WebView shows the imported HTML (without the social icons, per Claude's omission).
- Imported mode: edit the LinkedIn URL → outgoing mail uses the corrected URL.
- Outlook desktop / Apple Mail / Gmail web: social row renders, links are clickable.

## What changes vs the current branch

The current `feature/mail-signature-screenshot` branch ships the HTML import. Socials are a follow-up commit set on top.

**New scope:** `socials` field, `SocialLink` type, `renderSocials` helper, social row UI in both modes, vision-tool socials extraction.

**Reused:** sanitizer (no changes — `https://` anchors are already allowed), `completeWithTool`, the discriminated-union architecture, the migration-on-read pattern.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Vision returns wrong social type for an icon | User can correct via the type dropdown after import. |
| Vision extracts the same link twice (icon + URL text) | Keep both for now; user can delete duplicates. Could de-dupe by URL in a follow-up if it's annoying. |
| Custom platforms (Bluesky, Mastodon, threads) don't fit the type enum | `type: 'other'` + custom `label` covers them. Add to the enum later when one becomes table-stakes. |
| URL field accepts anything (no validation) | Bad URLs become broken links — visible failure, not silent. Validation is YAGNI for v1. |
