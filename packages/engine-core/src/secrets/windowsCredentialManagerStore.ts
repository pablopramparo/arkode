import { Entry } from '@napi-rs/keyring';
import type { SecretStore } from './types.js';

const SERVICE_NAME = 'CodebiusBackupManager';

/**
 * Binds to Windows Credential Manager via @napi-rs/keyring — the maintained
 * replacement for the now-archived `keytar`. `ref` becomes the Credential
 * Manager "username" under a single fixed service name, so every secret this
 * app owns groups together in the Windows Credential Manager UI.
 */
export class WindowsCredentialManagerStore implements SecretStore {
  get(ref: string): string | null {
    try {
      return new Entry(SERVICE_NAME, ref).getPassword();
    } catch {
      return null;
    }
  }

  set(ref: string, value: string): void {
    new Entry(SERVICE_NAME, ref).setPassword(value);
  }

  delete(ref: string): void {
    try {
      new Entry(SERVICE_NAME, ref).deleteCredential();
    } catch {
      // Nothing stored under this ref — deleting an absent secret is a no-op.
    }
  }
}
