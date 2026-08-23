import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { KnownHost } from '../../types.js';

interface KnownHostRow {
  id: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint_sha256: string;
  first_seen_at: string;
  confirmed_at: string | null;
}

function toDomain(row: KnownHostRow): KnownHost {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    keyType: row.key_type,
    fingerprintSha256: row.fingerprint_sha256,
    firstSeenAt: row.first_seen_at,
    confirmedAt: row.confirmed_at,
  };
}

export interface KnownHostsRepo {
  find(host: string, port: number): KnownHost | null;
  recordConfirmed(host: string, port: number, keyType: string, fingerprintSha256: string): KnownHost;
}

export function createKnownHostsRepo(db: Database): KnownHostsRepo {
  const findStmt = db.prepare<[string, number], KnownHostRow>(
    'SELECT * FROM known_hosts WHERE host = ? AND port = ? ORDER BY first_seen_at DESC LIMIT 1'
  );
  const insertStmt = db.prepare(
    `INSERT INTO known_hosts (id, host, port, key_type, fingerprint_sha256, confirmed_at)
     VALUES (@id, @host, @port, @keyType, @fingerprintSha256, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  );

  return {
    find(host, port) {
      const row = findStmt.get(host, port);
      return row ? toDomain(row) : null;
    },

    recordConfirmed(host, port, keyType, fingerprintSha256) {
      const id = randomUUID();
      insertStmt.run({ id, host, port, keyType, fingerprintSha256 });
      return {
        id,
        host,
        port,
        keyType,
        fingerprintSha256,
        firstSeenAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      };
    },
  };
}
