# Mail Signature — Screenshot Import — Design

**Date:** 2026-05-04
**Branch:** main (feature branch TBD at implementation time)
**Status:** Approved via brainstorm, ready for implementation plan.
**Builds on:** `docs/superpowers/specs/2026-05-04-mail-signature-rich-design.md` (rich signature feature, shipped on main as of `5336cf0`).

## Goal

Let users import their existing signature into Zolva by uploading a screenshot. Claude vision extracts the text fields (name, title, company, phone, email, website, plus best-guess "custom lines") and auto-fills the structured form. Removes the biggest setup-friction point — typing seven fields by hand — without losing any of the form's editability or the existing logo-picker flow.

## Scope (this spec)

- **In:** "Importér fra screenshot" button in the existing `MailSignatureSection`; client lib `import-from-screenshot.ts` that picks a screenshot, compresses for vision, calls Claude via `completeJson`, validates + returns the structured fields; one-line type-union extension to `claude-proxy/index.ts` and `src/lib/claude.ts` to allow `image` content blocks; auto-overwrite of form fields on success; non-destructive error states; manual QA against real screenshots.
- **Out (explicitly deferred):**
  - **Logo extraction from the screenshot.** User still uploads the logo separately via the existing `pickAndCompressLogo` button. Cropping a 100–200px logo out of a screenshot delivers a worse logo than the user has on file, and adds bbox-misalignment failure modes for marginal UX gain.
  - **Multi-template gallery / AI-generated layouts.** Different brainstorm; not blocked by this work.
  - **Confirmation modal / per-field checkbox import.** Auto-overwrite is the chosen UX; no diff modal.
  - **Undo of an import.** Form is wholesale replaced on success; previous values are gone. User can re-import or re-type.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Logo handled by import? | No — text fields only; logo stays on the existing picker. |
| Confirmation flow for extracted data | Auto-overwrite the form (no modal, no diff). |
| Vision provider / call path | Claude (haiku-4-5, vision-capable) via the existing `claude-proxy` edge function; client uses `completeJson<T>` from `src/lib/claude.ts`. |
| New edge function vs. extend existing | Extend `claude-proxy` — it's already a generic forwarder. One-line `ContentBlock` union extension in both proxy + client. |

## Architecture

### Data flow

```
User taps "Importér fra screenshot"
  → src/lib/mail-signature/import-from-screenshot.ts
    → expo-image-picker (single image, photo library)
    → expo-image-manipulator (resize: max 1024px long edge, JPEG q=0.85)
    → completeJson<ExtractedSignatureFields>(...)  via src/lib/claude.ts
      → POST /functions/v1/claude-proxy   (extended ContentBlock union accepts 'image')
        → Anthropic /v1/messages with claude-haiku-4-5-20251001 (vision)
      ← parsed JSON: { name, title, company, phone, email, website, customLines }
    ← validated ImportResult
  → SettingsScreen overwrites form data + saveSignature() persists immediately
```

### Files touched

**New:**
- `src/lib/mail-signature/import-from-screenshot.ts` — `pickAndExtractSignature()` orchestrator + validation
- `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts` — pure unit tests with `completeJson` mocked

**Modified:**
- `src/lib/claude.ts` — extend `ClaudeContentBlock` union with `image` block shape
- `supabase/functions/claude-proxy/index.ts` — mirror the same one-line addition to its `ContentBlock` union
- `src/lib/mail-signature/index.ts` — re-export `pickAndExtractSignature` + `ImportResult` from the new module
- `src/screens/SettingsScreen.tsx` — add "Importér fra screenshot" button above the form, hook up the orchestrator, render loading state and error banner

### Why a separate orchestrator file

Keeping the import logic in `import-from-screenshot.ts` (separate from `image.ts` and the existing `mail-signature/` files) preserves single-responsibility:

- `image.ts` is the **logo** picker (compresses to 400px, base64-encodes for `<img cid:>` embedding).
- `import-from-screenshot.ts` is the **OCR-source** picker (compresses to 1024px, sent to Claude vision, never persisted as an image).

These have different compression targets, different consumers, different error modes — different responsibilities.

### Image compression target

Vision-capable Claude models accept images up to 1568px on the long edge before automatic downscaling. Targeting **1024px long edge, JPEG quality 0.85** balances:

