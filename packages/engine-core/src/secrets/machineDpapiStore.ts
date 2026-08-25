import type { Database } from 'better-sqlite3';
import { Dpapi } from '@primno/dpapi';
import type { SecretStore } from './types.js';

interface SecretRow {
  ciphertext: Buffer;
}

/**
 * Encrypts secrets with Windows DPAPI in LocalMachine scope — decryptable
 * by any process on this machine regardless of which account is running,
 * unlike Windows Credential Manager (CurrentUser-scope DPAPI under the
 * hood), which only the specific user who created a secret could ever
 * read. This is what lets a task's Windows Scheduled Task run as SYSTEM
 * with no password at all — see taskDefinitionXml.ts for the full story.
 *
 * Raw DPAPI has no OS-managed registry the way Credential Manager did —
 * it only encrypts/decrypts bytes. The `secrets` table (this app's own
 * SQLite) is what replaces that registry; DPAPI just protects what's in it.
 */
export class MachineDpapiSecretStore implements SecretStore {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;

  constructor(db: Database) {
    this.getStmt = db.prepare<[string], SecretRow>('SELECT ciphertext FROM secrets WHERE ref = ?');
    this.upsertStmt = db.prepare(
      `INSERT INTO secrets (ref, ciphertext) VALUES (@ref, @ciphertext)
       ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );
    this.deleteStmt = db.prepare('DELETE FROM secrets WHERE ref = ?');
  }

  get(ref: string): string | null {
    const row = this.getStmt.get(ref);
    if (!row) return null;
    try {
      const plaintext = Dpapi.unprotectData(new Uint8Array(row.ciphertext), null, 'LocalMachine');
      return Buffer.from(plaintext).toString('utf8');
    } catch {
      return null;
    }
  }

  set(ref: string, value: string): void {
    const ciphertext = Dpapi.protectData(new Uint8Array(Buffer.from(value, 'utf8')), null, 'LocalMachine');
    this.upsertStmt.run({ ref, ciphertext: Buffer.from(ciphertext) });
  }

  delete(ref: string): void {
    this.deleteStmt.run(ref);
  }
}
