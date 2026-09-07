# pocket-mobile

Arkode Pocket — the read-only mobile credential viewer. See [`docs/pocket.md`](../../docs/pocket.md) for the full architecture, crypto model, and threat model. This file covers only: install/run/test, the manual Google Cloud setup, and how to produce a real installable build.

Arkode Pocket is deliberately small: pairing → biometric unlock → search → credential detail → copy. It never edits anything, never talks to Desktop directly, and never depends on `engine-core` (which is Windows/Node-only — DPAPI, `better-sqlite3`, `ssh2`). Only `pocket-shared` (pure TypeScript, zero platform dependency) is shared with Desktop.

## Status: what's real, what still needs a device

Everything in `src/` is real, working TypeScript, and the pure logic (crypto framing, sync-state decisions, search, freshness copy, the secure-storage/snapshot-cache contract) has 51 passing Jest tests run against `pocket-shared`'s own AES-256-GCM implementation. **What has NOT been exercised in this authoring environment, because it genuinely cannot be** (no Android SDK, no emulator, no physical device, no Google Cloud Console access, no camera): the actual screens rendering, real Android Keystore/iOS Keychain behavior, real QR camera scanning, real Google Sign-In, real biometric prompts, and a real Google Drive round-trip from a phone. `react-native-quick-crypto` itself (a native module) also cannot run under plain Jest — see `src/crypto/cryptoInterop.spec.ts`'s own comment for how the shared byte format is still proven correct without it.

Getting this to a real device requires the manual steps below, done by you.

## Install & run

From the repo root (pnpm workspace):

```
pnpm install --filter pocket-mobile
```

Pure-logic tests (no device/emulator needed):

```
pnpm --filter pocket-mobile test
pnpm --filter pocket-mobile typecheck
```

**This app cannot run in Expo Go.** It uses native modules with no Expo Go equivalent (`react-native-keychain`, `react-native-quick-crypto`, `@react-native-google-signin/google-signin`) — you need an EAS **development build** (a custom dev client, built once, then reused like Expo Go with live-reload for JS changes):

```
# One-time, per platform, from packages/pocket-mobile:
npx eas login
npx eas build --profile development --platform android
# Install the resulting APK on a real Android device (EAS gives you a download link/QR).
# Then, for day-to-day JS development:
pnpm start
```

For a shareable, non-development build (internal testing, not a public store listing — see `eas.json`'s `internal` profile):

```
npx eas build --profile internal --platform android
```

This produces a real, installable `.apk` via Expo's cloud build service — no local Android SDK needed on your machine. iOS follows the same `eas build --platform ios` pattern but needs an Apple Developer account and (for now) hasn't been attempted in this project.

## Manual setup you need to do before any of this works for real

### 1. Google Cloud OAuth client (required for Google Sign-In / Drive access)

Pocket needs its own OAuth client in Google Cloud Console — separate from whatever Desktop's rclone connection uses.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project (or reuse an existing personal one) → **APIs & Services**.
2. Enable the **Google Drive API** for that project.
3. **OAuth consent screen**: choose "External," fill in the minimal required fields, and add your own Google account under "Test users." Leave it in **Testing** status — publishing/verification is not needed for personal use with a handful of test users, and this app only requests `drive.readonly` (see [`docs/pocket.md`](../../docs/pocket.md#mobile) for why that specific scope).
4. **Create credentials → OAuth client ID**, three times:
   - **Web application** (yes, even though there's no web app — `@react-native-google-signin/google-signin` needs a "web client ID" internally to request an ID token it can validate). No redirect URIs needed. Copy the resulting client ID into `app.json`'s `extra.googleWebClientId`.
   - **Android**: package name `com.codebius.arkodepocket` (matches `app.json`), and the **SHA-1 certificate fingerprint** of whatever signs your build. For an EAS build, get it from `npx eas credentials` (select Android → view the keystore) after your first `eas build` run, or from `keytool -list -v -keystore <path>` for a local keystore. You do not need to put this client ID anywhere in the app config — Google Sign-In on Android matches it automatically by package name + SHA-1 at request time.
   - **iOS**: bundle ID `com.codebius.arkodepocket`. Copy the generated iOS client ID's *reversed* form (`com.googleusercontent.apps.XXXX`) into `app.json`'s `plugins` → `@react-native-google-signin/google-signin` → `iosUrlScheme`.
5. Replace the two `REPLACE_WITH_...` placeholders in `app.json` with the real values from steps 4.

**Do not commit real client IDs/secrets if this repository is ever made more widely shared than it is today** — OAuth client IDs are not secret in the way a password is (they're visible in any compiled app binary regardless), but keep them in `app.json` as configuration, not hardcoded inline in source, and never commit a client *secret* (this flow doesn't need one — Google Sign-In's native SDKs use PKCE-style flows, not a client secret).

### 2. EAS project

```
npx eas init
```

This creates a project in your Expo account and writes a real `projectId` into `app.json`'s `extra.eas.projectId` (currently a placeholder).

### 3. Real app icon (optional for a dev build, needed before wider distribution)

`app.json` currently has no `icon` field — Expo falls back to a generic placeholder. Add a real `assets/icon.png` (1024×1024) and set `"icon": "./assets/icon.png"` before distributing this beyond your own test devices.

## What to verify once you have a real device build

This is the actual acceptance checklist from the project brief — walk through it once a real dev-client build is on your phone:

1. Arkode Desktop → Configuración → Arkode Pocket → Configurar Pocket → Conectar Google Drive → Vincular dispositivo (shows the QR).
2. Open Arkode Pocket on the phone → scan the QR → sign in to Google → confirm the first snapshot downloads.
3. Search `<a real client name> <a real credential kind>` → open the credential → copy the password → confirm it lands on the clipboard and clears itself after ~30s.
4. Close the app fully, reopen it → confirm biometric unlock is required again.
5. Turn on Airplane Mode → reopen the app → confirm it still shows the last snapshot with an honest "sin conexión" banner, not a crash or a false "sincronizado."
6. On Desktop, change that credential's password → wait a few minutes (or hit "Publicar ahora") → pull-to-refresh on the phone → confirm the new password shows up.
7. On Desktop, click "Revocar dispositivo" → confirm the phone's *next* refresh attempt fails with the "possibly revoked" message, while still showing its last good data.
