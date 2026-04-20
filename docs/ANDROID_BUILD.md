# Android Build & Distribution (Demo)

This runbook produces a signed **APK** for internal / sideload distribution to
an Android teammate. iOS is the primary platform — the Android build exists for
demo purposes only. Do not ship this to the Play Store until the follow-ups in
the "Before public release" section are resolved.

- Package name: `com.zolva.app` (matches iOS bundle identifier)
- EAS project: `@albertfeldt1/zolva-app` (ID `e66ee3ef-8891-477c-aff9-c5e7d6d3a828`)
- Push delivery on Android: **FCM v1** (not legacy — see §3)

---

## 1. One-time setup: Firebase project + google-services.json

The Expo push service needs a Firebase project registered against the Android
package so FCM can route notifications to the app.

1. Go to <https://console.firebase.google.com> and sign in with the Zolva
   Google account.
2. If a Zolva project already exists, select it. Otherwise: **Add project →
   Name: `Zolva`** → accept defaults → Create.
3. Inside the project, click the Android icon ("Add app → Android") and fill in:
   - **Android package name:** `com.zolva.app` (must match exactly — the build
     will fail if it differs from `android.package` in `app.json`)
   - App nickname: `Zolva Android` (display-only)
   - SHA-1: leave blank for now (only required if you later add Google Sign-In
     directly via Firebase — we currently broker OAuth through Supabase, so
     this is not needed for the demo)
4. Click **Register app** and then **Download `google-services.json`**.
5. Drop the file at the **repository root** (same folder as `app.json`).
   ```
   /Users/albertfeldt/ZolvaApp/google-services.json
   ```
6. Do **not** commit it. `.gitignore` already excludes `google-services.json`.
   Sanity check:
   ```
   git status --ignored | grep google-services.json
   ```
   should list the file as ignored.

You can skip the remaining Firebase "Add SDK" wizard steps — EAS handles the
native integration via the Expo plugin.

---

## 2. One-time setup: FCM v1 service account JSON → EAS