- **Readability:** typical signatures with 12px text remain crisp at 1024px.
- **Bandwidth:** base64 of a 1024×768 JPEG is ~150KB; at 1568px it'd be ~300KB.
- **Cost:** Anthropic pricing scales with image dimensions; smaller = cheaper.

Hard cap on the post-compression base64: **300_000 chars (~220KB binary)**. If exceeded, return `error: 'too-large'`.

## Vision call shape

### Schema we ask Claude to return

```ts
type ExtractedSignatureFields = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;     // anything that doesn't fit other fields, joined by \n
};
```

Every field is `string`, never `null`. Missing data = empty string. Matches our `EMPTY_SIGNATURE` defaults so spreading the result into the form is trivial.

### Call

```ts
const result = await completeJson<ExtractedSignatureFields>({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 400,
  system: SIGNATURE_EXTRACT_SYSTEM_PROMPT,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: 'Extract the signature fields from this screenshot. Return JSON only.' },
      ],
    },
  ],
  schemaHint:
    '{ "name": string, "title": string, "company": string, "phone": string, "email": string, "website": string, "customLines": string }',
});
```

### System prompt

```
You extract structured contact info from a screenshot of an email signature.
Return ONLY a JSON object with these exact keys, all strings:
  name, title, company, phone, email, website, customLines

Rules:
- If a field is not visible in the screenshot, return an empty string ("").
- Do NOT invent or guess data not visible in the screenshot.
- "name" is the person's name (e.g. "Albert Hangaard").
- "title" is their job title (e.g. "CEO", "Co-Founder").
- "company" is the organization name.
- "phone" is the most prominent phone number, formatted as shown.
- "email" is the most prominent email address.
- "website" is the URL without "https://" prefix (e.g. "zolva.io").
- "customLines" captures anything else relevant — disclaimers, addresses,
  multiple phone numbers, secondary fields — joined with newlines. Empty
  if nothing else.
- Ignore decorative elements: logos, social icons, "Kind regards", action
  buttons.
```

### Validation post-parse

`completeJson` enforces the type at compile time only — at runtime Claude could return any JSON shape. We validate explicitly:

1. **Type check.** For each of the seven fields, `typeof parsed[field] === 'string'`. If any field is missing or non-string (e.g. `null`, `42`, an object), return `error: 'parse-failed'`.
2. **No-data check.** If every field's `.trim()` is empty, return `error: 'no-data'` — Claude saw the image but extracted nothing. This is treated as a soft failure (banner with retry hint), distinct from `parse-failed` (Claude returned malformed data).

Extra fields beyond the seven we care about are silently ignored.

## ContentBlock type-union extensions

### `src/lib/claude.ts`

Add to the `ClaudeContentBlock` union (currently `text | tool_use | tool_result`):

```ts
| {
    type: 'image';
    source: {
      type: 'base64';
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      data: string;       // base64, no data: URI prefix
    };
  };
```

### `supabase/functions/claude-proxy/index.ts`

Mirror the same addition to the proxy's local `ContentBlock` union (the function only forwards messages to Anthropic — no new logic, just type acceptance).

The proxy's existing per-user rate limits (`RPM_LIMIT = 60`, `DAILY_LIMIT = 500`) cover vision calls automatically. Vision calls cost more per-call (image tokens), but we're not introducing a new attack surface — the same JWT auth and rate limits apply.

## UX flow

### Entry point

Above the existing form fields in `MailSignatureSection`:

```
Mail-signatur
─────────────
Bruges ved mails sendt fra Outlook (...).

┌────────────────────────────────────────────┐
│  📷 Importér fra screenshot                │
│  Lad Zolva udfylde felterne fra et         │
│  billede af din nuværende signatur.        │
└────────────────────────────────────────────┘

Navn          [_______________]
... (rest unchanged)
```

The button has a one-line subhead because the affordance isn't self-evident — users need to understand it's a fast-path, not a marketing button.

### States

