# Mail Signature — Screenshot Import (HTML reproduction) — Design

**Date:** 2026-05-04
**Builds on:** `2026-05-04-mail-signature-rich-design.md` and the just-shipped (but soon-replaced) `2026-05-04-signature-screenshot-import-design.md`.
**Supersedes the user-visible behavior of:** the text-field-extraction screenshot importer shipped on `feature/mail-signature-screenshot` (`7bb0f69..c41d479` + `8479124`). The proxy + client type-union extensions stay; the orchestrator and Settings handler get rewritten.

## Goal

Let the user import an existing email signature into Zolva by uploading a screenshot, and have the imported signature look **as close as possible to the screenshot** when it's sent — including layout, fonts, colors, dividers, and any logo/photo present in the image. The "extract seven fields and drop them into the default template" behavior of the previous spec did not match what the user actually wanted from this feature ("the design part").

## In scope

- Vision call that returns sanitized, Outlook-safe HTML + plaintext + an optional logo bounding box.
- Logo cropped from the screenshot at the returned coordinates and embedded as an inline image (`cid:`).
- A small pure HTML/CSS sanitizer enforcing an Outlook-Word-rendering-engine-safe subset.
- A discriminated-union signature shape so an "imported" signature coexists with the existing structured form. Importing replaces; switching back to manual editing is one tap.
- A mode-aware `MailSignatureSection` in Settings — preview + replace/edit buttons in imported mode, the existing form in structured mode.
- Migration: existing AsyncStorage entries (no `kind` field) load as `kind: 'structured'`.

## Out of scope

- **Editing imported signatures field-by-field.** If the user's phone number changes, they re-screenshot and re-import. (Decided: a "string-replace inside HTML" editing layer is too brittle for the marginal value.)
- **Multi-template gallery / template picker.** Vision generates one HTML; no pre-curated layouts.
- **Signature-as-single-image (the screenshot embedded as one PNG).** Decided against — kills clickable links and text selection.
- **Permissive HTML/CSS** (flexbox, grid, web fonts, gradients, transforms). The user's primary mail target is Outlook desktop, where most modern CSS does not render. The sanitizer enforces a strict subset.
- **Editing raw HTML manually in Settings.** The imported HTML is not user-editable — it's a black box until re-imported.
- **OCR-based pure-text fallback.** If the vision pipeline fails, the user falls back to manual structured-form entry; we do not run a second extraction pass.

## Architecture

### Storage shape (the keystone)

`SignatureData` becomes a discriminated union:

```ts
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
  html: string;          // sanitized, Outlook-safe; the canonical render
  plaintext: string;     // for multipart/alt
  image: InlineImage | null;  // cropped logo, referenced by cid:zolva-sig in html
  importedAt: number;    // unix ms — surfaced as "Importeret 4. maj 2026"
};

export type Signature = StructuredSignature | ImportedSignature;

export const EMPTY_SIGNATURE: StructuredSignature = {
  kind: 'structured',
  name: '', title: '', company: '', phone: '', email: '',
  website: '', customLines: '', logo: null,
};
```

`InlineImage` stays as it is today.

**Migration on read:** `loadSignature` adds `kind: 'structured'` to any entry without one. Single-line change. No write-side migration needed — old data stays as-is until the user next saves.

### Vision pipeline

`pickAndImportSignature(): Promise<ImportResult>` — replaces `pickAndExtractSignature`.

Steps:

