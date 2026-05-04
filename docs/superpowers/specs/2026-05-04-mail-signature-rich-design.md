# Mail Signature — Rich (HTML + Logo) — Design

**Date:** 2026-05-04
**Branch:** main (feature branch TBD at implementation time)
**Status:** Approved via brainstorm, ready for implementation plan.

## Goal

Replace today's plaintext-only manual mail signature with a structured-form signature that supports a logo image and renders as HTML in outgoing Outlook mail. Users with a company-provided "PNG and stuff" signature can reproduce it inside Zolva so their Outlook mail looks the same as it does from any other client.

## Scope (this spec)

- **In:** structured-form signature builder in Settings; AsyncStorage persistence per user; HTML render with optional inline logo; Outlook send / draft / reply paths in `src/lib/microsoft-graph.ts` switched to HTML+attachment when a signature is configured; silent migration of existing plaintext signatures.
- **Out (explicitly deferred):**
  - **iCloud send.** No iCloud send path exists today (`icloud-mail.ts` is read-only). The signature module is built provider-agnostic so that when iCloud SMTP is built later, it consumes the same `appendRichSignature` helper. Wiring lands in that future spec.
  - **Gmail signature override.** Gmail continues to fetch the user's existing sendAs signature automatically (`src/lib/gmail.ts:271+`).
  - **HTML paste / power-user mode.** No raw-HTML input. Structured form only.
  - **Per-layout templates.** One built-in layout. Multi-layout selection deferred.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Providers wired in this spec | Outlook only (iCloud later) |
| Authoring UI | Structured form (name, title, company, phone, email, website, custom lines, logo) |
| Image storage | AsyncStorage as base64 (no Supabase Storage) |
| HTML rendering | Pure TS template literal in `template.ts` (no JSX-to-HTML lib, no per-layout choice) |
| Migration UX | Silent. Old plaintext lands in `customLines` field; user can re-arrange when convenient. |

## Architecture

### Module: `src/lib/mail-signature/`

Promotes the flat `mail-signature.ts` (98 lines, plaintext I/O only) to a folder so storage / template / image responsibilities stay independently testable.

```
src/lib/mail-signature/
  index.ts        # public API, re-exports from internal files
  types.ts        # SignatureData, RenderedSignature, InlineImage
  storage.ts      # AsyncStorage persistence + per-user keys + migration
  template.ts     # pure renderSignature(data) → RenderedSignature | null
  image.ts        # pickAndCompressLogo() → { base64, mimeType, width, height } | null
  build-outgoing-body.ts  # provider-agnostic body+attachments builder
```

### Data model (`types.ts`)

```ts
export type SignatureData = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;   // multiline freeform; also the destination for migrated plaintext
  logo: InlineImage | null;
};

export type InlineImage = {
  base64: string;        // raw base64, no data URI prefix
  mimeType: 'image/png' | 'image/jpeg';
  width: number;         // pixels — used for the <img> attribute, not for further compression
  height: number;
};

export type RenderedSignature = {
  html: string;
  plaintext: string;     // plaintext alternative for multipart/alternative when iCloud lands
  image: { contentId: 'zolva-sig'; bytes: string; mimeType: 'image/png' | 'image/jpeg' } | null;
};
```

All `SignatureData` text fields default to empty string. Empty signature = every text field is `''` and `logo` is `null` → `renderSignature` returns `null` and the send path falls through to today's plaintext behavior.

### Public API (`index.ts`)

```ts
export function loadSignature(): Promise<SignatureData | null>;
export function saveSignature(data: SignatureData): Promise<void>;
export function subscribeSignature(fn: (data: SignatureData | null) => void): () => void;
export function renderSignature(data: SignatureData): RenderedSignature | null;

// Provider-agnostic helper. Outlook calls it now; iCloud SMTP will call it
// when that path is built.
export function buildOutgoingBody(rawBody: string): Promise<{
  contentType: 'text' | 'html';
  content: string;
  attachments: InlineAttachmentSpec[];
}>;

export type InlineAttachmentSpec = {
  filename: string;       // 'signature.png' | 'signature.jpg'
  mimeType: string;
  contentBytes: string;   // base64
  contentId: string;      // 'zolva-sig' — matches <img src="cid:...">
};
```

