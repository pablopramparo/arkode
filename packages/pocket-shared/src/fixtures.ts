import type { PocketSnapshotPayload } from './types.js';

/**
 * Shared, deliberately NON-SENSITIVE test fixtures — used by BOTH engine-core
 * (Desktop) and pocket-mobile's own test suites, so "the same bytes Desktop
 * produces are exactly what Mobile can open" is proven with one shared
 * source of truth instead of two hand-copied literals that could drift.
 * Never derived from, or resembling, any real client's data.
 */
export const SAMPLE_POCKET_SNAPSHOT: PocketSnapshotPayload = {
  formatVersion: 1,
  clients: [
    { id: 'client-acme', name: 'Acme Test' },
    { id: 'client-cardiomed', name: 'Cardiomed Test' },
  ],
  credentials: [
    {
      id: 'cred-mysql',
      clientId: 'client-acme',
      name: 'MySQL Production',
      kind: 'mysql',
      environment: 'production',
      tags: ['db', 'prod'],
      host: 'db.example.test',
      port: 3306,
      username: 'demo',
      databaseName: 'acme_prod',
      url: null,
      favorite: true,
      description: 'Fixture credential — never real.',
      secret: { password: 'correct-horse-test-only' },
    },
    {
      id: 'cred-ssh',
      clientId: 'client-acme',
      name: 'App Server SSH',
      kind: 'ssh',
      environment: 'production',
      tags: ['ssh'],
      host: 'app.example.test',
      port: 22,
      username: 'deploy',
      databaseName: null,
      url: null,
      favorite: false,
      description: null,
      secret: { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE-ONLY-NOT-REAL\n-----END OPENSSH PRIVATE KEY-----', privateKeyPassphrase: 'fixture-passphrase' },
    },
    {
      id: 'cred-postgres',
      clientId: 'client-cardiomed',
      name: 'Postgres Staging',
      kind: 'postgres',
      environment: 'staging',
      tags: ['db', 'staging'],
      host: 'db.cardiomed.test',
      port: 5432,
      username: 'cardiomed',
      databaseName: 'cardiomed',
      url: null,
      favorite: false,
      description: null,
      secret: { password: 'fixture-password-2' },
    },
  ],
  urls: [
    {
      id: 'url-admin',
      clientId: 'client-acme',
      name: 'Admin',
      url: 'https://example.test/admin',
      environment: 'production',
      tags: [],
      favorite: false,
      description: null,
    },
  ],
};

/** A deterministic (NOT cryptographically meaningful) 32-byte fixture DEK — real code always uses a random one; this is fixture-only. */
export const SAMPLE_POCKET_DEK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));

export const SAMPLE_POCKET_ID = 'pocket-fixture-0000';
export const SAMPLE_DRIVE_REMOTE_PATH = 'Arkode/Pocket';