1. **Permission + pick** — same as today.
2. **Compress** to 1024px long side, JPEG q=0.85, with base64. Keep the resized URI; we'll crop the logo from this version too. (Cropping the resized image rather than the original is fine — signature logos in email don't need 4K resolution.)
3. **Vision call** via `completeWithTool` — a new thin wrapper in `claude.ts` that forces a single tool-use response:

   ```ts
   completeWithTool<T>(opts: {
     model: string;
     maxTokens: number;
     system: string;
     messages: ClaudeMessage[];
     tool: { name: string; description: string; input_schema: object };
     attachProfile?: boolean;
   }): Promise<T>;  // resolves to the tool_use.input, parsed against input_schema
   ```

   Tool definition:

   ```
   Tool: import_signature
   Input schema:
     html: string (required)
     plaintext: string (required)
     logoBox: { x: number, y: number, w: number, h: number } | null (required)
   ```

   `logoBox` coordinates are in image-pixel space of the resized image (the same image sent to Claude — max 1024 px long side), so the crop step doesn't need coordinate scaling.

   System prompt enforces Outlook-safe HTML: `<table>`-based layout only, inline `style=` only, no `<style>`/`<script>`/`@import`, no flexbox/grid, no web fonts (system stack only), no remote URLs. Tells Claude to reproduce text content, colors, alignment, weights, italics, dividers; reference the logo (if any) as `<img src="cid:zolva-sig" alt="">`.

   `attachProfile: false` — same privacy reason as the previous spec.

4. **Sanitize** — `sanitizeSignatureHtml(rawHtml)` runs the allowlist filter (see below). If output is empty after sanitization, return `parse-failed`.
5. **Crop logo** if `logoBox != null`:
   - **Sanity-check the bbox first:** drop the logo if `w <= 0` or `h <= 0`, or if `x < 0` or `y < 0`, or if `w * h > 0.5 * imageWidth * imageHeight` (an oversized box almost always means the model boxed the entire signature). Skipping the logo on a bad bbox is silent — the html still renders without an image.
   - `expo-image-manipulator.crop` on the resized image at the returned coords.
   - encode as PNG (preserves transparency on logos with no background).
   - return as `InlineImage`.
   - if cropping throws, the import still succeeds — we drop the logo and surface a soft warning ("Logoet kunne ikke importeres, men teksten gik godt.").
6. **Persist** as `ImportedSignature`. `setSignature(...)` triggers a re-render of `MailSignatureSection`, which switches to imported-mode UI.

The orchestrator's `ImportResult` discriminated union becomes:

```ts
type ImportResult =
  | { ok: true; data: ImportedSignature }
  | { ok: false; reason: '…' };  // reasons unchanged from previous spec
```

— so the SettingsScreen handler does `setSignature(result.data)` directly on success.

### Sanitizer (`sanitize.ts`)

A pure module with one exported function:

```ts
export function sanitizeSignatureHtml(input: string): string;
```

Implementation: a small hand-rolled tokenizer + allowlist filter (no DOM dependency — DOMPurify wants a window and adds 70 KB to the RN bundle). Approach:

- Tokenize HTML into tags/text/comments.
- For each open/close tag: drop if not in tag allowlist.
- For each attribute on a kept tag: drop if not in attr allowlist for that tag; further validate `href`/`src` URL schemes; further filter `style="..."` properties.
- Drop comments. Drop `<!DOCTYPE>`, `<?...?>`. Drop CDATA.
- Output is valid HTML5 and a strict subset.

**Tag allowlist:** `table, tr, td, tbody, thead, tfoot, div, span, p, br, hr, b, strong, i, em, u, a, img, ul, ol, li, h1, h2, h3, h4, h5, h6, font`.

**Attr allowlist (per-tag):**
- Global: `style`
- `table`: `cellpadding, cellspacing, border, align, valign, bgcolor, width, height`
- `tr, td`: `align, valign, bgcolor, width, height, colspan, rowspan`
- `a`: `href` (only `mailto:`, `https:`, `http:`, `tel:`), `target` (only `_blank`)
- `img`: `src` (only `cid:zolva-sig`), `alt`, `width`, `height`
- `font`: `color, face, size`
- everything else: only `style`

**`style="..."` filtering:** parse declarations; keep only properties matching `^(font-(family|size|weight|style|variant)|color|background-color|text-align|text-decoration|padding(-\\w+)?|margin(-\\w+)?|border(-\\w+)?(-\\w+)?|line-height|vertical-align|white-space|display)$`. Reject any value containing `expression(`, `javascript:`, `url(http`, `url("http`, `url('http`, `@import`, `<`, `>`, `\\u0000`. `display` only allowed when value is `block` or `inline-block`.

