import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Dpapi, isPlatformSupported } from '@primno/dpapi';
import { hardenKeyFileAclSync } from '../transports/keyFilePermissions.js';
import { wipe } from './crypto.js';

/**
 * OPTIONAL, per-machine vault auto-unlock.
 *
 * What it stores locally: a copy of the **KEK** (scrypt(master password,
 * kek_salt)) sealed with Windows **DPAPI in CurrentUser scope** + a fixed
 * app entropy. NOT the master password, NOT the DEK.
 *
 * At startup `serve` calls `loadKek(currentKekSalt)` → DPAPI-unseal → KEK →
 * `unwrapDek(vault_meta.wrapped_dek, kek)` → verify → the DEK lives only in
 * `serve` RAM, exactly like a manual unlock. The LocalSystem scheduler is
 * never in this path, and even if it read the file it could not unseal a
 * CurrentUser blob.
 *
 * A fingerprint of `kek_salt` is stored alongside the blob so material from
 * a previous master-password epoch is detected as **stale**, deleted, and
 * the app falls back to a manual unlock.
 *
 * File layout (`paths.vaultAutoUnlockFilePath()`), all little-endian:
 *   magic "ARKAU" (5) | version (1) | kekSaltFp (8) | createdAtMs (8) | dpapiBlob (rest)
 */

const MAGIC = Buffer.from('ARKAU', 'ascii');
const FORMAT_VERSION = 1;
const FP_LEN = 8;
const HEADER_LEN = MAGIC.length + 1 + FP_LEN + 8; // magic + version + fp + createdAtMs
const KEK_LEN = 32;

/** Fixed secondary entropy — marginal (it's in the binary), pure defense-in-depth. */
const ENTROPY = Buffer.from('arkode:vault:auto-unlock:v1', 'utf8');

export type VaultAutoUnlockState = 'unsupported' | 'disabled' | 'enabled' | 'stale' | 'error';

export interface VaultAutoUnlockStatus {
  state: VaultAutoUnlockState;
  createdAt?: string;
}

export class VaultAutoUnlockUnavailableError extends Error {
  constructor(message = 'No usable Windows auto-unlock material for this vault on this machine.') {
    super(message);
    this.name = 'VaultAutoUnlockUnavailableError';
  }
}

/** The only place that touches the OS crypto primitive — swappable in tests. */
export interface DpapiProvider {
  readonly isSupported: boolean;
  /** CurrentUser scope + fixed entropy. Throws when unsupported. */
  protect(data: Buffer): Buffer;
  /** Throws on a wrong user/machine context or a tampered blob. */
  unprotect(blob: Buffer): Buffer;
}

export const currentUserDpapiProvider: DpapiProvider = {
  isSupported: isPlatformSupported,
  protect(data) {
    if (!isPlatformSupported) throw new VaultAutoUnlockUnavailableError('Auto-unlock requires Windows DPAPI.');
    return Buffer.from(Dpapi.protectData(new Uint8Array(data), new Uint8Array(ENTROPY), 'CurrentUser'));
  },
  unprotect(blob) {
    if (!isPlatformSupported) throw new VaultAutoUnlockUnavailableError('Auto-unlock requires Windows DPAPI.');
    return Buffer.from(Dpapi.unprotectData(new Uint8Array(blob), new Uint8Array(ENTROPY), 'CurrentUser'));
  },
};

export interface VaultAutoUnlock {
  /** Cheap: a well-formed material file is present (also => idle auto-lock is suppressed). */
  isEnabled(): boolean;
  /** Full status for the UI; deletes stale/corrupt material as a side effect. */
  status(currentKekSalt: Buffer): VaultAutoUnlockStatus;
  /** Seal `kek` for this machine's current user, tagged with `currentKekSalt`'s fingerprint. Overwrites. */
  enable(kek: Buffer, currentKekSalt: Buffer): void;
  /** Remove the local material (best-effort overwrite, then delete). No-op if absent. */
  disable(): void;
  /**
   * Recover the KEK from local material for the CURRENT `kek_salt`.
   * Returns null AND deletes the file on absent / stale / corrupt / wrong-context.
   * The caller still verifies KEK→DEK→verifier.
   */
  loadKek(currentKekSalt: Buffer): Buffer | null;
}

