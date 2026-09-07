import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from './bytes.js';
import { decryptPocketBlob, encryptPocketBlob, type PocketCryptoAdapter } from './crypto.js';
import {
  POCKET_CREDENTIAL_KINDS,
  POCKET_SNAPSHOT_PAYLOAD_VERSION,
  type PocketClient,
  type PocketCredential,
  type PocketCredentialSecret,
  type PocketSnapshotPayload,
  type PocketUrl,
} from './types.js';

/**
 * The `arkode-pocket-sync` file format — what Desktop uploads to Google
 * Drive and what the mobile app downloads. Deliberately NOT `.arkvault`:
 * no master password, no KDF, no wrapped-DEK/verifier dance (see
 * crypto.ts's own header comment for why) — the Pocket DEK is handed to the
 * device directly during pairing, so decryption either works or it doesn't.
 *
 * Header fields are the ONLY thing that may ever sit outside `payload`.
 * `revision`/`generatedAt` are a deliberate, minor, accepted metadata leak
 * (freshness must be checkable without decrypting) — everything else
 * (client names, credential names, hosts, usernames, URLs, tags, secrets)
 * lives exclusively inside the encrypted payload.
 */
export const POCKET_SYNC_FILE_MAGIC = 'ARKPKT';
export const POCKET_SYNC_FORMAT_VERSION = 1;
export const POCKET_SYNC_FILE_NAME = 'arkode-pocket-sync.json';

export class PocketFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PocketFormatError';
  }
}

export interface PocketSyncFile {
  magic: typeof POCKET_SYNC_FILE_MAGIC;
  formatVersion: number;
  pocketId: string;
  revision: number;
  generatedAt: string;
  /** base64 of the self-describing AES-256-GCM blob from crypto.ts. */
  payload: string;
}

export interface PocketSyncFileMeta {
  pocketId: string;
  revision: number;
  generatedAt: string;
}

export function buildPocketSyncFile(
  payload: PocketSnapshotPayload,
  dek: Uint8Array,
  meta: PocketSyncFileMeta,
  adapter: PocketCryptoAdapter
): PocketSyncFile {
  const plaintext = utf8ToBytes(JSON.stringify(payload));
  const blob = encryptPocketBlob(plaintext, dek, adapter);
  return {
    magic: POCKET_SYNC_FILE_MAGIC,
    formatVersion: POCKET_SYNC_FORMAT_VERSION,
    pocketId: meta.pocketId,
    revision: meta.revision,
    generatedAt: meta.generatedAt,
    payload: bytesToBase64(blob),
  };
}

export function serializePocketSyncFile(file: PocketSyncFile): Uint8Array {
  return utf8ToBytes(JSON.stringify(file));
}

/**
 * Parses + structurally validates the OUTER envelope only (magic, version,
 * required fields/types). This never touches the DEK, so it is safe to call
 * on a just-downloaded file before deciding whether it's even worth trying
 * to decrypt (e.g. to read `revision` for a freshness check).
 */
export function parsePocketSyncFile(raw: Uint8Array | string): PocketSyncFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : bytesToUtf8(raw));
  } catch {
    throw new PocketFormatError('Not a valid Pocket sync file (bad JSON).');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PocketFormatError('Not a valid Pocket sync file (not an object).');
  }
  const f = parsed as Record<string, unknown>;
  if (f.magic !== POCKET_SYNC_FILE_MAGIC) {
    throw new PocketFormatError('Not an arkode-pocket-sync file (bad magic).');
  }
  if (typeof f.formatVersion !== 'number' || f.formatVersion > POCKET_SYNC_FORMAT_VERSION) {
    throw new PocketFormatError(
      `This update requires a newer version of Arkode Pocket (format ${f.formatVersion}, this build understands up to ${POCKET_SYNC_FORMAT_VERSION}).`
    );
  }
  if (
    typeof f.pocketId !== 'string' ||
    typeof f.revision !== 'number' ||
    typeof f.generatedAt !== 'string' ||
    typeof f.payload !== 'string'
  ) {
    throw new PocketFormatError('The Pocket sync file is missing required fields.');
  }
  return {
    magic: POCKET_SYNC_FILE_MAGIC,
    formatVersion: f.formatVersion,
    pocketId: f.pocketId,
    revision: f.revision,
    generatedAt: f.generatedAt,
    payload: f.payload,
  };
}

/** Decrypts + validates the inner payload. Throws `PocketCryptoError` (wrong key/corrupt) or `PocketFormatError` (valid decrypt, wrong shape). */
export function decryptPocketSnapshotPayload(
  file: PocketSyncFile,
  dek: Uint8Array,
  adapter: PocketCryptoAdapter
): PocketSnapshotPayload {
  const blob = base64ToBytes(file.payload);
  const plaintext = decryptPocketBlob(blob, dek, adapter);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(plaintext));
  } catch {
    throw new PocketFormatError('Decrypted Pocket payload is not valid JSON — the snapshot may be corrupted.');
  }
  return validatePocketSnapshotPayload(parsed);
}