**Logo `<img>` rewriting:** any `<img>` whose `src` is `cid:zolva-sig` is allowed through; everything else (data URIs, https URLs, missing src) gets stripped. The vision prompt tells Claude to use exactly this `cid:` reference.

Empty/non-string input → empty string.

### Settings UI (mode-aware `MailSignatureSection`)

The existing component branches on `signature.kind`:

**Structured mode (default for new + existing users):**
- Same as today: SigField inputs, logo picker, live preview, "📷 Importér fra screenshot" button at the top.
- Tapping import button runs the new orchestrator. On success, signature flips to `kind: 'imported'`, component re-renders into imported mode.

**Imported mode:**
- A `WebView` (read-only, `originWhitelist=['*']`, JavaScript disabled, fixed height ~180dp, scrollable) renders the sanitized html. Any `cid:zolva-sig` reference resolves to a data URL built from `signature.image`.
- Caption below: "Importeret · 4. maj 2026" (formatted via existing date helpers).
- Two buttons:
  - "📷 Importér nyt screenshot" — re-runs orchestrator, replaces signature.
  - "Skift til manuel redigering" — confirmation prompt ("Dit importerede design slettes. Fortsæt?"), then `setSignature(EMPTY_SIGNATURE)` (which is `kind: 'structured'`).

The two reused buttons share the existing `sigImportBtn` styling. Button label / icon stays identical to today's "📷 Importér fra screenshot" — users will recognize it.

### Outlook send path

`buildOutgoingBody(signature, body)` switches on `signature.kind`:

- `'structured'` → existing path, no change.
- `'imported'` → return:
  - `contentType: 'html'`
  - `content: bodyToParagraphs(body) + '<br><br>' + signature.html`
  - `attachments: signature.image ? [imageAttachment(signature.image, 'zolva-sig')] : []`

Single `if` in one function. The plaintext alt body (for clients that prefer plaintext alt) uses `signature.plaintext` directly.

## Failure modes

| Reason | Trigger | UI |
|---|---|---|
| `permission-denied` | media library access denied | Existing Danish message |
| `cancelled` | user cancels picker | Silent (existing) |
| `too-large` | resized base64 > 300 KB | Existing message |
| `parse-failed` | sanitizer empties the html, or tool-use returns malformed shape, or any uncategorized error | Existing message |
| `network` | TypeError(/network/i) | Existing message |
| `rate-limit` | `ClaudeRateLimitError` | Existing message |
| `unauthorized` | `ClaudeConfigError` | Existing message |
| `logo-crop-failed` | `manipulateAsync` throws on crop | **Import succeeds**; soft banner: "Logoet kunne ikke importeres, men teksten gik godt." Signature persisted with `image: null`. |

`mapClaudeError` and `importResultMessage` are reused as-is; no new reasons need new Danish copy except the soft `logo-crop-failed` banner, which is rendered inline and not part of the `ImportResult` discriminated union.

## Tests

**New / changed unit tests:**

- `__tests__/sanitize.test.ts` (~25 cases). Coverage:
  - allowed tags pass through (`<table>`, `<a>`, `<img cid:>`, `<font>`)
  - disallowed tags removed (`<script>`, `<style>`, `<iframe>`, `<object>`, `<svg>`)
  - `javascript:` href stripped; `mailto:`/`https:`/`tel:` href kept; unknown scheme stripped
  - `cid:zolva-sig` `<img>` allowed; other `cid:`/`https:`/`data:` `<img>` stripped
  - `style="display:flex"` → property removed; `style="display:block"` → kept; resulting empty `style=""` collapses
  - `style` properties: `position`, `transform`, `animation`, `@import`, `url(http://...)`, `expression(...)` all stripped
  - nested malicious content (e.g. `<svg><script>...`) handled
  - HTML entities preserved
  - empty/null/non-string input → empty string

- `__tests__/storage.test.ts` — extend with: legacy entry without `kind` migrates to `'structured'` on read; `kind:'imported'` round-trips correctly; `loadSignature` returns `EMPTY_SIGNATURE` (which is `'structured'`) when AsyncStorage is empty.