| State | Behavior |
|---|---|
| Idle | "📷 Importér fra screenshot" |
| Picker open | (native iOS picker — cancel returns to idle silently) |
| Compressing | "Forbereder billede…", disabled |
| Vision call in flight | "Læser signatur…", disabled |
| Success | Form fields populate visibly. `saveSignature(extracted)` fires immediately. Button returns to idle. |
| `no-data` (Claude found nothing) | Button → idle. Banner: "Vi kunne ikke aflæse felter fra dette billede. Prøv et tydeligere screenshot." |
| `network` | Banner: "Ingen forbindelse. Prøv igen." |
| `rate-limit` | Banner: "For mange forsøg. Prøv igen om lidt." |
| `parse-failed` | Banner: "Vi kunne ikke aflæse billedet. Prøv igen eller udfyld manuelt." |
| `too-large` | Banner: "Billedet er for stort, vælg en mindre fil." |
| `unauthorized` | Banner: "Log ind igen for at importere." (defensive — shouldn't trigger in normal use) |

### Error invariants

- **Errors never wipe form data.** A failed import leaves whatever was already in the form fields exactly as it was.
- **Success persists immediately** via explicit `saveSignature(extracted)` — the form's auto-save-on-blur doesn't fire (no field was blurred), so we trigger persistence ourselves.
- **No undo.** Wholesale replace matches the "I want this signature now" mental model. User re-imports or re-types if it goes wrong.

## Public API

`src/lib/mail-signature/import-from-screenshot.ts`:

```ts
export type ImportResult =
  | { ok: true; data: ExtractedSignatureFields }
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

export async function pickAndExtractSignature(): Promise<ImportResult>;

// User-facing Danish messages for failure reasons. Mirrors the pattern of
// pickResultMessage in image.ts. 'cancelled' returns '' so the UI shows
// nothing.
export function importResultMessage(result: Extract<ImportResult, { ok: false }>): string;
```

Re-exported from `src/lib/mail-signature/index.ts` alongside the existing public API.

## Testing

| File | Coverage |
|---|---|
| `mail-signature/__tests__/import-from-screenshot.test.ts` | Pure unit tests for the parse/validate layer with `completeJson` mocked. Cases: (1) valid full response → `ImportResult.ok` with the data; (2) missing required field → `parse-failed`; (3) wrong type (e.g. `name: null` or `name: 42`) → `parse-failed`; (4) all-empty fields → `no-data`; (5) underlying `completeJson` throws `ClaudeRateLimitError` → `rate-limit`; (6) generic network error → `network`; (7) auth error from `completeJson` → `unauthorized`. |

**Skipped from automated tests:**
- **Image picker / compression flow** — same rationale as `pickAndCompressLogo`: depends on Expo runtime + native pickers.
- **The actual vision call to Anthropic** — non-deterministic; we don't snapshot Claude's output. Manual smoke-test against real screenshots.
- **`claude-proxy` `ContentBlock` union extension** — pure type change. No existing edge-function tests in the project except `widget-action/index.test.ts`. Verified by typecheck + manual deploy + the same QA path.

### Manual QA checklist

1. **Robert Johnson AV Media screenshot** → name "Robert Johnson", title "Co-Founder", company "AV Media", phone "210 - 406 - 5183", email "robert.johnson@avmedia.com", website "www.avmedia.com" (or "avmedia.com"), customLines empty.
2. **Plain Apple Mail signature** ("Sendt fra min iPhone") → all fields empty → `no-data` banner.
3. **Screenshot of unrelated content** (regular email body, no signature) → `no-data` banner.
4. **Blurry / poor-lighting screenshot** → extracts what's readable, or `no-data`.
5. **Form had data + import succeeds** → form wholesale replaced, AsyncStorage value updated immediately.
6. **Form had data + import fails** → form data preserved, banner shown.
7. **60+ taps per minute** → `rate-limit` banner (verifies the proxy's RPM gate).
8. **Airplane mode** → `network` banner.
9. **Successful import + tap "Vælg billede" to add a logo** → logo lands alongside imported text fields; the full signature renders correctly in the existing preview card and in an actual Outlook reply.

## Risk / known limitations

- **Vision quality varies by screenshot.** Hand-photographed screens, low-resolution captures, or signatures rendered in unusual fonts can produce empty or partial results. The `no-data` and `parse-failed` paths handle this gracefully — user falls back to manual entry.
- **Cost.** Vision calls are more expensive than text. The proxy's `DAILY_LIMIT = 500` per user is a hard ceiling; in practice users will use the import once or twice per setup.
- **Hallucination.** The system prompt explicitly says "Do NOT invent or guess." We rely on Claude obeying. If we see frequent hallucinated fields in QA, we tighten the prompt or add a confidence check.
- **Logo from screenshot is intentionally not extracted.** Anyone expecting "fully reproduces my signature" needs to upload the logo file separately. Acceptable given the alternative — cropping a low-res sliver of the screenshot — produces visibly worse results.