**This is where people lose hours.** The credential EAS needs is a **service
account JSON**, not the legacy server key (deprecated June 2024, Expo no
longer accepts it) and not the web API key (that's for browser clients).

### Exact click path

1. Firebase Console → gear icon (top-left, next to "Project overview") →
   **Project settings**.
2. Top tab bar → **Service accounts**.
3. There will be several subsections. Scroll to **Firebase Admin SDK** (not
   "Cloud Messaging API (Legacy)" — ignore anything labelled "legacy" or
   "server key").
4. Click **Generate new private key** → confirm in the modal → a `.json` file
   downloads. The filename looks like `zolva-xxxx-firebase-adminsdk-yyy.json`.
   Keep it somewhere safe; treat it as a secret.
5. Upload to EAS:
   ```
   eas credentials
   ```
   → select **Android** → select profile (**preview** for the demo build) →
   **Push Notifications: Manage your Google Service Account Key for Push
   Notifications (FCM V1)** → **Upload a new service account key** → path to
   the JSON.
6. EAS confirms: `Service account key for push notifications (FCM V1) is set up.`

If you see any menu item referencing "FCM Legacy Server Key" — do **not** use
it. Close and retry from step 1.

---

## 3. Build the APK

Prerequisites (verify before running):
- [ ] `google-services.json` exists at repo root
- [ ] FCM v1 service account key uploaded (§2)
- [ ] You are logged into EAS: `eas whoami` shows `albertfeldt1`
- [ ] Placeholder assets replaced or accepted (see §7 — adaptive icon + notification icon are clearly marked `TODO: REPLACE`)

Build:
```
eas build --platform android --profile preview --non-interactive
```

The `preview` profile produces an **APK** (not AAB) so the teammate can
sideload without going through the Play Store. Build takes ~10–15 minutes.
EAS will print a URL to the build status page; download the APK from there
when it finishes.

---

## 4. Install APK on a test device

Share the APK download URL (or the file itself) with the Android teammate,
then:

1. On the device, open the APK link in Chrome (or any browser).
2. Chrome will warn: "This type of file can harm your device." Tap **Download
   anyway**.
3. Open the downloaded file. Android will block the install and prompt to
   enable **"Install unknown apps"** for the current app (Chrome / Files /
   whichever opened the APK).
4. Grant that permission → return to the install prompt → **Install**.
5. Launch the app.

This permission is per-source, not global — if they use Files app to install,
they grant it to Files; Chrome separately. It stays granted until revoked.

---

## 5. Verification checklist

On the test device, confirm:

- [ ] App launches to the Today tab without crashing
- [ ] Settings → sign in with Google completes (browser opens → consent →
      deep link back to the app lands you signed in)
- [ ] After sign-in, toggle "Nye mails" in Settings — the permission prompt
      appears once, toggle sticks
- [ ] In Supabase → `push_tokens` table, a new row exists for the test user
      with `platform = 'android'` and a non-null token
- [ ] Send a test notification via <https://expo.dev/notifications>:
  - Paste the token from `push_tokens.token`
  - Title: "Zolva test" / Body: "hello"
  - Confirm the notification lands on the device within ~10s
  - Tap it → app opens to the correct tab

If all five pass, the build is ready to hand off.

---

## 6. Troubleshooting

**Build fails: "Missing google-services.json"**
→ File not at repo root, or misnamed. Must be exactly `google-services.json`
at the same level as `app.json`.

**Build fails: "Package name mismatch"**
→ `android.package` in `app.json` (`com.zolva.app`) must match the package
name registered in Firebase. If you created the Firebase Android app with a
different name, delete it in Firebase Console → Project settings → General
→ "Your apps", re-add with `com.zolva.app`, re-download
`google-services.json`.

**Push token registration fails silently**
→ Check logs (`adb logcat | grep -i expo` on a connected device). Usually one
of:
- FCM v1 credentials not uploaded in EAS → redo §2
- `expo.extra.eas.projectId` in `app.json` doesn't match the linked EAS
  project → run `eas project:info` and verify
- `google-services.json` was present at build time but the package name
  inside it doesn't match `com.zolva.app` — re-download from Firebase

**Push received but notification doesn't appear**
→ Android notification channel issue. Expo creates a default channel
automatically on first token request; if it's missing, foreground the app
once after install to trigger channel creation, then resend.

**OAuth redirect lands on a blank browser tab instead of the app**
→ Deep link not resolving. Verify `zolva://` is the scheme in `app.json`
(top-level and inside `android.intentFilters`). After reinstalling, test
the link manually:
```
adb shell am start -a android.intent.action.VIEW -d "zolva://test"
```
Should open the Zolva app.

**"App not installed" on device**
→ Usually a signature mismatch from a prior sideload. Uninstall the previous
Zolva APK (long-press → Uninstall) and reinstall.

---

## 7. Known Android-specific risks

### Placeholder assets — replace before any public build

- `assets/android/adaptive-icon-foreground.png` — 1024×1024, burned-in
  "TODO: REPLACE" text and warning stripes. Inside the safe zone (center 66%)
  so it's visible once the Android launcher crops the outer third.
- `assets/android/notification-icon.png` — 96×96, monochrome white
  placeholder silhouette (a ring + exclamation mark).
- The `notification.color` in `app.json` is `#5C7355` (sage) — pick a brand
  color post-asset-replacement if that's wrong.

If either file is missing, the Android build falls back to Expo's default
icon, which is worse than a clearly-labelled placeholder.

### Google OAuth "unverified app" warning

Google shows a scarier warning on Android than iOS ("this app is blocked" →
**Advanced** → "Go to Zolva (unsafe)"). Practice the click path before the
demo — the default reflex is to back out.

### Background push delivery is OEM-dependent

Aggressive battery optimization on some Android OEMs (Xiaomi, Huawei,
OnePlus, Samsung one-handed mode) can silently drop pushes when the app is
killed. Not a code bug; a platform reality. If the teammate's demo device is
one of these brands and push feels inconsistent, have them:
- Settings → Apps → Zolva → Battery → "Unrestricted"
- Disable "adaptive battery" globally if possible

Pixel devices behave best for push reliability.

### APK sideload permission

Android requires "Install unknown apps" permission per-source (see §4). The
teammate will see a security prompt the first time. This is expected, not a
bug — include the one-line "tap Settings → grant permission → return"
instruction when you send the APK link.

---

## 8. Cross-terminal coordination

Findings from this setup that touch files owned by other terminals:

- **Apple Sign-In button** — already correctly gated. `appleAvailable` in
  `src/lib/auth.ts:710` is computed as `Platform.OS === 'ios'` and the
  `LoginCard` in `src/screens/SettingsScreen.tsx:530` only renders the button
  when that's true. No change needed. (T4 copy work is unaffected.)
- **Push registration** (`src/lib/push.ts`) — already cross-platform. Uses
  `Notifications.getExpoPushTokenAsync` (works on both) and stores
  `Platform.OS` against each token so the backend can platform-target. No
  change needed from T2.
- **Safe-area handling — FLAG for T5.** The app does not use
  `react-native-safe-area-context` (not a dependency). `SafeAreaView` is not
  used in any screen. Top-edge padding relies on `StatusBarScrim` which
  hardcodes `Platform.OS === 'ios' ? 54 : 40`. On Android devices with
  taller status bars (punch-hole cameras, some notches >40dp) content will
  render underneath the bar. Not a blocker for the demo on a standard Pixel,
  but will break on Samsung S-series / some Xiaomi / Huawei hardware. T5 to
  decide whether to install `react-native-safe-area-context` and wrap
  screens, or measure `StatusBar.currentHeight` dynamically.
- **EAS project ID** — `extra.eas.projectId` was a `TODO_...` placeholder
  that would have blocked production push token registration. Committed a
  real UUID (`e66ee3ef-...`) as part of this work. T3 should verify this
  matches their expectations; if T3 has a different project ID in mind,
  delete the `extra.eas` field and re-run `eas init --force --non-interactive`.

---

## 9. Before public release (post-demo TODOs)

Not required for the demo hand-off. Captured here so nothing is lost:

- [ ] Replace placeholder adaptive icon + notification icon with real brand
      assets (see §7)
- [ ] Consider `expo-auth-session`-based web Apple OAuth as an Android
      fallback if cross-platform Apple sign-in becomes a product requirement
- [ ] Install `react-native-safe-area-context` and wrap screens in
      `SafeAreaView` (T5)
- [ ] Switch `production` profile to AAB upload + Play Console internal
      testing track (already configured: `buildType: "app-bundle"` under
      production in `eas.json`)
- [ ] Request only the Android permissions the app actually uses. Currently
      the `android.permissions` array is omitted from `app.json` — the
      `expo-notifications` plugin auto-adds `POST_NOTIFICATIONS` (the real
      Android 13+ constant) to the manifest. Do not add `READ_CONTACTS`,
      `RECORD_AUDIO`, `CAMERA`, etc. unless a feature genuinely needs them;
      Play Store review punishes over-permissioning.
