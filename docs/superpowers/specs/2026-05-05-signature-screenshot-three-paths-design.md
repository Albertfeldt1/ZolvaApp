# Mail signature — three screenshot import paths

**Status:** approved 2026-05-05
**Branch:** `feature/mail-signature-screenshot`
**Predecessors:**
- `2026-05-04-signature-screenshot-import-design.md` (initial scaffolding)
- `2026-05-04-signature-screenshot-html-design.md` (HTML reproduction path)

## Why

The signature settings currently has one screenshot entry point — a big "Importér fra screenshot" button that always replaces the manual form with AI-reproduced HTML (`kind: 'imported'`). There is no way to:

1. Auto-fill the manual form fields from a screenshot while staying in manual mode.
2. Use the screenshot itself directly as the signature image (skip the AI reproduction).

Both are real user paths: (1) is the natural read of "scan this to fill out the form" and (2) gives pixel-perfect fidelity for users whose existing signature is already polished and don't want AI to interpret it.

## What changes

Three distinct screenshot entry points in `MailSignatureSection`:

| # | Path | Lives | Outcome |
|---|------|-------|---------|
| 1 | Fill fields | Inside the manual form | Vision call extracts text fields, populates `StructuredSignature`, stays in `kind: 'structured'` |
| 2 | Reproducér design (existing) | Top of section | Vision call produces HTML reproduction, switches to `kind: 'imported'` |
| 3 | Brug screenshot direkte | Under #2 | No AI call. Compresses the image and uses it as the entire signature, switches to `kind: 'imported'` with `html = <img src="cid:zolva-sig" …>` |

## Components

### New module: `src/lib/mail-signature/fill-fields-from-screenshot.ts`

Mirrors `import-from-screenshot.ts` but with a different tool schema and prompt aimed at structured extraction.

- **Tool:** `fill_signature_fields`
- **Tool schema (input):**
  ```ts
  {
    name: string;
    title: string;
    company: string;
    phone: string;
    email: string;
    website: string;
    customLines: string;       // freeform extras (address, taglines, regulatory text)
    socials: SocialLink[];
  }
  ```
  All string fields default to `""` if not visible.
- **Prompt:** "Extract the structured fields you see in this email-signature screenshot. Use empty strings for fields not present. The customLines field captures lines that don't fit a named field (street address, tagline, license/regulatory text, etc.) — one per line, joined with `\n`. Socials follow the same rules as the import_signature tool."
- **Public function:** `pickAndFillFields(): Promise<FillResult>`
  - `FillResult = { ok: true; data: StructuredSignature } | { ok: false; reason: ... }`
  - When merging into existing form data, the call **overwrites** every field (including blanks). Reason: the user explicitly asked for autofill from this screenshot — partial merges create surprising mixed states. Logo is preserved (vision tool doesn't touch it).
- **Reuses:** image picker / compress / `mapClaudeError` / `importResultMessage` (rename to `claudeErrorMessage` and share, or copy the small switch — copy for now to avoid churn).

### New helper: `pickAndUseScreenshot(): Promise<UseImageResult>` (in `image.ts` or a new `use-screenshot.ts`)

- Image picker + compress → returns an `InlineImage`. No AI.
- Build an `ImportedSignature` with:
  - `html = <table><tr><td><img src="cid:zolva-sig" style="display:block;max-width:600px;height:auto" alt=""></td></tr></table>`
  - `plaintext = ""`
  - `image = <the picked image>`
  - `socials = []`
- Compression target: similar to `pickAndCompressLogo` but with a larger max dimension (1024 long side, JPEG q=0.85) — same as the vision pipeline uses for its resize step. Stays under the same `VISION_MAX_BASE64_LEN` budget so the inline payload doesn't bloat.

### `MailSignatureSection` (in `SettingsScreen.tsx`)

UI changes:

```
Mail-signatur
[description text]

[ 📷 Reproducér fra screenshot ]                ← existing big button (rename)
[ Brug screenshot som billede ]                  ← new smaller secondary button
[importError text]

[if data.kind === 'structured':]
  [ 📷 Udfyld felter fra screenshot ]            ← new compact button, above first field
  Navn  /  Titel  /  Virksomhed  /  …
  Logo  /  Socials  /  Preview

[if data.kind === 'imported':]
  WebView preview
  Skift til manuel redigering
```

State additions:
- `fillingFields: boolean`
- `usingScreenshot: boolean`
- Both share `importError` (one error slot is enough since the actions are mutually exclusive in time).

Handlers:
- `onReproduceFromScreenshot` — current `onImportFromScreenshot`, renamed.
- `onUseScreenshotDirectly` — calls `pickAndUseScreenshot`, sets data.
- `onFillFieldsFromScreenshot` — calls `pickAndFillFields`. On success, replaces the form data (logo preserved). Stays in `'structured'` mode. No mode-switch confirmation prompt — user is already in manual mode and asked for it.

### Public API (`index.ts`)

Export the new functions and result types:
- `pickAndFillFields`
- `pickAndUseScreenshot`
- `FillResult`, `UseImageResult`

## Data model

No type changes. Both new paths produce existing `StructuredSignature` (path 1) or `ImportedSignature` (path 3). The `imported` mode is agnostic to whether its html came from AI or is a single `<img>` — render and send paths already handle both shapes.

If we later need to distinguish in UI (e.g., suppress the "Reload preview" button for image-only since reload doesn't help), we add `source?: 'ai' | 'image'` to `ImportedSignature` then. Out of scope now.

## Error handling

- All three paths use the existing image-picker error reasons (`permission-denied`, `cancelled`, `too-large`, `no-data`, `parse-failed`, `network`, `rate-limit`, `unauthorized`).
- Path 1 (fill fields) — vision call same as path 2; same error mapping.
- Path 3 (use screenshot) — no AI call, so only `permission-denied | cancelled | too-large | parse-failed`.
- Errors render in the existing `sigError` slot. Cancelled returns silently.

## Testing

### Unit tests (Jest)
- `fill-fields-from-screenshot.test.ts` — parse `fill_signature_fields` tool output for: well-formed input, missing socials array, partial fields, malformed types. Mirrors the existing `import-from-screenshot.test.ts` shape.
- `use-screenshot.test.ts` — verify the generated html is a single `<img src="cid:zolva-sig">` table, plaintext is empty, image dims propagate.

### Manual verification
- Pick a known signature screenshot in manual mode → fields populate, mode stays manual.
- Pick a screenshot via "Brug screenshot direkte" → preview shows the picture, no AI delay.
- Pick a screenshot via "Reproducér" → existing flow, unchanged.
- Cancel each picker → no error toast, no state change.
- Send a test email in each mode → signature renders correctly in Outlook + iCloud preview.

## Out of scope

- Distinguishing AI-reproduced vs image-only imported signatures in the UI.
- Mid-flow chooser ("after picking image, ask which path") — three explicit buttons is clearer.
- Re-running fill on top of existing manual data with smart merging — explicit overwrite is the chosen behavior.
- Editing the picked image (crop/resize UI) — out of scope; user picks again if unhappy.

## Build sequence

1. `fill-fields-from-screenshot.ts` + tests
2. `use-screenshot.ts` (or extend `image.ts`) + tests
3. `index.ts` exports
4. `MailSignatureSection` UI + state wiring
5. Styles for new buttons
6. Manual verification on a dev build
