/**
 * Pocket domain types — a deliberate SUBSET of the Desktop vault's own
 * shape. Keep in sync by hand with `engine-core/src/vault/types.ts`
 * (`VaultCredentialKind`, `VaultCredentialSecret`, `VaultCredential`,
 * `VaultUrl`); this package must not import engine-core (see the package's
 * own README), so the overlap is intentionally duplicated, not shared by
 * reference.
 *
 * Scope is intentionally narrow — this is the exhaustive list of what a
 * Pocket snapshot may ever contain. Everything else in Arkode's vault
 * (notes/snippets/processes, and every non-vault domain: backup tasks,
 * runs, repositories, replication targets, transports, connections,
 * schedules, logs, settings) is explicitly out of scope for Pocket v1 and
 * must never appear here.
 */

export type PocketCredentialKind =
  | 'ssh'
  | 'sftp'
  | 'ftp'
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'smtp'
  | 'http_basic'
  | 'web_panel'
  | 'api'
  | 'oauth_client'
  | 'generic_login'
  | 'generic_secret'
  | 'ssh_key'
  | 'custom';

export const POCKET_CREDENTIAL_KINDS: readonly PocketCredentialKind[] = [
  'ssh',
  'sftp',
  'ftp',
  'postgres',
  'mysql',
  'mariadb',
  'smtp',
  'http_basic',
  'web_panel',
  'api',
  'oauth_client',
  'generic_login',
  'generic_secret',
  'ssh_key',
  'custom',
];

/**
 * The secret fields of a credential. `privateKey`/`privateKeyPassphrase` ARE
 * included deliberately — Pocket is a read-only viewer/copier, never an SSH
 * client or key importer, so showing a private key here carries the same
 * risk class as showing a password (see the mobile app's README for why
 * this was not silently excluded).
 */
export interface PocketCredentialSecret {
  password?: string;
  token?: string;
  clientSecret?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  custom?: Record<string, string>;
  notes?: string;
}

export interface PocketClient {
  id: string;
  name: string;
}

export interface PocketCredential {
  id: string;
  clientId: string;
  name: string;
  kind: PocketCredentialKind;
  environment: string | null;
  tags: string[];
  host: string | null;
  port: number | null;
  username: string | null;
  databaseName: string | null;
  url: string | null;
  favorite: boolean;
  description: string | null;
  secret: PocketCredentialSecret;
}

export interface PocketUrl {
  id: string;
  clientId: string;
  name: string;
  url: string;
  environment: string | null;
  tags: string[];
  favorite: boolean;
  description: string | null;
}

export const POCKET_SNAPSHOT_PAYLOAD_VERSION = 1;

/** The decrypted contents of a Pocket snapshot — nothing beyond these three arrays. */
export interface PocketSnapshotPayload {
  formatVersion: 1;
  clients: PocketClient[];
  credentials: PocketCredential[];
  urls: PocketUrl[];
}
