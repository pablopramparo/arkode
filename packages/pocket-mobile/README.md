# pocket-mobile

Arkode Pocket — the read-only mobile credential viewer. See [`docs/pocket.md`](../../docs/pocket.md) for the full architecture, crypto model, and threat model. This file covers only: install/run/test, the manual Google Cloud setup, and how to produce a real installable build.

Arkode Pocket is deliberately small: pairing → biometric unlock → search → credential detail → copy. It never edits anything, never talks to Desktop directly, and never depends on `engine-core` (which is Windows/Node-only — DPAPI, `better-sqlite3`, `ssh2`). Only `pocket-shared` (pure TypeScript, zero platform dependency) is shared with Desktop.

## Status: shipping, verified on a real device

Arkode Pocket is a real, shipping companion app — v0.2.0, distributed as an EAS-signed Android build (see "Producing a real build" below), verified end-to-end on a physical device: QR pairing, Google Sign-In, biometric unlock (including the cold-start Keystore race), Drive download/decrypt, credential search/copy, offline/airplane-mode startup, the 5-minute unlock grace period (both the within-window and the timeout case), and device revocation. It is **not** a prototype or an unverified build.

58 Jest tests cover the pure logic (crypto framing against `pocket-shared`'s own AES-256-GCM implementation, sync-state decisions, search, freshness copy, Drive file-resolution including the trashed-file edge case below, and the secure-storage/snapshot-cache contract). `react-native-quick-crypto` itself (a native module) can't run under plain Jest — see `src/crypto/cryptoInterop.spec.ts`'s own comment for how the shared byte format is still proven correct without it. Screen rendering, real Keystore/Keychain behavior, camera scanning, Google Sign-In, and Drive round-trips are exercised on a real device, not in this test suite.

**A real bug worth knowing about if you're debugging a "stuck" device**: Desktop's publish flow sends the file it's replacing to Google Drive's Trash, not a hard delete — Drive still serves trashed content by ID with no error. A device's pairing caches the Drive file id it first paired with, so this used to mean a paired device could get permanently stuck on stale data after Desktop's second publish. Fixed in `src/drive/driveClient.ts`'s `resolvePocketFileId()` — it now checks `trashed` and falls back to a fresh name search when the cached id is trashed. See `driveClient.spec.ts` and the top-level `CLAUDE.md`'s "Arkode Pocket" section for the full story.

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

## Producing a real build

The `internal` EAS profile (see `eas.json`) produces a real, installable, **signed** `.apk` via Expo's cloud build service — no local Android SDK needed on your machine, and this is the actual profile the shipped v0.2.0 build used:

```
npx eas build --platform android --profile internal --no-wait   # queue it, don't block the terminal
npx eas build:view <build-id>                                    # poll status / get the artifact URL
```

EAS reuses the existing "Arkode Pocket Android" keystore automatically for every build under this project — you do not need to (and should not) generate or select a keystore manually. `eas build:list --platform android` shows the history of past builds, including their version/versionCode/commit.

iOS follows the same `eas build --platform ios` pattern but needs an Apple Developer account and hasn't been attempted in this project.

### Signing key disaster recovery

The real production Android keystore has a backup outside this repo (see the top-level `CLAUDE.md` for where/how, not duplicated here since that's operational, not code documentation) — if EAS's own copy is ever lost, a new build can still be signed with the exact same Android identity, so no OAuth/SHA-1 reconfiguration would be needed. Never regenerate or rotate this keystore without a real reason — doing so invalidates the existing Google OAuth Android client registration (tied to this exact SHA-1) and breaks every already-installed copy's ability to receive a matching-signature update.

## Manual setup you need to do before any of this works for real

### 1. Google Cloud OAuth client (required for Google Sign-In / Drive access)

Already done for this project's real Android builds (package `com.codebius.arkodepocket` + the production keystore's SHA-1 are registered in Google Cloud Console, confirmed working via real Google Sign-In on a physical device). Redo this section only if you're setting Pocket up fresh under a different Google Cloud project, or adding iOS:

Pocket needs its own OAuth client in Google Cloud Console — separate from whatever Desktop's rclone connection uses.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project (or reuse an existing personal one) → **APIs & Services**.
2. Enable the **Google Drive API** for that project.
3. **OAuth consent screen**: choose "External," fill in the minimal required fields, and add your own Google account under "Test users." Leave it in **Testing** status — publishing/verification is not needed for personal use with a handful of test users, and this app only requests `drive.readonly` (see [`docs/pocket.md`](../../docs/pocket.md#mobile) for why that specific scope).
4. **Create credentials → OAuth client ID**:
   - **Android**: package name `com.codebius.arkodepocket` (matches `app.json`), and the **SHA-1 certificate fingerprint** of whatever signs your build. For the existing EAS build, get it from `npx eas credentials` (select Android → view the keystore) or from `keytool -list -v -keystore <path>` for a local keystore. This is the only OAuth client Android sign-in actually needs — Google Sign-In on Android matches it automatically by package name + SHA-1 at request time, with no client ID stored in app config at all.
   - **Web application**, only if you ever need `requestIdToken()`/`requestServerAuthCode()` (this app currently doesn't — `offlineAccess: false`, no backend). `app.json`'s `extra.googleWebClientId` stays the `REPLACE_WITH_...` placeholder deliberately; see `src/auth/googleAuth.ts`'s own comment for why it's optional here.
   - **iOS** (not yet set up for this project): bundle ID `com.codebius.arkodepocket`. Copy the generated iOS client ID's *reversed* form (`com.googleusercontent.apps.XXXX`) into `app.json`'s `plugins` → `@react-native-google-signin/google-signin` → `iosUrlScheme`.

**Do not commit real client IDs/secrets if this repository is ever made more widely shared than it is today** — OAuth client IDs are not secret in the way a password is (they're visible in any compiled app binary regardless), but keep them in `app.json` as configuration, not hardcoded inline in source, and never commit a client *secret* (this flow doesn't need one — Google Sign-In's native SDKs use PKCE-style flows, not a client secret).

### 2. EAS project

Already done — `app.json`'s `extra.eas.projectId` holds this project's real id. `npx eas init` is only needed again if this app is ever moved to a different Expo account/project.

## Acceptance checklist

The real project brief's end-to-end checklist — already walked through for real on a physical device, kept here as the standard to re-check after any change that touches pairing, sync, or auth:

1. Arkode Desktop → Configuración → Arkode Pocket → Configurar Pocket → Conectar Google Drive → Vincular dispositivo (shows the QR).
2. Open Arkode Pocket on the phone → scan the QR → sign in to Google → confirm the first snapshot downloads.
3. Search `<a real client name> <a real credential kind>` → open the credential → copy the password → confirm it lands on the clipboard and clears itself after ~30s.
4. Close the app fully, reopen it → confirm biometric unlock is required again.
5. Turn on Airplane Mode → reopen the app → confirm it still shows the last snapshot with an honest "sin conexión" banner, not a crash or a false "sincronizado."
6. On Desktop, change that credential's password → wait a few minutes (or hit "Publicar ahora") → pull-to-refresh on the phone → confirm the new password shows up.
7. On Desktop, click "Revocar dispositivo" → confirm the phone's *next* refresh attempt fails with the "possibly revoked" message, while still showing its last good data.
