# pocket-shared

Pure, dependency-free TypeScript shared between Arkode Desktop (`engine-core`)
and Arkode Pocket (`pocket-mobile`): the `arkode-pocket-sync` ciphertext
framing, the snapshot/pairing types, and the strict payload validator.

**What lives here:** byte-level AES-256-GCM blob framing (`crypto.ts`), the
outer sync-file envelope (`format.ts`), the QR pairing payload (`pairing.ts`),
and the Pocket domain types (`types.ts`) — all pure functions over
`Uint8Array`/plain objects, with the actual AES-GCM primitive injected via a
`PocketCryptoAdapter` interface so this package never imports a
platform-specific crypto library itself.

**What does NOT live here, on purpose:**
- `node:crypto` itself — see `nodeCryptoAdapter.ts` / the `pocket-shared/node`
  subpath, imported only by `engine-core`.
- Any DPAPI, SQLite, rclone, or filesystem code — those stay in `engine-core`.
- The Desktop vault's own crypto (master password / KEK / scrypt / `.arkvault`)
  — Pocket has its own, deliberately simpler, independent key model. See
  `crypto.ts`'s header comment for why there's no verifier/KDF here at all.
- Anything React Native-specific — the mobile app's own crypto adapter
  (backed by `react-native-quick-crypto` or equivalent) lives inside
  `packages/pocket-mobile`, not here.

## Usage

```ts
// Desktop (engine-core)
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { buildPocketSyncFile, generatePocketDek } from 'pocket-shared';

// Mobile (pocket-mobile) — its own adapter, same shared functions
import { parsePocketSyncFile, decryptPocketSnapshotPayload } from 'pocket-shared';
import { quickCryptoPocketAdapter } from './crypto/quickCryptoAdapter';
```

Both sides call the exact same `buildPocketSyncFile` / `parsePocketSyncFile` /
`decryptPocketSnapshotPayload` functions — only the `PocketCryptoAdapter`
implementation differs per platform. `test/interop.spec.ts` proves this: it
encrypts with one adapter and decrypts with the other.
