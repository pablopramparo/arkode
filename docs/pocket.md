# Arkode Pocket

A read-only mobile viewer for the credentials stored in Arkode's vault. "Credentials in your pocket" — nothing more. Arkode Desktop is the only source of truth; Pocket only ever consumes what Desktop publishes.

This document covers the architecture, trust model, and operational details. For the mobile app's own build/run instructions, see [`packages/pocket-mobile/README.md`](../packages/pocket-mobile/README.md).

## Scope, explicitly

Pocket v1 includes: clients, credentials (with their full secret payload — password/token/clientSecret/privateKey/privateKeyPassphrase/custom/notes), URLs, search, per-client navigation, credential detail with copy, biometric lock, offline use of the last good snapshot, pairing by QR, and single-device revocation.

Pocket v1 explicitly does **not** include: backup tasks, runs, repositories, replication targets, transports/database connections, schedules, logs, general settings, tool registries, or vault notes/snippets/processes. It is not "Arkode Mobile" — there is no administration surface here, and there never should be. `pocket-shared`'s `validatePocketSnapshotPayload` enforces this at the format level: any of the above accidentally leaking into a snapshot is a hard parse error, not a silently-ignored field.

## Architecture overview

```
Arkode Desktop (Windows, engine-core + engine-cli)
  vault_credentials / vault_urls / clients   (Tier 2, master-password-gated)
        │  (only while the vault is unlocked)
        ▼
  buildPocketSnapshotPayload()  →  PocketSnapshotPayload (plaintext, in-memory only)
        │
        ▼  encrypted under the Pocket DEK (AES-256-GCM, NOT the vault DEK)
  runPocketPublish()  →  arkode-pocket-sync.json
        │  upload temp name → download+verify+decrypt locally → rename over the real file
        │  (rclone, reusing the EXACT SAME plumbing replication/.arkvault backup already use)
        ▼
  Google Drive (Desktop's own account, or a dedicated one — Pocket's choice)
        │  ciphertext only — Google never sees plaintext or the Pocket DEK
        ▼  Drive REST v3, Pocket's OWN independent Google Sign-In (drive.readonly)
Arkode Pocket (Android/iOS, Expo/React Native)
  download → parse envelope → decrypt with the Pocket DEK (Keystore/Keychain, biometric-gated)
        │
        ▼
  in-memory PocketSnapshotPayload → local tokenized search → credential detail → copy
```

Two independent Google accounts are involved, by design: Desktop's rclone connection (already used for replication and `.arkvault` backup) and Pocket's own Google Sign-In on the phone. **Desktop's OAuth token is never handed to the phone.** Each side authenticates to Google on its own; the only thing that crosses the Desktop→phone boundary is the Pocket DEK, and only once, during pairing.

## Trust boundaries

- **The vault's master password never leaves Desktop.** Pocket has no concept of it.
- **The vault DEK never leaves Desktop's process memory**, and is not the same key that protects Pocket's snapshot. Compromising a phone's Pocket DEK gives an attacker read access to whatever was published — never to the vault itself, never to any other Desktop secret (DB passwords, SSH keys, restic keys, rclone tokens — none of those are in the Pocket snapshot).
- **Google Drive only ever stores ciphertext.** Google's own systems never see plaintext credentials or the Pocket DEK.
- **A locked vault has zero effect on Pocket's own security** — Pocket's key material was already handed over at pairing time and lives entirely on the phone from then on. But a locked vault DOES block Desktop from *publishing* (`buildPocketSnapshotPayload` needs to decrypt credential secrets, which requires the vault DEK).

## Crypto model

Pocket has its own, deliberately simpler, independent cryptographic model — see `packages/pocket-shared/src/crypto.ts`'s own header comment for the full reasoning. Summary:

