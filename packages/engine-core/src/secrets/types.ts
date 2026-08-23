/**
 * Abstracts OS-level secret storage. Only opaque `ref` strings (e.g.
 * "transport:<uuid>:passphrase") are ever stored in SQLite — never the
 * secret itself. Implementations must never log the resolved value.
 */
export interface SecretStore {
  get(ref: string): string | null;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}
