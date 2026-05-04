# Mail Signature — Screenshot Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import their existing signature into Zolva by uploading a screenshot. Claude haiku-4-5 (vision) extracts text fields → form auto-overwrites → user can immediately edit or save. Logo stays on the existing manual picker.

**Architecture:** Extend `claude-proxy` and `src/lib/claude.ts` `ContentBlock` unions to accept `image` blocks (one-line type change in each, the proxy still just forwards). New client lib `src/lib/mail-signature/import-from-screenshot.ts` orchestrates: pick image → compress for vision (1024px JPEG q=0.85) → call `completeJson<ExtractedSignatureFields>` → validate → return `ImportResult`. SettingsScreen `MailSignatureSection` gets a button that runs the orchestrator and overwrites the form on success.

**Tech Stack:** TypeScript, React Native (Expo), expo-image-picker, expo-image-manipulator, Supabase Edge Function (Deno), Anthropic Claude API (vision), Jest.

**Spec:** `docs/superpowers/specs/2026-05-04-signature-screenshot-import-design.md`

---

## Pre-flight

- This builds on the rich-mail-signature feature shipped on `main` at `5336cf0`. The folder `src/lib/mail-signature/` already exists with `types.ts`, `storage.ts`, `template.ts`, `image.ts`, `build-outgoing-body.ts`, `index.ts`, and a `__tests__/` dir.
- Project pattern (`project_client_server_pr_split` memory): **server changes get their own commit and deploy FIRST**. T1 commits + deploys the proxy update; T2+ are client commits afterwards.
- Project uses `npm` (not pnpm/yarn). Run `npm test` for Jest, `npx tsc --noEmit` for typecheck.
- All commits go directly to `main` per `project_solo_no_pr` memory. Worktree-driven if running via subagent-driven-development.
- Supabase project ref: `sjkhfkatmeqtsrysixop`. Edge functions deploy via `supabase functions deploy <name> --project-ref sjkhfkatmeqtsrysixop --no-verify-jwt` (the `--no-verify-jwt` is required because the project signs ES256 JWTs that the gateway can't verify; the function does its own auth — see `project_supabase_asymmetric_jwt` memory).

---

### Task 1: Extend `claude-proxy` to accept image content blocks + deploy

**Files:**
- Modify: `supabase/functions/claude-proxy/index.ts` (the `ContentBlock` union near the top)

This is a server-side, type-only change. The function already forwards messages to Anthropic's `/v1/messages`; we just expand what shapes the type union allows. No new logic, no new env vars, no schema migration.

- [ ] **Step 1: Extend the `ContentBlock` union**

In `supabase/functions/claude-proxy/index.ts`, find the existing union (around line 25–28):

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
```

Replace it with:

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };
```

That's the only change. The function body doesn't reference these types directly (it just forwards `messages` as-is to Anthropic) — the union is purely for the `ProxyRequest` type completeness.

- [ ] **Step 2: Commit (server-only)**

```bash
git add supabase/functions/claude-proxy/index.ts
git commit -m "feat(claude-proxy): accept image content blocks for vision calls"
```

- [ ] **Step 3: Deploy the function**

```bash
supabase functions deploy claude-proxy \
  --project-ref sjkhfkatmeqtsrysixop \
  --no-verify-jwt
```

Expected: "Deployed Function: claude-proxy" with version bumped.

- [ ] **Step 4: Smoke-test the deployed function still works for existing text calls**

Quickest check: open the app on a connected dev build and trigger any existing Claude call (e.g. send a chat message). The text path must still respond normally — we haven't broken it. If the existing app isn't readily available, skip and rely on T6 manual QA.

---

### Task 2: Extend `ClaudeContentBlock` union in client

**Files:**
- Modify: `src/lib/claude.ts` (the `ClaudeContentBlock` union around lines 49–52)

Mirror the proxy's union in the client so `completeJson` callers can build messages with `image` blocks.

- [ ] **Step 1: Extend the union**

In `src/lib/claude.ts`, find:

```ts
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
```

Replace with:

```ts
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };
```

- [ ] **Step 2: Typecheck and confirm no regressions**

```bash
npx tsc --noEmit
```

Expected: PASS (exit 0). The new union member is additive — existing call-sites that only build text/tool_use/tool_result blocks compile unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat(claude): allow image content blocks in client union"
```

---

### Task 3: Pure validators + error mapper (TDD)

**Files:**
- Create: `src/lib/mail-signature/__tests__/import-from-screenshot.test.ts`
- Create: `src/lib/mail-signature/import-from-screenshot.ts` (pure helpers + types only — orchestrator added in Task 4)

Strict TDD: write tests first, confirm they fail, write impl, confirm they pass.

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
import {
  validateExtracted,
  mapClaudeError,
  importResultMessage,
  type ImportResult,
} from '../import-from-screenshot';
import { ClaudeRateLimitError, ClaudeConfigError } from '../../claude';

describe('validateExtracted', () => {
  const valid = {
    name: 'Albert Hangaard',
    title: 'CEO',
    company: 'Zolva',
    phone: '+45 12 34 56 78',
    email: 'albert@zolva.io',
    website: 'zolva.io',
    customLines: 'CVR 12345678',
  };

  it('returns ok with the data when all fields are valid strings', () => {
    const out = validateExtracted(valid);
    expect(out).toEqual({ ok: true, data: valid });
  });

  it('returns parse-failed when a required field is missing', () => {
    const broken = { ...valid } as Partial<typeof valid>;
    delete broken.email;
    expect(validateExtracted(broken)).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('returns parse-failed when a field is the wrong type', () => {
    expect(validateExtracted({ ...valid, name: null })).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted({ ...valid, phone: 42 })).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted({ ...valid, customLines: { foo: 'bar' } })).toEqual({ ok: false, reason: 'parse-failed' });
  });

  it('returns no-data when every field is empty after trim', () => {
    const empty = {
      name: '', title: '', company: '', phone: '', email: '', website: '', customLines: '   ',
    };
    expect(validateExtracted(empty)).toEqual({ ok: false, reason: 'no-data' });
  });

  it('ignores extra fields beyond the known seven', () => {
    const withExtra = { ...valid, somethingElse: 'ignored' };
    expect(validateExtracted(withExtra)).toEqual({ ok: true, data: valid });
  });

  it('returns parse-failed when input is not an object', () => {
    expect(validateExtracted(null)).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted('a string')).toEqual({ ok: false, reason: 'parse-failed' });
    expect(validateExtracted(42)).toEqual({ ok: false, reason: 'parse-failed' });
  });
});

describe('mapClaudeError', () => {
  it('maps ClaudeRateLimitError to rate-limit', () => {
    const err = new ClaudeRateLimitError(60, 'rpm');
    expect(mapClaudeError(err)).toEqual({ ok: false, reason: 'rate-limit' });
  });

  it('maps ClaudeConfigError to unauthorized', () => {
    const err = new ClaudeConfigError();
    expect(mapClaudeError(err)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('maps a TypeError-like network failure to network', () => {
    expect(mapClaudeError(new TypeError('Network request failed'))).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a generic Error to parse-failed (Claude returned something unparseable)', () => {
    expect(mapClaudeError(new Error('JSON.parse failed'))).toEqual({ ok: false, reason: 'parse-failed' });
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

- [ ] **Step 2: Run the test — confirm it fails**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: FAIL with "Cannot find module '../import-from-screenshot'".

- [ ] **Step 3: Write the pure helpers**

Create `src/lib/mail-signature/import-from-screenshot.ts` with **only** the pure functions (orchestrator added in Task 4):

```ts
// src/lib/mail-signature/import-from-screenshot.ts
//
// Vision-based signature import. Pure validation + error mapping live here;
// the picker/Claude orchestrator (pickAndExtractSignature) is added below in
// Task 4 — until then this file exposes only the testable pure layer.

import { ClaudeRateLimitError, ClaudeConfigError } from '../claude';

export type ExtractedSignatureFields = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;
};

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