`buildOutgoingBody` is the only function the send paths consume. It returns enough that any provider (Graph API, raw SMTP MIME, etc.) can assemble a correct outgoing message.

## Settings UI

`MailSignatureSection` in `src/screens/SettingsScreen.tsx` (currently a single multiline TextInput at lines 127–173) is replaced with a structured form. Field set, in Danish to match the rest of the screen:

| Label | Field | Input |
|---|---|---|
| Navn | `name` | single-line |
| Titel | `title` | single-line |
| Virksomhed | `company` | single-line |
| Telefon | `phone` | single-line, `keyboardType="phone-pad"` |
| Email | `email` | single-line, `keyboardType="email-address"` |
| Website | `website` | single-line, `autoCapitalize="none"` |
| Egne linjer | `customLines` | multiline textarea |
| Logo | `logo` | image picker button → `[thumbnail] [Fjern]` once set |

Each field auto-saves on blur (matches today's pattern). Whole `SignatureData` JSON-stringified to AsyncStorage on each save.

**Live preview card** below the form, rendered with React Native components (not WebView):

```
── Forhåndsvisning ───────────────────────────
[logo thumbnail] Albert Hangaard · CEO
                 Zolva
                 T: +45 12 34 56 78 · albert@zolva.io
                 zolva.io
                 (custom lines, if any)
```

The preview is structurally faithful but not pixel-perfect — real Outlook / Apple Mail / Gmail rendering varies per client, so a "this is what I'm sending" approximation is enough.

**Image picker flow** (`image.ts`):

1. `expo-image-picker` → photo library, single image, `mediaTypes: 'Images'`
2. `expo-image-manipulator` → resize so longest side ≤ 400px
3. PNG input stays PNG (preserves transparency for typical company logos); anything else → JPEG quality 0.8
4. Base64-encode the result
5. Reject if final base64 length > 150_000 chars (~110KB binary). Show "Billedet er for stort, vælg en mindre fil."
6. On accept, return `InlineImage` and the form writes it into `data.logo`

**Required new deps** (neither currently in `package.json`):
```
npx expo install expo-image-picker expo-image-manipulator
```

Both are official Expo modules — no infra concerns. iOS info.plist photo-library permission string ("Vælg et logo til din mail-signatur.") needs adding to `app.json` `expo.ios.infoPlist.NSPhotoLibraryUsageDescription`.

## HTML template (`template.ts`)

Single source of truth, ~30 lines. All user-supplied strings pass through `escapeHtml` first.

```ts
export function renderSignature(data: SignatureData): RenderedSignature | null {
  const e = escapeHtml;
  const lines: string[] = [];
  const headerParts: string[] = [];

  if (data.name)  headerParts.push(`<strong>${e(data.name)}</strong>`);
  if (data.title) headerParts.push(e(data.title));
  if (headerParts.length) lines.push(headerParts.join(' · '));

  if (data.company) lines.push(e(data.company));

  const contactParts: string[] = [];
  if (data.phone) contactParts.push(`T: ${e(data.phone)}`);
  if (data.email) contactParts.push(`<a href="mailto:${e(data.email)}">${e(data.email)}</a>`);
  if (contactParts.length) lines.push(contactParts.join(' · '));

  if (data.website) {
    const href = data.website.startsWith('http') ? data.website : `https://${data.website}`;
    lines.push(`<a href="${e(href)}">${e(data.website)}</a>`);
  }

  if (data.customLines.trim()) {
    // Each line goes into the <br>-joined list — no <p> wrapping here, that
    // would nest paragraphs inside a <br> sequence.
    lines.push(escapeWithBrBreaks(data.customLines));
  }

  if (lines.length === 0 && !data.logo) return null;

  const textBlock = `<div style="font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">${lines.join('<br>')}</div>`;
  const imgBlock = data.logo
    ? `<div style="margin-top:8px"><img src="cid:zolva-sig" alt="" width="${data.logo.width}" height="${data.logo.height}" style="display:block;border:0"></div>`
    : '';
  const html = `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr><td>${imgBlock}${textBlock}</td></tr></table>`;

  const plaintext = renderPlaintext(data);  // sibling helper, joins fields with newlines for multipart/alternative — used by iCloud SMTP later

  return {
    html,
    plaintext,
    image: data.logo
      ? { contentId: 'zolva-sig', bytes: data.logo.base64, mimeType: data.logo.mimeType }
      : null,
  };
}
```

Layout is image-on-top-of-text wrapped in a `<table>` for Outlook-desktop compatibility (Outlook on Windows uses Word's HTML rendering engine which mishandles flexbox/grid). Inline styles only — `<style>` blocks get stripped by Gmail.

## Outlook send-path patches (`microsoft-graph.ts`)

Replace `appendManualSignature` (lines 321–326) with calls to `buildOutgoingBody`. Three send paths affected:

| Path (line ref) | No signature configured | Signature configured |
|---|---|---|
| `sendMail` (l. 292) | unchanged: single POST to `/me/sendMail` with `body.contentType: 'text'` | single POST with `body.contentType: 'html'` + `attachments` array (inline logo) |
| `createDraft` — new mail (l. 256–286) | unchanged: POST `/me/messages` text | POST `/me/messages` HTML + attachments |
| `createDraft` — reply (`replyToId`) | unchanged: createReplyDraft → PATCH text body | createReplyDraft → PATCH HTML body → POST `/messages/{draftId}/attachments` (inline) → return draft id |
| `replyToMessage` (l. 227) | unchanged: POST `/me/messages/{id}/reply` with `comment` field | **rewrite:** POST `/createReply` → PATCH body → POST `/attachments` → POST `/send` (4 round-trips, only when signature is configured) |

The `replyToMessage` rewrite is the only structural change. Cost: 4 Graph round-trips per reply for users with a configured signature; ≤ 1 round-trip for users without (path unchanged). Acceptable — replies aren't latency-critical and this is the only Graph-supported way to send an HTML reply with an inline image.

**Body conversion** uses two separate pure helpers (split to avoid the "paragraphs nested inside `<br>`" trap):

- `escapeWithBrBreaks(s)` — escapes HTML entities, replaces every `\n` with `<br>`. Used for `customLines` inside the signature template.
- `bodyToParagraphs(s)` — escapes HTML entities, splits on `\n\n+` into paragraphs, replaces remaining `\n` with `<br>` inside each paragraph, wraps each in `<p>...</p>`. Used to convert the user's plaintext email body before concatenating with the signature HTML.

Both pure, snapshot-tested.

**Inline image embedding:** template emits `<img src="cid:zolva-sig">`; Graph attachment carries:
```json
{
  "@odata.type": "#microsoft.graph.fileAttachment",
  "name": "signature.png",
  "contentType": "image/png",
  "contentBytes": "<base64>",
  "isInline": true,
  "contentId": "zolva-sig"
}
```
The `cid:` reference resolves to the attachment in any RFC 2392-compliant client (Outlook desktop, OWA, Apple Mail, Gmail web, Thunderbird).

**No-signature regression risk:** users without a configured signature get *zero* behavior change — same payload, same `contentType: 'text'`, same single API call for replies. The HTML/attachment path activates only when `renderSignature` returns non-null.

## Migration

Inside `loadSignature()` (`storage.ts`), runs once per uid per session:

```
loadSignature(uid):
  v2 = AsyncStorage.getItem('zolva.mail.signature.v2.{uid}')
  if v2:
    try: return JSON.parse(v2) as SignatureData
    catch: console.warn(...); return null

  v1 = AsyncStorage.getItem('zolva.mail.signature.{uid}')
  if v1:
    migrated = { ...emptyDefaults, customLines: v1 }
    write v2; remove v1
    return migrated

  legacy = AsyncStorage.getItem('zolva.mail.signature')   ← global pre-multi-account key
  if legacy:
    migrated = { ...emptyDefaults, customLines: legacy }
    write v2; remove legacy
    return migrated

  return null