- A random 32-byte **Pocket DEK**, generated once (`generatePocketDek`), unrelated to the master password, the vault KEK, or the vault DEK.
- AES-256-GCM, one random 12-byte nonce per encryption, never reused with the same key (proven by test — see `packages/pocket-shared/test/crypto.spec.ts`).
- **No KDF, no wrapped-key envelope, no verifier blob** — unlike `.arkvault`'s vault-crypto model (`scrypt` → KEK → wrapped DEK → verifier), Pocket's DEK is handed to the device directly, not derived from a human-memorized secret. There is nothing to "verify" separately from decryption itself: AES-GCM's own authentication tag already tells you definitively whether the key was right.
- **No separate SHA-256/checksum anywhere.** GCM's 128-bit auth tag is cryptographically stronger than a bolted-on hash and already covers every corruption/tampering scenario a checksum would. Adding one would be pure ceremony.
- Self-describing ciphertext framing (`magic "ARKB" | version | algId | nonce | ciphertext | tag`), independent of the outer JSON envelope, so the format can evolve (algorithm agility) without touching the envelope.

## The `arkode-pocket-sync` format

One file, JSON, uploaded to a configured Drive folder as `arkode-pocket-sync.json`:

```json
{
  "magic": "ARKPKT",
  "formatVersion": 1,
  "pocketId": "<uuid>",
  "revision": 57,
  "generatedAt": "2026-09-06T14:03:00.000Z",
  "payload": "<base64 of the AES-256-GCM blob>"
}
```

**What's deliberately in the clear**: `pocketId` (a random UUID, reveals nothing), `revision` and `generatedAt` (needed so freshness/versioning can be checked without decrypting — a minor, accepted metadata leak: "how often does this person change credentials," nothing about *what* changed).

**What's never in the clear, under any circumstance**: client names, credential names, hosts, usernames, database names, URLs, tags, environments, descriptions, and every secret field. All of it lives exclusively inside `payload`.

