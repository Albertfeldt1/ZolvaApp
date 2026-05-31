# Google Drive file Picker — design

**Status:** BUILT 2026-05-31 (uncommitted). Edge fn deployed + smoke-tested; both entry points wired; typechecks clean; 248 tests pass. Google Cloud setup done. Only remaining gate: the device spike (§7) — confirm the Picker renders + browses the full Drive inside the WebView. If it fails there, swap `DrivePickerModal`'s transport to `expo-web-browser` (the edge-fn HTML is reusable).

**Scope:** Make the `drive.file` OAuth scope usable. On 2026-05-31 Drive was switched `drive.readonly` → `drive.file` to win fast Google verification (no restricted-scope CASA review for Drive). Under `drive.file` the app only sees files the user created with Zolva or explicitly granted via the Google Picker — so mailbox-wide search returns ~nothing until a Picker exists. This spec adds that Picker plus the wiring that makes picked files searchable, readable, and ingestible.

## 1. Goal

Let the user grant Zolva access to specific Drive files via the official Google Picker, from both Settings and chat, and have those files immediately work everywhere Drive already works: client `drive_search`/`readDriveFile`, the server agent's `drive.search`, and the onboarding fact-ingestion backfill.

## 2. Non-goals (v1)

- **Per-file revoke.** There is no clean non-destructive "ungrant one file" API under `drive.file` (deleting would delete the user's actual file). v1 revoke is all-or-nothing via the existing full Drive disconnect; users can also remove access from Google's "Apps with access" page. Documented as a known limitation.
- **OneDrive/Microsoft Picker.** Google only for v1.
- **Re-enabling `drive.readonly`** via CASA — a possible later track, out of scope here.
- **A standalone file-browser UI** beyond the simple granted-files list in Settings.

## 3. Key constraints / facts

- `drive.file` grant attaches to the **OAuth client** (client_id), and the app + edge agent share one Supabase-brokered Google client. So a file picked in the app is readable by the **server** agent token too — no per-request ID passing needed (to be confirmed by spike #2).
- After a pick, `files.list` (no query) returns exactly the granted set — powers both the Settings list and the re-run backfill, with no local persistence of picked IDs required.
- The Google Picker, given a `drive.file`-scoped OAuth token, still lets the user **browse their full Drive** to choose what to grant — that browsing happens inside Google's first-party Picker; the grant occurs on selection (to be confirmed by spike #1).
- Pasting a Drive link does NOT grant access — only Picker / "Open with" / app-created files do. The Picker is therefore mandatory, not a convenience.

## 4. Architecture

### 4.1 New / changed pieces

1. **`supabase/functions/drive-picker/index.ts`** (new edge fn) — returns a self-contained HTML page hosting the Google Picker JS. No JWT gate (carries only a referrer-locked browser API key). Bakes `API_KEY` + `APP_ID` (project number) from edge secrets into the HTML; reads the OAuth token from `window.__ZOLVA_OAUTH_TOKEN` injected by RN. Builds a `DocsView` (all types, include folders, `setOwnedByMe(false)` so shared files show), `.setOAuthToken()`, `.setDeveloperKey(API_KEY)`, `.setAppId(APP_ID)`. On pick → `window.ReactNativeWebView.postMessage(JSON.stringify({type:'picked', files:[{id,name,mimeType}]}))`; on cancel → `{type:'cancel'}`; on load/gapi error → `{type:'error', message}`.
2. **`src/components/DrivePickerModal.tsx`** (new) — `<Modal>` wrapping `react-native-webview` (already a dep). Props `{visible, onClose, onPicked}`. On open: `tryWithRefresh('google', …)` for a fresh token, injected via `injectedJavaScriptBeforeContentLoaded` (token never in a URL or network log). `<Stone mood="thinking">` + spinner while loading. `onMessage` → `picked`/`cancel`/`error`. `ProviderAuthError` (not connected / refresh fail) → "Forbind Google først" routed to the existing connect flow rather than opening the WebView. WebView `onError`/`onHttpError` → Danish "Kunne ikke åbne filvælgeren". Single modal only — must not race another native `<Modal>` (iOS modal-stacking hazard).
3. **`src/lib/google-drive.ts`** — add `listAccessibleFiles()`: a `files.list` with no query returning the `drive.file`-granted files (id, name, mimeType, modifiedTime) for the Settings list.
4. **`src/lib/onboarding-backfill.ts`** — extend `startBackfill()` to accept `kinds?: ('mail'|'calendar'|'drive')[]` and pass it in the invoke body. The `onboarding-backfill-start` edge fn already honors `kinds`.

### 4.2 Entry points

- **Settings** (`SettingsScreen.tsx`, Google Drive row): a "Vælg filer Zolva kan se" button (shown when Drive connected) → opens `DrivePickerModal`; below it, a managed list from `listAccessibleFiles()`. On `onPicked`: fire the backfill re-run and refresh the list.
- **In-chat**: when `drive_search` / `readDriveFile` returns empty (or Drive not granted), the tool result carries a sentinel the chat renderer turns into a "Vælg Drive-filer" chip → opens the same `DrivePickerModal`. On `onPicked`: fire backfill re-run + post a short "Tilføjede N filer — prøv igen" line.

### 4.3 Data flow (pick → usable)

```
Tap "Vælg filer" (Settings or chat chip)
 → DrivePickerModal opens WebView → drive-picker edge fn HTML
 → RN injects cachedGoogleToken (+ baked API key + project number)
 → Google Picker shows full Drive; user selects files
 → page postMessage(fileIds) → onMessage resolves onPicked([{id,name,mimeType}])
 → startBackfill({force:true, kinds:['drive']})
     → server fetchDriveCandidates() now sees picked files via files.list
     → Claude extracts facts → insertPendingFacts (dedup-safe) → pending facts in Memory
 → drive_search / readDriveFile (client) AND agent drive.search (server)
   now return picked files (shared OAuth client grant)
```

## 5. Backfill re-run

Both entry points call `startBackfill({ force:true, kinds:['drive'] })` after `onPicked`. `force:true` clears terminal `backfill_jobs` rows and creates only a Drive job; `facts` from mail/calendar persist; `insertPendingFacts` dedup makes repeated picks safe. Picked Google-native docs (Docs/Sheets/Slides the user owns/edited) surface as pending facts in the existing Memory review flow.

## 6. Manual Google Cloud prerequisites (dashboard, like OAuth secrets)

1. Create a **browser API key** in the same Google Cloud project as Zolva's OAuth client; restrict it to the **Picker API** and to the `drive-picker` edge fn's `*.supabase.co` referrer.
2. **Enable the Google Picker API** in that project.
3. Note the **project number** (Picker `appId`).
4. Set edge-fn secrets `GOOGLE_PICKER_API_KEY` and `GOOGLE_PROJECT_NUMBER`.
5. Update the **OAuth consent screen**: drop `drive.readonly`, add `drive.file` (match shipped code).

## 7. De-risking spike (gate — do before any real component)

Minimal WebView + hand-written picker HTML with a `drive.file` token. Confirm:
1. **[make-or-break]** Picker renders inside the WebView and lets the user browse their **full Drive** under `drive.file`. If it fails → fall back to an `expo-web-browser` (system browser) transport.
2. A file picked by the app's OAuth client is then readable by the **server** agent's token (same client_id) via `files.get`/`files.list`. If it fails → pass selected IDs to the server explicitly.

Outcome: a short findings note (cf. the widget keychain spike). Throwaway code, not merged.

## 8. Error handling

- Token expired/refresh-fail → reuse existing re-auth banner; don't open the WebView.
- Not Google-connected → "Forbind Google først" → existing connect flow.
- WebView/gapi/Picker errors → Danish inline message, close modal, no crash.
- Backfill re-run failure → non-fatal; the pick itself already grants access, so search/read still work; surface a soft toast.

## 9. Testing

- **Spike** (§7) validates the two load-bearing assumptions first.
- **Unit:** `listAccessibleFiles()` response parsing; `startBackfill` body includes `kinds`; picker-page message parsing (`picked`/`cancel`/`error`).
- **Manual e2e** (dev build, not Expo Go): connect Google → pick a file → confirm it appears in the Settings list, in client `drive_search`, in agent `drive.search`, and as a pending fact in Memory.

## 10. Shipping order

Per project convention: the `drive-picker` edge fn (and the already-supported `kinds` handling) commit + **deploy first**; then client OTA. Merge to `main` before `eas update`. Dev build (not Expo Go) for e2e.

## 11. Open dependencies before build can start

1. Concurrent `agent-reflect` session lands → working tree clean.
2. Google Cloud prerequisites (§6) done → spike can render the Picker.