```

Existing per-user plaintext or legacy global plaintext both end up in `customLines`. The next mail send produces the same content as before, just inside `<p>...</p>` instead of plaintext concat.

**No nag UI.** Settings reflects the migrated state on next visit; user re-arranges fields when convenient.

**Defensive on malformed v2 JSON:** treat as no signature, log a `console.warn`, do not crash.

## Testing

Jest, `__tests__/` co-located dirs (matches `chat-claim-guard.test.ts`, `widget-snapshot.test.ts`, `reminders.test.ts`).

| File | Coverage |
|---|---|
| `mail-signature/__tests__/template.test.ts` | `renderSignature` for shapes: empty / name-only / full / logo-only / customLines-only / all fields populated. HTML output matches snapshot. XSS safety: `<script>alert(1)</script>` in any field gets entity-escaped, never appears literally in the output. |
| `mail-signature/__tests__/storage.test.ts` | Migration: v1 plaintext → v2 + v1 deleted; legacy global → v2 + legacy deleted; v2 already present → no migration; nothing → returns null; malformed v2 JSON → returns null + warn. Per-user isolation: uid A doesn't read uid B's signature. |
| `mail-signature/__tests__/build-outgoing-body.test.ts` | Empty signature → `{ contentType: 'text', content: rawBody, attachments: [] }`. Signature without logo → html, no attachments. Signature with logo → html + 1 inline attachment, correct contentId. Body plaintext-to-HTML conversion preserves single `\n` as `<br>` and `\n\n` as paragraph break. HTML-escapes user body content. |

Skipped from automated tests:
- **Image picker / compression flow** — depends on Expo runtime + native pickers. Manual smoke-test in dev: pick a >1MB photo, confirm it gets compressed to <150KB and renders in the preview.
- **Outlook send paths** — thin Graph wrappers; mocking Graph adds noise without value. Verified manually instead.

### Manual QA checklist

1. New install + no v1 plaintext → Settings shows empty form, no signature gets appended.
2. Existing install with v1 plaintext → Settings shows old text in `Egne linjer`; mail still sends with same content.
3. Fill structured fields, no logo → reply renders HTML signature, no attachment.
4. Add logo → reply renders HTML signature with inline image. Verify in: Outlook desktop (Windows + Mac), OWA web, Apple Mail iOS, Gmail web.
5. Remove logo → reply goes back to no-attachment HTML.
6. Clear all fields → mail sends with no signature (text mode, single API call).
7. Image >150KB original → upload rejected with friendly Danish message.

## Files touched

**New:**
- `src/lib/mail-signature/index.ts`
- `src/lib/mail-signature/types.ts`
- `src/lib/mail-signature/storage.ts`
- `src/lib/mail-signature/template.ts`
- `src/lib/mail-signature/image.ts`
- `src/lib/mail-signature/build-outgoing-body.ts`
- `src/lib/mail-signature/__tests__/template.test.ts`
- `src/lib/mail-signature/__tests__/storage.test.ts`
- `src/lib/mail-signature/__tests__/build-outgoing-body.test.ts`

**Deleted:**
- `src/lib/mail-signature.ts` (replaced by folder; imports updated)

**Modified:**
- `src/lib/microsoft-graph.ts` — `sendMail`, `createDraft`, `replyToMessage` switch to `buildOutgoingBody`; `replyToMessage` rewritten for HTML+attachment path
- `src/screens/SettingsScreen.tsx` — `MailSignatureSection` becomes form + preview
- `app.json` — add `NSPhotoLibraryUsageDescription`
- `package.json` — add `expo-image-picker` + `expo-image-manipulator` (via `npx expo install`)

## Risk / known limitations

- **Outlook desktop on Windows** uses Word's HTML engine. Layout uses tables + inline styles to compensate. Manual QA on Windows Outlook is non-negotiable.
- **Gmail web image proxy** rewrites `cid:` references to a `googleusercontent.com` URL. This works for received mail but means Gmail web users will see the image proxied. Functionally fine, just notable.
- **Image base64 inflates AsyncStorage row.** Worst case: 150KB binary → ~200KB base64. Well within AsyncStorage's per-row practical limits but the `mail-signature.v2.{uid}` row is now an order of magnitude larger than the old plaintext row. Acceptable — only one such row per user.
- **No iCloud send wiring this spec.** When iCloud SMTP is built later, that spec wires `buildOutgoingBody` into the SMTP MIME assembly. Until then, iCloud mail sent from Zolva carries no signature (matches today — iCloud send doesn't exist).