The encrypted payload (`packages/pocket-shared/src/types.ts`'s `PocketSnapshotPayload`):

```ts
{
  formatVersion: 1,
  clients: [{ id, name }],
  credentials: [{ id, clientId, name, kind, environment, tags, host, port, username,
                  databaseName, url, favorite, description,
                  secret: { password?, token?, clientSecret?, privateKey?,
                            privateKeyPassphrase?, custom?, notes? } }],
  urls: [{ id, clientId, name, url, environment, tags, favorite, description }],
}
```

`validatePocketSnapshotPayload` is a strict allow-list validator — an unrecognized top-level key, an unrecognized field on a credential, or an unrecognized `secret.*` key is a hard parse error. This is the mechanism that guarantees no out-of-scope domain object (a backup task, a repository, a note) can ever end up inside a Pocket snapshot, even if a future bug in the snapshot builder tried to put one there.

**Private keys are included, deliberately** (see `types.ts`'s own comment) — Pocket is a read-only viewer/copier, the same risk class as a password. It never writes a key to a file, never offers to import it, never opens an SSH connection.

## Where the Pocket DEK lives

- **Desktop**: Tier-1 DPAPI (`MachineDpapiSecretStore`, LocalMachine scope) under the fixed ref `pocket:dek` — the exact same mechanism every other operational secret in this app already uses (rclone tokens, restic recovery keys, transport passphrases). Not Tier-2 (the master-password-gated vault) — the DEK is not itself protected by, or derived from, the master password.
- **Android**: Android Keystore, via `react-native-keychain`, gated by `BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` (biometric re-enrollment invalidates it — see "Biometrics & lifecycle" below) and `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- **iOS**: iOS Keychain, same library, same access control constant, same `THIS_DEVICE_ONLY` accessibility (excludes it from iCloud Keychain sync — see below for why that matters).

No `securityLevel`/hardware-only is forced — StrongBox/Secure-Enclave-backed storage is used opportunistically when the device offers it, but Pocket never demands it (which could otherwise fail pairing outright on a device with no dedicated secure element).

## Pairing

Single device, v1. Desktop's "Vincular dispositivo" generates a QR whose payload is:

```json
{ "v": 1, "pocketId": "...", "dek": "<base64, 32 bytes>", "drive": { "fileId": "...", "remotePath": "Arkode/Pocket", "fileName": "arkode-pocket-sync.json" } }
```

The QR carries the raw Pocket DEK directly. This is deliberate: there is no return channel from phone to Desktop in a plain QR scan, so a multi-device envelope-encryption scheme (a per-device key, with Desktop wrapping a content key once per authorized device) isn't buildable without a second round-trip the user explicitly didn't want for v1. A physically-presented, short-lived QR is an accepted transport for a device key — the same trust model WhatsApp Web's or Signal's "link a device" QR use. **Whoever scans this QR gets full read access until the device is revoked.**

**Desktop never claims a device is "connected."** There is no return channel, so Desktop genuinely cannot know whether — or when — a phone actually scanned the code. The UI only ever says "código de vinculación generado el `<timestamp>`," never "dispositivo vinculado." This is intentional honesty, not a missing feature — see "What Desktop can and cannot know" below.

`drive.fileId`, when present, lets the phone skip a `files.list` search and go straight to `files.get` for the one file it needs. It's only known once Desktop has published at least once — "Vincular dispositivo" is only offered once Pocket is configured and has completed its first publish.

## Revision & dirty semantics

Two internal, invisible-to-the-user counters decide when a republish is needed — deliberately not a boolean:

- `change_seq` — incremented by SQL triggers (not application code) on every Pocket-relevant mutation: `vault_credentials`/`vault_urls` insert/update/delete, a credential's secret blob (`vault_secrets`, `vault:credential:*` refs only — a vault item's sensitive body never triggers this), and a client's `name`/`is_active` change. Implementing this at the SQL level, not via an explicit `markDirty()` call threaded through every mutation call site, means a future call site (a new CLI command, a new serve endpoint, a config-import path) can never silently forget to flag Pocket stale.
- `published_seq` — the `change_seq` value that was current at the **start** of the most recently *confirmed* publish.

`dirty = change_seq > published_seq`. A plain boolean can't safely express "a mutation landed while the publish was mid-upload" — clearing a boolean after that upload finishes would silently swallow the concurrent edit. The counter comparison naturally keeps `dirty` true in that case, correctly queuing a follow-up publish (see `runPocketPublish.spec.ts`'s dedicated race test).

`last_confirmed_revision` / `last_attempted_revision` are the small, **user-facing** "Revisión: N" counters — deliberately separate from `change_seq` (which counts every mutation and would be a meaningless number to show anyone). The revision to attempt is always `lastConfirmedRevision + 1`, computed fresh at the start of each attempt — a retry after a failure reuses the same number rather than inflating it.

A never-yet-published Pocket configuration is treated as dirty from the moment it's configured (see `pocket_state`'s `published_seq` starting at `-1`) — this also correctly covers pre-existing vault data created before Pocket was ever configured, which never had a chance to bump `change_seq`.

### The exact scenario the design was built around

1. Desktop publishes revision 50, confirmed.
2. A password changes → Pocket goes dirty.
3. Desktop attempts to publish revision 51 → the upload fails (network, auth, whatever).
4. State: `lastConfirmedRevision = 50`, `lastAttemptedRevision = 51`, `dirty = true`, `lastError = "..."`. The UI shows **"Pendiente de publicar"**, never "Al día" — it never lies about being in sync.
5. Drive comes back. The next attempt (retry, the debounce sweep, or a manual "Publicar ahora") allocates the same revision 51 again (since `lastConfirmedRevision` is still 50) and, on success: `lastConfirmedRevision = 51`, `dirty = false`, `lastError = null`.

If Arkode is closed before the debounce timer fires, `dirty` is a durable DB column, not in-memory state — the next app start/vault-unlock runs a catch-up publish attempt automatically (see "Auto-publish" below), so a pending change is never silently lost to a closed app.

## Auto-publish

Requested and built into v1 from the start — a manual-only "Publicar ahora" loses most of its value if a changed password just sits unpublished until someone remembers.

- **Debounce**: a bounded-**staleness** window, not a sliding quiet-period debounce. Checked every 60s (cheap — one DB read when nothing is due); a pending change older than ~3 minutes gets published. This is deliberate: a sliding "wait for editing to stop" debounce would never fire during a long active-editing session; a bounded-staleness window guarantees the phone is never more than a few minutes behind, regardless of how long the session runs.
- **Catch-up**: fired on every vault unlock/init/change-password/auto-unlock event, and immediately after `/pocket/configure` itself (so a first-time setup doesn't have to wait out the debounce window for its very first publish).
- **Concurrency**: a single in-process lock (`withPocketLock`, `pocketPublishLock.ts`) serializes every publish *and* revoke attempt. Two concurrent "Publicar ahora" clicks never race the same revision (the second one, once its turn comes, simply sees `dirty === false` and no-ops). A revoke can never let a publish that started after it slip through using the old, soon-to-be-dead key — see "Revocation" below for the exact guarantee.
- **Manual override**: "Publicar ahora" always works, `force`-bypassing the dirty check (useful right after a change you need on your phone in the next two minutes, not three).

## Upload safety

`rclone copyto` straight onto the final filename is **not** treated as good enough on its own, even though Google Drive's own resumable upload protocol commits content atomically per request (a dropped connection cannot leave the previous file half-overwritten — that's Drive's own honesty, not something this code controls). Instead (`runPocketPublish.ts`):

1. Upload to a **temporary** remote name.
2. Download it back down and **fully decrypt and validate it locally** — the strongest possible check, not just a size/hash comparison.
3. Only then, `rclone moveto` the verified temp file over the real filename. For the Drive backend this is a metadata-only rename (`files.update` with a new name — no re-upload), the closest thing Drive's API offers to a real atomic replace.

`lastConfirmedRevision` only advances after that rename succeeds. A failure at any earlier step leaves the previously-published file completely untouched — proven directly in `runPocketPublish.spec.ts` (a failed upload, and separately a corrupted verify-download, both leave the prior file byte-for-byte unchanged).

## Revocation

Single device (v1) makes this simple: revoking rotates the Pocket DEK. There is no fan-out to "the other authorized devices" because there aren't any in v1.

**What revocation does:**
- Generates a fresh Pocket DEK, overwriting the old one in Tier-1 storage.
- Marks Pocket dirty (even with zero content changes) so the very next publish uses the new key.

**What revocation explicitly does NOT do** (the UI says this plainly, not just in this doc):
- Does not erase, or promise to erase, data the device already downloaded and decrypted.
- Does not sign the device out of Google — that's Google's own account-security surface (`myaccount.google.com/security`), unrelated to a Pocket-level revoke, since the phone authenticates to Drive with its own independent Google Sign-In, not a grant Desktop can revoke.
- Does not invalidate passwords the device already saw. If a real compromise is suspected, rotate the exposed credentials themselves — revoking Pocket access doesn't do that for you.

**Concurrency guarantee, precisely** (`pocketPairing.ts`'s own doc comment): revoke and publish share the same lock. Any publish that has not yet **started** when revoke runs will, once it does start, read the Pocket DEK fresh and get the new key — a publish starting after revoke returns can never use the old key. A publish that was *already in flight* (mid-upload) when revoke was requested finishes using the key it captured at its own start — treated as correct, not a bug, the same way a revoked API key doesn't retroactively fail a request already in flight.

## What Desktop can and cannot know

Desktop can know: when it last successfully published, what revision that was, whether the last attempt failed and why, and when a pairing QR was generated.

Desktop **cannot** know: whether any phone ever scanned that QR, whether a phone has ever successfully downloaded a given revision, or when a phone was last opened. There is no telemetry, no heartbeat, no presence signal in v1 — Drive is a dumb blob store, and Pocket never talks to Desktop directly. The UI is written to never claim otherwise (see "Pairing" above).

## Offline behavior & failure modes

Pocket works fully offline against the last good cached snapshot. The **hard rule**, enforced by `packages/pocket-mobile/src/sync/syncState.ts`'s `decideSnapshotUpdate` (unit-tested exhaustively): a failed or ambiguous update **never** replaces the last good cached snapshot. Every code path either explicitly adopts a new, successfully-decrypted, strictly-newer snapshot, or leaves the existing cache completely untouched.

| Situation | Cache | Home screen banner |
|---|---|---|
| Fresh check, nothing changed | unchanged | "Actualizado hace X" |
| Fresh check, newer revision | replaced | "Actualizado hace X" (fresh) |
| No network / Drive unreachable | unchanged | "Sin conexión — mostrando la copia de hace X" |
| Google Sign-In / token failure | unchanged | "Google Drive necesita reconexión — mostrando la copia de hace X" |
| Downloaded file is corrupt/truncated | unchanged | "No se pudo verificar la última actualización — mostrando la copia de hace X" |
| Decrypts with the wrong key (rotated/revoked) | unchanged | "Este dispositivo puede haber sido revocado — volvé a vincularlo" |
| A future, unsupported format version | unchanged | "Esta actualización requiere una versión más nueva de Arkode Pocket" |

No background fetch, no fighting Doze/App Standby — v1 checks on app foreground and on pull-to-refresh only, which is sufficient given the debounce/catch-up design already keeps Desktop's own publish latency low.

## Mobile security specifics

- **Biometric gate**: the *real* gate is `react-native-keychain`'s own OS-enforced access control on the stored item — reading it is what natively triggers the biometric/passcode prompt, cryptographically tied to the key material by the Secure Enclave/TEE. `expo-local-authentication` is used only for a pre-flight capability check ("does this device even have biometrics enrolled"), never as the actual gate — a standalone `authenticateAsync()` boolean would be a weaker, spoofable JS-level check with no binding to the real secret.
- **Biometric re-enrollment**: `BIOMETRY_CURRENT_SET` invalidates the stored key if the enrolled biometrics change (a new fingerprint/face added). This is correct behavior, not a bug to route around — a changed biometric set is a real security-relevant event, and the honest response is "re-pair," not "silently keep trusting whatever's enrolled now."
- **Lifecycle**: backgrounding the app clears the decrypted snapshot from JS memory and re-locks (requiring the gate again on foreground); an always-mounted, opacity-toggled "privacy curtain" (`App.tsx`) covers the screen the instant the app resigns active — faster than waiting for a full React re-render to clear sensitive text, which matters for keeping plaintext out of the OS app-switcher thumbnail. No idle timeout while the app stays actively foregrounded.
- **Screenshots**: Android gets `FLAG_SECURE` (via `expo-screen-capture`, applied globally for the app's lifetime, for simplicity) — blocks screenshots and the recent-apps thumbnail outright. iOS has no such API; Apple provides no way to block a screenshot, and this app does not claim otherwise. The privacy curtain is the only iOS mitigation, and only for the app-switcher case, not an explicit user-initiated screenshot.
- **Clipboard**: copy-with-auto-clear (~30s), mirroring Desktop's own `useClipboardAutoClear`. Deliberately never reads the clipboard back to check "is it still ours" before clearing (that read itself triggers the OS's own clipboard-access indicator) — the auto-clear only fires if this app is the one that put something there, tracked with a simple in-memory flag, so backgrounding the app never wipes clipboard content copied from somewhere else.
- **Root/jailbreak**: best-effort only (`jail-monkey`), a non-blocking warning. Trivially bypassable on a genuinely tampered device, so it is never used to refuse to run — that would only punish legitimate power users while giving everyone else false confidence.
- **OS backups**: `android:allowBackup="false"` in `app.json`. The cached (still-encrypted) snapshot file lives under `cacheDirectory`, which is excluded from iOS's iCloud/iTunes device backup and Android's Auto Backup by definition — treated honestly as a disposable cache (a lost cache just means one re-download from Drive, never data loss, since Desktop remains the source of truth), not as the "last good copy that must survive at all costs." The Pocket DEK itself uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which additionally keeps it out of iCloud Keychain sync — without that, a user with iCloud Keychain enabled could end up with Pocket "paired" on a second Apple device that never went through an explicit pairing QR.
- **Logs / crash reporting**: no crash-reporting SDK is installed in v1 (no Sentry/Crashlytics) — consistent with this project's broader stance of not adding a third-party service without a specific decision to do so. No code path in this app logs the Pocket DEK, a decrypted secret, or the raw QR payload.

## `.arkvault` disaster-recovery interaction

Pocket sync is **not** a disaster-recovery mechanism, and `.arkvault` remains the only one — see the top-level `CLAUDE.md`'s own `.arkvault` section. What Pocket adds is a small, additive field on `.arkvault`'s existing v2 payload (`InnerPayloadV2.pocketSync`, absent entirely on older exports or when Pocket was never configured — no format-version bump, same pattern already established for `vaultBackupTargets`):

- Carries the Pocket DEK, Pocket's own Drive account token, and `lastConfirmedRevision`.
- On restore into a fresh install, `pocketStateRepo.restore()` recreates the **same** `pocketId` and DEK — an already-paired phone keeps working with **no re-pairing** — and seeds `lastConfirmedRevision` so the *next* publish continues the sequence (e.g. 58, not 1). Resetting to 1 would make an already-ahead phone (which has already seen revision 57) permanently reject every future publish as "older" — see `decideSnapshotUpdate`'s own revision-comparison logic. The restore is deliberately marked **not dirty** — nothing is assumed to have changed by the act of restoring.
- If the Pocket DEK or Drive token was missing at export time (a Tier-1 secret gone missing), the restore proceeds for everything else and surfaces a clear warning instead of failing outright.

**A deliberate, documented limitation, inherent to point-in-time recovery — not a bug**: restoring an *older* `.arkvault` brings back whatever Pocket DEK was current at that export's time. If a device was revoked after that export was taken, the restored key is the pre-revocation one, and that device could open snapshots again. There is no way around this within a point-in-time-snapshot model — every other secret in `.arkvault` has the identical property (a restored DB password is likewise whatever was current at export time). The practical mitigation, not enforced by code: take a fresh `.arkvault` backup right after revoking a device.

Per-machine auto-unlock (the DPAPI-CurrentUser-sealed KEK material) is explicitly **not** part of this, and never will be — it's inherently per-machine, unrelated to Pocket's own key material.

## Threats & trade-offs

| Threat | Mitigation / accepted trade-off |
|---|---|
| Lost phone, unlocked | Keystore/Keychain + biometric gate is the same trust boundary any serious password manager relies on |
| Lost phone, locked | Reasonably protected; revoke from Desktop + the OS's own Find My Device/Find My is the real remediation |
| Rooted/jailbroken phone | Best-effort warning only, never a block — see "Root/jailbreak" above |
| Shoulder-surfing during QR pairing | Accepted — the QR is a short-lived, physically-presented, single-use transport, same model as other apps' "link a device" QR |
| Revoked device retains already-downloaded plaintext | Accepted and stated plainly in the UI — never promised otherwise |
| Google account compromise (either side) | Google only ever holds ciphertext under either account; the Pocket DEK never touches Drive |
| Supply-chain risk in mobile dependencies | Kept deliberately minimal — see `packages/pocket-mobile/package.json`; this app handles plaintext secrets in memory, so its dependency surface is treated with the same scrutiny as Desktop's |
| Desktop compromise while the vault is unlocked | No incremental risk from Pocket specifically — an attacker with an unlocked vault already has everything Pocket would ever publish |

## Known limitations / v2 candidates

- **Multi-device** was explicitly scoped out of v1. Extending it correctly needs per-device envelope encryption (a content key wrapped once per authorized device's own key) rather than one shared DEK, which in turn needs a real pairing return-channel (a two-step QR-then-confirmation-code dance) — deferred until an actual second device is needed.
- **A signed device-heartbeat** (a phone periodically writing a small signed "I saw revision N" marker back to Drive) would let Desktop show real "last synced" information instead of just "code generated at." Deliberately not built for v1 — it reintroduces a phone→cloud write path for a purely informational feature, and needs a verifiable signature (so a compromised or malicious app can't spoof another device's heartbeat) to be trustworthy at all.
- **iOS has not been built or run** in this environment (no macOS/Xcode available where this was authored) — the code is written to be cross-platform (Expo, no Android-only APIs outside what's already flagged), but only Android has any real-device verification path documented so far. See the mobile README for exactly what still needs on-device verification.