const REQUIRED_FIELDS = [
  'name', 'title', 'company', 'phone', 'email', 'website', 'customLines',
] as const;

export function validateExtracted(input: unknown): ImportResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'parse-failed' };
  }
  const obj = input as Record<string, unknown>;
  const data: Partial<ExtractedSignatureFields> = {};
  for (const key of REQUIRED_FIELDS) {
    const v = obj[key];
    if (typeof v !== 'string') return { ok: false, reason: 'parse-failed' };
    (data as Record<string, string>)[key] = v;
  }
  // No-data check: every field empty after trim.
  const allEmpty = REQUIRED_FIELDS.every((k) => (data[k] ?? '').trim() === '');
  if (allEmpty) return { ok: false, reason: 'no-data' };
  return { ok: true, data: data as ExtractedSignatureFields };
}

export function mapClaudeError(err: unknown): ImportResult {
  if (err instanceof ClaudeRateLimitError) return { ok: false, reason: 'rate-limit' };
  if (err instanceof ClaudeConfigError)    return { ok: false, reason: 'unauthorized' };
  // React Native fetch network failures surface as TypeError("Network request failed").
  if (err instanceof TypeError && /network/i.test(err.message)) {
    return { ok: false, reason: 'network' };
  }
  // Any other Error (including JSON.parse failures from completeJson, generic
  // 5xx wrapped as Error) → parse-failed. The user-visible message is the same
  // either way: "we couldn't read the screenshot, try again."
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
```

- [ ] **Step 4: Run the test — confirm it passes**

```bash
npx jest src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
```

Expected: 17 tests PASS (6 validateExtracted + 5 mapClaudeError + 1 importResultMessage = 12 — actually count carefully: validateExtracted has 6 tests, mapClaudeError has 5, importResultMessage has 1 with 8 sub-asserts — Jest reports test count, not assert count, so expect 12 tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mail-signature/import-from-screenshot.ts src/lib/mail-signature/__tests__/import-from-screenshot.test.ts
git commit -m "feat(mail-signature): pure validators for screenshot-import"
```

---

### Task 4: Picker + orchestrator (manual smoke-test only)

**Files:**
- Modify: `src/lib/mail-signature/import-from-screenshot.ts` (add orchestrator below the pure helpers from Task 3)

No automated tests for the orchestrator — depends on Expo runtime (image picker) and the live Claude call. Manual smoke-test happens in Task 6 (UI wiring) and Task 7 (final QA).

- [ ] **Step 1: Add the orchestrator**

Append to `src/lib/mail-signature/import-from-screenshot.ts` (below `importResultMessage`):

```ts
// --- Orchestrator (impure: image picker + Claude vision call) ---

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import { completeJson } from '../claude';

const VISION_MAX_DIMENSION = 1024;
const VISION_MAX_BASE64_LEN = 300_000;

const SIGNATURE_EXTRACT_SYSTEM_PROMPT = `You extract structured contact info from a screenshot of an email signature.
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
  buttons.`;

const SCHEMA_HINT =
  '{ "name": string, "title": string, "company": string, "phone": string, "email": string, "website": string, "customLines": string }';

export async function pickAndExtractSignature(): Promise<ImportResult> {
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
  let manipulatedUri: string | null = null;
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
    manipulatedUri = manipulated.uri;
    base64 = manipulated.base64 ?? '';
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
  if (manipulatedUri) {
    // Best-effort tmp-file cleanup. Failures are silent.
    try { await FileSystem.deleteAsync(manipulatedUri, { idempotent: true }); } catch {}
  }
  if (!base64) return { ok: false, reason: 'parse-failed' };
  if (base64.length > VISION_MAX_BASE64_LEN) return { ok: false, reason: 'too-large' };

  let parsed: unknown;
  try {
    parsed = await completeJson<unknown>({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
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
      schemaHint: SCHEMA_HINT,
    });
  } catch (err) {
    return mapClaudeError(err);
  }

  return validateExtracted(parsed);
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS (exit 0).

- [ ] **Step 3: Run all tests as a sanity check**

```bash
npx jest
```

Expected: all PASS (no new tests in this task — Task 3's 12 tests still cover the pure helpers).

- [ ] **Step 4: Commit**

```bash
git add src/lib/mail-signature/import-from-screenshot.ts
git commit -m "feat(mail-signature): screenshot-import orchestrator (picker + vision call)"
```

---

### Task 5: Re-export from public API barrel

**Files:**
- Modify: `src/lib/mail-signature/index.ts`

- [ ] **Step 1: Add re-exports**

In `src/lib/mail-signature/index.ts`, append after the existing `pickAndCompressLogo` export line:

```ts
export {
  pickAndExtractSignature,
  importResultMessage,
} from './import-from-screenshot';
export type {
  ImportResult,
  ExtractedSignatureFields,
} from './import-from-screenshot';
```

- [ ] **Step 2: Typecheck + tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: typecheck exit 0, all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mail-signature/index.ts
git commit -m "feat(mail-signature): re-export screenshot-import from public api"
```

---

### Task 6: Wire into SettingsScreen `MailSignatureSection`

**Files:**
- Modify: `src/screens/SettingsScreen.tsx` (`MailSignatureSection` body around the existing form)

Add the "Importér fra screenshot" button above the form, with loading state and error banner. Logic:

- Tap → `pickAndExtractSignature()`.
- While running, button label changes to reflect compress/vision phase. Single boolean `importing` is enough — we don't need to distinguish "compressing" vs "vision call" in the UI (latency is similar and the messages overlap conceptually).
- On success: `setData(result.data + logo from current data)` + `saveSignature(...)` immediately. (Logo from current data is preserved — extraction never touches it.)
- On failure (other than `cancelled`): show banner via `importResultMessage(result)`.

- [ ] **Step 1: Update the imports block**

Find the existing import block in `src/screens/SettingsScreen.tsx` (added in the earlier rich-signature feature). It currently looks like:

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

Replace with:

```ts
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  pickAndExtractSignature,
  importResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
} from '../lib/mail-signature';
```

- [ ] **Step 2: Add state + handler inside `MailSignatureSection`**

Inside `MailSignatureSection`, just below the existing `pickerBusy` / `pickerError` state declarations, add:

```ts
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const onImportFromScreenshot = async () => {
    setImportError(null);
    setImporting(true);
    const result = await pickAndExtractSignature();
    setImporting(false);
    if (!result.ok) {
      const msg = importResultMessage(result);
      if (msg) setImportError(msg);
      return;
    }
    // Preserve the user's existing logo (extraction never touches it).
    const next: SignatureData = {
      ...EMPTY_SIGNATURE,
      ...result.data,
      logo: dataRef.current.logo,
    };
    setData(next);
    void saveSignature(next);
  };
```

- [ ] **Step 3: Render the button + banner above the form**

Inside the JSX returned by `MailSignatureSection`, just after the existing intro `<Text style={styles.signatureBody}>...</Text>` paragraph and before the first `<SigField ... />`, insert:

```tsx
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
```

- [ ] **Step 4: Add the new style keys**

In the existing `StyleSheet.create({ ... })` block at the bottom of the file, add (alongside the other `sig*` styles introduced by the rich-signature feature):

```ts
sigImportBtn: {
  marginTop: 16,
  padding: 14,
  borderRadius: 12,
  backgroundColor: colors.mist,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.line,
},
sigImportBtnTitle: {
  fontSize: 14,
  fontWeight: '600',
  color: colors.ink,
},
sigImportBtnSub: {
  marginTop: 4,
  fontSize: 12,
  color: colors.fg3,
},
```

All theme tokens used (`colors.mist`, `colors.line`, `colors.ink`, `colors.fg3`) are confirmed present in `src/theme.ts`.

- [ ] **Step 5: Typecheck + tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: typecheck exit 0, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(mail-signature): screenshot-import button in settings"
```

---

### Task 7: Manual smoke-test pass (the spec's QA checklist)

No file changes — this task validates the full flow before declaring done.

- [ ] **Step 1: Start dev build**

If you're running from a worktree, `expo run:ios` once to install the new native deps (none added in this feature, but if the worktree is fresh, do this once). Otherwise `npx expo start --clear` is enough since no new native modules were added.

```bash
npx expo start --clear
```

Open in a dev build (not Expo Go — `feedback_expo_go_limits` memory).

- [ ] **Step 2: Run through the spec's manual QA checklist**

- [ ] **Robert Johnson AV Media screenshot** (the one referenced in the spec) → name "Robert Johnson", title "Co-Founder", company "AV Media", phone "210 - 406 - 5183", email "robert.johnson@avmedia.com", website "www.avmedia.com" or "avmedia.com", customLines empty (social/CTA buttons get ignored per system prompt).
- [ ] **Plain Apple Mail signature** ("Sendt fra min iPhone") → all fields empty → `no-data` banner appears: "Vi kunne ikke aflæse felter fra dette billede. Prøv et tydeligere screenshot."
- [ ] **Screenshot of unrelated content** (e.g. a regular email body, no signature) → `no-data` banner.
- [ ] **Blurry / poor-lighting screenshot** → either extracts what's readable or shows `no-data` banner.
- [ ] **Existing form data + import succeeds** → form is wholesale replaced; AsyncStorage value updated immediately (verify by closing and re-opening Settings — the imported data persists).
- [ ] **Existing form data + import fails** (force a network error by toggling airplane mode mid-import) → form data preserved; `network` banner shown.
- [ ] **Tap import 60+ times in a minute** → `rate-limit` banner appears (verifies the proxy's RPM gate is hit).
- [ ] **Airplane mode** → `network` banner: "Ingen forbindelse. Prøv igen."
- [ ] **Successful import + tap "Vælg billede" to add a logo** → logo lands alongside the imported text fields; full signature renders correctly in the existing preview card and in an actual Outlook reply (use the same end-to-end Outlook test from the rich-signature feature's QA).

- [ ] **Step 3: If everything passes, mark the plan task complete**

No commit needed — this task is verification only.

---

## Done criteria

- All 7 tasks committed.
- `npx jest` clean.
- `npx tsc --noEmit` clean.
- `claude-proxy` redeployed and accepts image content blocks (existing text Claude calls in the app still work).
- Manual QA checklist in Task 7 fully passed against real screenshots.
- No regression for users who never tap the import button — the form behaves exactly as it does today on `main` (the import button is purely additive).