const ALLOWED_PAYLOAD_KEYS = new Set(['formatVersion', 'clients', 'credentials', 'urls']);
const ALLOWED_SECRET_KEYS = new Set([
  'password',
  'token',
  'clientSecret',
  'privateKey',
  'privateKeyPassphrase',
  'custom',
  'notes',
]);
const ALLOWED_CREDENTIAL_KEYS = new Set([
  'id',
  'clientId',
  'name',
  'kind',
  'environment',
  'tags',
  'host',
  'port',
  'username',
  'databaseName',
  'url',
  'favorite',
  'description',
  'secret',
]);
const ALLOWED_URL_KEYS = new Set(['id', 'clientId', 'name', 'url', 'environment', 'tags', 'favorite', 'description']);
const ALLOWED_CLIENT_KEYS = new Set(['id', 'name']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertOnlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new PocketFormatError(`Pocket snapshot ${what} contains an unexpected field "${key}" — out of scope for Pocket v1.`);
    }
  }
}

function optionalString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Strict, allow-list validator: this is the single place that guarantees a
 * Pocket snapshot can NEVER carry a backup task, a repository, a
 * replication target, a note/snippet/process, or any other out-of-scope
 * domain object — even if a future bug in the Desktop snapshot builder
 * tried to put one there. Every unrecognized field is a hard error, not a
 * silently-dropped one.
 */
export function validatePocketSnapshotPayload(value: unknown): PocketSnapshotPayload {
  if (!isPlainObject(value)) throw new PocketFormatError('Pocket snapshot payload is not an object.');
  assertOnlyKeys(value, ALLOWED_PAYLOAD_KEYS, 'payload');
  if (value.formatVersion !== POCKET_SNAPSHOT_PAYLOAD_VERSION) {
    throw new PocketFormatError(`Unsupported Pocket snapshot payload version ${String(value.formatVersion)}.`);
  }
  if (!Array.isArray(value.clients) || !Array.isArray(value.credentials) || !Array.isArray(value.urls)) {
    throw new PocketFormatError('Pocket snapshot payload is missing clients/credentials/urls arrays.');
  }

  const clients = value.clients.map((c, i) => validateClient(c, i));
  const credentials = value.credentials.map((c, i) => validateCredential(c, i));
  const urls = value.urls.map((u, i) => validateUrl(u, i));

  return { formatVersion: POCKET_SNAPSHOT_PAYLOAD_VERSION, clients, credentials, urls };
}

function validateClient(v: unknown, index: number): PocketClient {
  if (!isPlainObject(v)) throw new PocketFormatError(`clients[${index}] is not an object.`);
  assertOnlyKeys(v, ALLOWED_CLIENT_KEYS, `clients[${index}]`);
  if (typeof v.id !== 'string' || typeof v.name !== 'string') {
    throw new PocketFormatError(`clients[${index}] is missing id/name.`);
  }
  return { id: v.id, name: v.name };
}

function validateTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string');
}

function validateSecret(v: unknown, what: string): PocketCredentialSecret {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw new PocketFormatError(`${what}.secret is not an object.`);
  assertOnlyKeys(v, ALLOWED_SECRET_KEYS, `${what}.secret`);
  const out: PocketCredentialSecret = {};
  for (const key of ['password', 'token', 'clientSecret', 'privateKey', 'privateKeyPassphrase', 'notes'] as const) {
    if (typeof v[key] === 'string') out[key] = v[key] as string;
  }
  if (isPlainObject(v.custom)) {
    const custom: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.custom)) {
      if (typeof val === 'string') custom[k] = val;
    }
    if (Object.keys(custom).length > 0) out.custom = custom;
  }
  return out;
}

function validateCredential(v: unknown, index: number): PocketCredential {
  const what = `credentials[${index}]`;
  if (!isPlainObject(v)) throw new PocketFormatError(`${what} is not an object.`);
  assertOnlyKeys(v, ALLOWED_CREDENTIAL_KEYS, what);
  if (typeof v.id !== 'string' || typeof v.clientId !== 'string' || typeof v.name !== 'string') {
    throw new PocketFormatError(`${what} is missing id/clientId/name.`);
  }
  if (typeof v.kind !== 'string' || !POCKET_CREDENTIAL_KINDS.includes(v.kind as never)) {
    throw new PocketFormatError(`${what} has an unrecognized kind "${String(v.kind)}".`);
  }
  return {
    id: v.id,
    clientId: v.clientId,
    name: v.name,
    kind: v.kind as PocketCredential['kind'],
    environment: optionalString(v.environment),
    tags: validateTags(v.tags),
    host: optionalString(v.host),
    port: typeof v.port === 'number' ? v.port : null,
    username: optionalString(v.username),
    databaseName: optionalString(v.databaseName),
    url: optionalString(v.url),
    favorite: v.favorite === true,
    description: optionalString(v.description),
    secret: validateSecret(v.secret, what),
  };
}

function validateUrl(v: unknown, index: number): PocketUrl {
  const what = `urls[${index}]`;
  if (!isPlainObject(v)) throw new PocketFormatError(`${what} is not an object.`);
  assertOnlyKeys(v, ALLOWED_URL_KEYS, what);
  if (typeof v.id !== 'string' || typeof v.clientId !== 'string' || typeof v.name !== 'string' || typeof v.url !== 'string') {
    throw new PocketFormatError(`${what} is missing id/clientId/name/url.`);
  }
  return {
    id: v.id,
    clientId: v.clientId,
    name: v.name,
    url: v.url,
    environment: optionalString(v.environment),
    tags: validateTags(v.tags),
    favorite: v.favorite === true,
    description: optionalString(v.description),
  };
}
