import { describe, expect, it } from 'vitest';
import { nodePocketCryptoAdapter } from '../src/nodeCryptoAdapter.js';
import { generatePocketDek } from '../src/crypto.js';
import {
  buildPocketSyncFile,
  decryptPocketSnapshotPayload,
  parsePocketSyncFile,
  serializePocketSyncFile,
  validatePocketSnapshotPayload,
  POCKET_SYNC_FILE_MAGIC,
  PocketFormatError,
} from '../src/format.js';
import type { PocketSnapshotPayload } from '../src/types.js';

const adapter = nodePocketCryptoAdapter;

const samplePayload: PocketSnapshotPayload = {
  formatVersion: 1,
  clients: [{ id: 'c1', name: 'Acme Test' }],
  credentials: [
    {
      id: 'cred1',
      clientId: 'c1',
      name: 'MySQL Production',
      kind: 'mysql',
      environment: 'production',
      tags: ['db'],
      host: 'db.example.test',
      port: 3306,
      username: 'demo',
      databaseName: 'acme',
      url: null,
      favorite: true,
      description: null,
      secret: { password: 'correct-horse-test-only' },
    },
  ],
  urls: [
    {
      id: 'url1',
      clientId: 'c1',
      name: 'Admin',
      url: 'https://example.test/admin',
      environment: null,
      tags: [],
      favorite: false,
      description: null,
    },
  ],
};

describe('arkode-pocket-sync file format', () => {
  it('builds, serializes, parses, and decrypts a full round-trip', () => {
    const dek = generatePocketDek(adapter);
    const file = buildPocketSyncFile(samplePayload, dek, { pocketId: 'p1', revision: 1, generatedAt: new Date().toISOString() }, adapter);
    expect(file.magic).toBe(POCKET_SYNC_FILE_MAGIC);

    const bytes = serializePocketSyncFile(file);
    const reparsed = parsePocketSyncFile(bytes);
    expect(reparsed.revision).toBe(1);
    expect(reparsed.pocketId).toBe('p1');

    const decrypted = decryptPocketSnapshotPayload(reparsed, dek, adapter);
    expect(decrypted).toEqual(samplePayload);
  });

  it('header fields (revision/pocketId/generatedAt) are readable WITHOUT the key', () => {
    const dek = generatePocketDek(adapter);
    const file = buildPocketSyncFile(samplePayload, dek, { pocketId: 'p1', revision: 42, generatedAt: '2026-01-01T00:00:00.000Z' }, adapter);
    const raw = JSON.parse(new TextDecoder().decode(serializePocketSyncFile(file))) as Record<string, unknown>;
    expect(raw.revision).toBe(42);
    // and no plaintext of the actual secret/host/username anywhere in the raw JSON
    expect(JSON.stringify(raw)).not.toContain('correct-horse-test-only');
    expect(JSON.stringify(raw)).not.toContain('db.example.test');
    expect(JSON.stringify(raw)).not.toContain('Acme Test');
  });

  it('rejects a file with the wrong magic', () => {
    expect(() => parsePocketSyncFile(JSON.stringify({ magic: 'NOPE' }))).toThrow(/bad magic/);
  });

  it('rejects a future format version with a clear upgrade message', () => {
    const dek = generatePocketDek(adapter);
    const file = buildPocketSyncFile(samplePayload, dek, { pocketId: 'p1', revision: 1, generatedAt: 'now' }, adapter);
    const future = { ...file, formatVersion: 999 };
    expect(() => parsePocketSyncFile(JSON.stringify(future))).toThrow(/newer version of Arkode Pocket/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePocketSyncFile('not json{{{')).toThrow(PocketFormatError);
  });

  it('rejects a file missing required fields', () => {
    expect(() => parsePocketSyncFile(JSON.stringify({ magic: 'ARKPKT', formatVersion: 1 }))).toThrow(/missing required fields/);
  });

  describe('validatePocketSnapshotPayload — the out-of-scope-domain guard', () => {
    it('accepts a valid payload', () => {
      expect(validatePocketSnapshotPayload(samplePayload)).toEqual(samplePayload);
    });

    it('rejects an unexpected top-level field (e.g. a smuggled backup-domain object)', () => {
      const poisoned = { ...samplePayload, backupTasks: [{ id: 't1' }] };
      expect(() => validatePocketSnapshotPayload(poisoned)).toThrow(/unexpected field "backupTasks"/);
    });

    it('rejects an unexpected field on a credential', () => {
      const poisoned = {
        ...samplePayload,
        credentials: [{ ...samplePayload.credentials[0], windowsTaskName: 'whoops' }],
      };
      expect(() => validatePocketSnapshotPayload(poisoned)).toThrow(/unexpected field "windowsTaskName"/);
    });

    it('rejects an unexpected field inside a secret blob', () => {
      const poisoned = {
        ...samplePayload,
        credentials: [{ ...samplePayload.credentials[0], secret: { password: 'x', remoteDumpDbPassword: 'y' } }],
      };
      expect(() => validatePocketSnapshotPayload(poisoned)).toThrow(/unexpected field "remoteDumpDbPassword"/);
    });

    it('rejects an unrecognized credential kind', () => {
      const poisoned = { ...samplePayload, credentials: [{ ...samplePayload.credentials[0], kind: 'nonsense' }] };
      expect(() => validatePocketSnapshotPayload(poisoned)).toThrow(/unrecognized kind/);
    });

    it('rejects a non-array clients/credentials/urls', () => {
      expect(() => validatePocketSnapshotPayload({ ...samplePayload, clients: {} })).toThrow(/missing clients/);
    });
  });
});