export interface VaultAutoUnlockDeps {
  filePath: string;
  dpapi?: DpapiProvider;
  /** Best-effort ACL hardening of the material file (Windows only). */
  hardenFile?: (path: string) => void;
  now?: () => number;
}

function fingerprint(kekSalt: Buffer): Buffer {
  return createHash('sha256').update(kekSalt).digest().subarray(0, FP_LEN);
}

type Parsed =
  | { ok: true; kekSaltFp: Buffer; createdAtMs: number; dpapiBlob: Buffer }
  | { ok: false; reason: 'absent' | 'malformed' };

export function createVaultAutoUnlock(deps: VaultAutoUnlockDeps): VaultAutoUnlock {
  const { filePath } = deps;
  const dpapi = deps.dpapi ?? currentUserDpapiProvider;
  const hardenFile = deps.hardenFile ?? ((p: string) => hardenKeyFileAclSync(p));
  const now = deps.now ?? (() => Date.now());

  function parse(): Parsed {
    let raw: Buffer;
    try {
      raw = readFileSync(filePath);
    } catch {
      return { ok: false, reason: 'absent' };
    }
    if (raw.length < HEADER_LEN + 1 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      return { ok: false, reason: 'malformed' };
    }
    if (raw[MAGIC.length] !== FORMAT_VERSION) return { ok: false, reason: 'malformed' };
    const fpStart = MAGIC.length + 1;
    const kekSaltFp = raw.subarray(fpStart, fpStart + FP_LEN);
    const createdAtMs = Number(raw.readBigUInt64LE(fpStart + FP_LEN));
    const dpapiBlob = raw.subarray(HEADER_LEN);
    return { ok: true, kekSaltFp, createdAtMs, dpapiBlob };
  }

  function removeFile(): void {
    try {
      const size = statSync(filePath).size;
      writeFileSync(filePath, randomBytes(Math.max(size, 1)));
    } catch {
      /* best-effort scrub; not a guaranteed wipe on SSD/NTFS */
    }
    try {
      unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  }

  return {
    isEnabled() {
      return dpapi.isSupported && parse().ok;
    },

    status(currentKekSalt) {
      if (!dpapi.isSupported) return { state: 'unsupported' };
      const p = parse();
      if (!p.ok) return p.reason === 'absent' ? { state: 'disabled' } : (removeFile(), { state: 'error' });
      if (!p.kekSaltFp.equals(fingerprint(currentKekSalt))) {
        removeFile();
        return { state: 'stale' };
      }
      // Deliberately no DPAPI round-trip here (status is polled): a blob that
      // parses + matches the fingerprint but is from another Windows context
      // is only discovered — and deleted — at loadKek() time (startup or an
      // explicit "unlock with Windows"), after which status reports 'disabled'.
      return { state: 'enabled', createdAt: new Date(p.createdAtMs).toISOString() };
    },

    enable(kek, currentKekSalt) {
      if (kek.length !== KEK_LEN) throw new Error(`KEK must be ${KEK_LEN} bytes`);
      const sealed = dpapi.protect(kek);
      const header = Buffer.alloc(HEADER_LEN);
      MAGIC.copy(header, 0);
      header[MAGIC.length] = FORMAT_VERSION;
      fingerprint(currentKekSalt).copy(header, MAGIC.length + 1);
      header.writeBigUInt64LE(BigInt(now()), MAGIC.length + 1 + FP_LEN);
      const out = Buffer.concat([header, sealed]);
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, out);
      try {
        const fd = openSync(tmp, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        /* fsync is best-effort */
      }
      renameSync(tmp, filePath);
      try {
        hardenFile(filePath);
      } catch {
        /* ACL hardening is best-effort; DPAPI is the real protection */
      }
    },

    disable() {
      if (existsSync(filePath)) removeFile();
    },

    loadKek(currentKekSalt) {
      if (!dpapi.isSupported) return null;
      const p = parse();
      if (!p.ok) {
        if (p.reason === 'malformed') removeFile();
        return null;
      }
      if (!p.kekSaltFp.equals(fingerprint(currentKekSalt))) {
        removeFile();
        return null;
      }
      try {
        const kek = dpapi.unprotect(p.dpapiBlob);
        if (kek.length !== KEK_LEN) {
          wipe(kek);
          removeFile();
          return null;
        }
        return kek;
      } catch {
        removeFile();
        return null;
      }
    },
  };
}
