import { randomUUID } from 'node:crypto';
import type { VaultSecretStore } from './vaultSecretStore.js';
import type { VaultCredentialSecret } from './types.js';

/** Ref shape for a credential's encrypted secret blob. */
export function newCredentialSecretRef(): string {
  return `vault:credential:${randomUUID()}`;
}

const SECRET_KEYS: readonly (keyof VaultCredentialSecret)[] = [
  'password',
  'token',
  'clientSecret',
  'privateKey',
  'privateKeyPassphrase',
  'custom',
  'notes',
];

/** Keeps only known keys, drops empty strings, and returns undefined when nothing is left. */
export function normalizeCredentialSecret(input: unknown): VaultCredentialSecret | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const out: VaultCredentialSecret = {};
  for (const key of SECRET_KEYS) {
    const value = src[key];
    if (key === 'custom') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const custom: Record<string, string> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) custom[k] = v;
        }
        if (Object.keys(custom).length > 0) out.custom = custom;
      }
      continue;
    }
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value as never;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Encrypts + stores the secret blob under `ref`. Throws VaultLockedError if the vault is locked. */
export function writeCredentialSecret(store: VaultSecretStore, ref: string, secret: VaultCredentialSecret): void {
  store.set(ref, JSON.stringify(secret));
}

/** Decrypts the secret blob. Returns {} for an absent ref; throws VaultCryptoError on a corrupt blob. */
export function readCredentialSecret(store: VaultSecretStore, ref: string): VaultCredentialSecret {
  const raw = store.get(ref);
  if (raw === null) return {};
  const parsed = JSON.parse(raw) as unknown;
  return normalizeCredentialSecret(parsed) ?? {};
}