- `__tests__/build-outgoing-body.test.ts` — extend with: `kind:'imported'` returns `contentType:'html'`, body = paragraphs + `<br><br>` + sanitized html, attachments = [logo] iff image is present. Structured path unchanged (regression coverage).

- `__tests__/import-from-screenshot.test.ts` — drop the 6 `validateExtracted` cases (no longer applies). Add a new `parseToolUseResult` test (~6 cases) covering: required fields present → ok; missing `html` → parse-failed; missing `plaintext` → parse-failed; `logoBox` null vs object; `logoBox.x` non-number → parse-failed; non-object input → parse-failed. Keep the 5 `mapClaudeError` and 1 `importResultMessage` tests as-is.

**Manual QA:**
- Robert Johnson AV Media-style screenshot → imports with logo cropped + HTML rendered.
- Signature with round photo → photo crops as a square with corners visible (acceptable — sanitizer doesn't enforce circles).
- Signature with gradient background → vision generates flat-color approximation (Outlook-safe).
- Plain "Sendt fra min iPhone" → no-data path → existing banner.
- Existing structured user → imports, switches to imported mode → "Skift til manuel redigering" → confirmation → form returns with EMPTY_SIGNATURE.
- Send through Outlook desktop on Windows: signature renders correctly, logo inline, links clickable.
- Send through Apple Mail iOS: same.
- Send through Gmail web: same.
- Send through OWA web: same.

## What changes in the just-shipped commits

The branch `feature/mail-signature-screenshot` currently has:

```
8479124 fix(mail-signature): opt out of profile preamble on signature extraction
c41d479 feat(mail-signature): screenshot-import button in settings
e3171f5 feat(mail-signature): re-export screenshot-import from public api
283e551 feat(mail-signature): screenshot-import orchestrator (picker + vision call)
0ad6710 feat(mail-signature): pure validators for screenshot-import
7b5767c feat(claude): allow image content blocks in client union
7bb0f69 feat(claude-proxy): accept image content blocks for vision calls
```

**Reused as-is:** `7bb0f69` (proxy union), `7b5767c` (client union).

**Reused functions inside replaced commits:** `mapClaudeError` and `importResultMessage` (kept; tests kept). The `validateExtracted` function and `ExtractedSignatureFields` type are deleted as part of the new work.

**Replaced behaviors:** `pickAndExtractSignature` orchestrator → `pickAndImportSignature` (new shape). `MailSignatureSection` handler → mode-aware re-render.

**Net plan-task scope:** ~7 tasks (storage shape + migration; sanitizer with TDD; tool-use call wrapper; orchestrator rewrite; mode-aware Settings; build-outgoing-body branch; manual QA). Plan-writing happens next.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Claude generates HTML with constructs the sanitizer drops, leaving the imported signature visually broken | Sanitizer is allowlist-based, not blocklist — empty output is detected and surfaces as `parse-failed` rather than a garbage signature. The system prompt is restrictive. |
| Outlook desktop on Windows still mis-renders despite the strict subset | Manual QA against a real Outlook desktop install before merge. If a class of constructs still breaks, tighten the system prompt. |
| Vision returns wrong logo bounding box (cuts off text or misses logo entirely) | Sanity-check the bbox before cropping (zero/negative dimensions, >50% of total image area = implausible). On failure, drop the image and proceed with text-only. User can re-import. See Vision Pipeline step 5. |
| Sanitizer has a bug that lets dangerous HTML through | The `WebView` preview is rendered from inline `source={{ html }}` (not a URL), JavaScript is disabled, and external network loads are blocked at the WebView config level. Send-side: outgoing mail goes through Microsoft Graph, which has its own sanitization. Defense in depth. |
| Discriminated union confuses existing storage consumers | Migration is read-only and idempotent; tests cover the legacy-entry path. No write-side migration removes user data. |
| User imports, dislikes the result, can't get back to the form | "Skift til manuel redigering" button is always visible in imported mode and confirmation-gated. |
