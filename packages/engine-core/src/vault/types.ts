/** Structured-credential kinds. Validated app-side (not a SQL CHECK) so new kinds stay cheap. */
export type VaultCredentialKind =
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

export const VAULT_CREDENTIAL_KINDS: readonly VaultCredentialKind[] = [
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

/** Which linked-connection kind, if any, a credential of this kind may bridge to (Phase 3). */
export function linkTargetForKind(kind: VaultCredentialKind): 'transport' | 'database_connection' | null {
  if (kind === 'ssh' || kind === 'sftp' || kind === 'ftp' || kind === 'ssh_key') return 'transport';
  if (kind === 'postgres' || kind === 'mysql' || kind === 'mariadb') return 'database_connection';
  return null;
}

export type OperationalSyncState = 'none' | 'pending' | 'ok' | 'error';

/**
 * The decrypted, structured secret payload of a credential — stored as ONE
 * AES-256-GCM blob in `vault_secrets`. Every field optional; `custom` is an
 * open-ended key/value bag so an uncommon credential is never awkward.
 */
export interface VaultCredentialSecret {
  password?: string;
  token?: string;
  clientSecret?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  custom?: Record<string, string>;
  notes?: string;
}

export interface VaultUrl {
  id: string;
  clientId: string;
  name: string;
  url: string;
  environment: string | null;
  tags: string[];
  linkedCredentialId: string | null;
  favorite: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VaultItemType = 'snippet' | 'process' | 'note';

export interface VaultProcessStep {
  text: string;
  command?: string;
}

export interface VaultItemMetadata {
  /** snippet only */
  language?: string;
  /** process only */
  steps?: VaultProcessStep[];
  linkedCredentialIds?: string[];
  linkedUrlIds?: string[];
  linkedItemIds?: string[];
  warnings?: string;
}

export interface VaultItem {
  id: string;
  clientId: string;
  type: VaultItemType;
  title: string;
  environment: string | null;
  tags: string[];
  description: string | null;
  favorite: boolean;
  isSensitive: boolean;
  /** used when isSensitive === false */
  bodyPlaintext: string | null;
  /** used when isSensitive === true — points into vault_secrets */
  bodyBlobRef: string | null;
  metadata: VaultItemMetadata;
  createdAt: string;
  updatedAt: string;
}

/** Plaintext metadata row (searchable while the vault is locked). */
export interface VaultCredential {
  id: string;
  clientId: string;
  name: string;
  kind: VaultCredentialKind;
  environment: string | null;
  tags: string[];
  host: string | null;
  port: number | null;
  username: string | null;
  databaseName: string | null;
  url: string | null;
  secretBlobRef: string | null;
  linkedTransportId: string | null;
  linkedDatabaseConnectionId: string | null;
  operationalSyncState: OperationalSyncState;
  operationalSyncError: string | null;
  favorite: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
