import { describe, expect, it, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTestContext, createFakeSecretStore } from '../helpers/testContext.js';
import { testDirectDumpCompatibility } from '../../src/databaseConnections/testDirectDumpCompatibility.js';
import { createPostgresToolRegistry } from '../../src/databaseConnections/postgresToolRegistry.js';
import { createMysqlToolRegistry } from '../../src/databaseConnections/mysqlToolRegistry.js';
import { createMariaDbToolRegistry } from '../../src/databaseConnections/mariaDbToolRegistry.js';
import type { ConnectionTestResult } from '../../src/transports/types.js';
import type { DatabaseConnection } from '../../src/types.js';

function seedPostgresConnection(ctx: ReturnType<typeof createTestContext>): DatabaseConnection {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
  return ctx.databaseConnectionsRepo.create({
    clientId: client.id,
    name: 'pg',
    engine: 'postgres',
    host: 'h',
    port: 5432,
    databaseName: 'winners',
    username: 'u',
  });
}

function seedMysqlConnection(ctx: ReturnType<typeof createTestContext>): DatabaseConnection {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
  return ctx.databaseConnectionsRepo.create({
    clientId: client.id,
    name: 'mysql',
    engine: 'mysql',
    host: 'h',
    port: 3306,
    databaseName: 'winners',
    username: 'u',
  });
}

function seedMariaDbConnection(ctx: ReturnType<typeof createTestContext>): DatabaseConnection {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
  return ctx.databaseConnectionsRepo.create({
    clientId: client.id,
    name: 'mariadb',
    engine: 'mariadb',
    host: 'h',
    port: 3306,
    databaseName: 'winners',
    username: 'u',
  });
}

function fakeOk(serverVersion?: string): typeof import('../../src/databaseConnections/testDatabaseConnection.js').testDatabaseConnection {
  return async () => ({ ok: true, message: 'Connection succeeded.', serverVersion }) as ConnectionTestResult;
}

const fakeFailed: typeof import('../../src/databaseConnections/testDatabaseConnection.js').testDatabaseConnection =
  async () => ({ ok: false, message: 'auth failed' });

describe('testDirectDumpCompatibility', () => {
  const createdTempFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(createdTempFiles.splice(0).map((f) => rm(f, { force: true })));
    delete process.env.PG_DUMP_PATH;
    delete process.env.MYSQLDUMP_PATH;
    delete process.env.MARIADB_DUMP_PATH;
  });

  async function makeRealFile(): Promise<string> {
    const path = join(tmpdir(), `codebius-fake-pg_dump-${randomUUID()}.exe`);
    await writeFile(path, 'fake binary');
    createdTempFiles.push(path);
    return path;
  }

  it('fails immediately when the connection itself fails, without even looking at tools', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeFailed,
    });

    expect(result.ok).toBe(false);
    expect(result.toolCompatibility).toBe('missing');
    expect(result.message).toMatch(/connection failed/i);
  });

  it("resolves 'registered' when the detected server version matches a registry entry", async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    const pgDumpPath = await makeRealFile();
    createPostgresToolRegistry(ctx.settingsRepo).register('18', { pgDumpPath, pgRestorePath: 'unused' });

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('registered');
    expect(result.toolPath).toBe(pgDumpPath);
  });

  it("resolves 'registered' for mysql when the detected server version matches the mysql tool registry", async () => {
    const ctx = createTestContext();
    const connection = seedMysqlConnection(ctx);
    const mysqldumpPath = await makeRealFile();
    createMysqlToolRegistry(ctx.settingsRepo).register('9.1', { mysqldumpPath });

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('9.1.0'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('registered');
    expect(result.toolPath).toBe(mysqldumpPath);
  });

  it("resolves 'registered' for mariadb when the detected server version matches the mariadb tool registry", async () => {
    const ctx = createTestContext();
    const connection = seedMariaDbConnection(ctx);
    const mariaDbDumpPath = await makeRealFile();
    createMariaDbToolRegistry(ctx.settingsRepo).register('11.5', { mariaDbDumpPath });

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('11.5.2-MariaDB'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('registered');
    expect(result.toolPath).toBe(mariaDbDumpPath);
  });

  it("falls back to 'default-unverified' when no registry entry matches but PG_DUMP_PATH exists on disk", async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    const pgDumpPath = await makeRealFile();
    process.env.PG_DUMP_PATH = pgDumpPath;

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('default-unverified');
    expect(result.toolPath).toBe(pgDumpPath);
  });

  it("mysql: falls back to MARIADB_DUMP_PATH when MYSQLDUMP_PATH is unset (matches what a zero-config MySQL direct_dump actually runs)", async () => {
    const ctx = createTestContext();
    const connection = seedMysqlConnection(ctx);
    const mariaDbDumpPath = await makeRealFile();
    process.env.MARIADB_DUMP_PATH = mariaDbDumpPath;

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('9.1.0'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('default-unverified');
    expect(result.toolPath).toBe(mariaDbDumpPath);
  });

  it('prefers a registry match over the default env var when both are present', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    const registryPath = await makeRealFile();
    const defaultPath = await makeRealFile();
    process.env.PG_DUMP_PATH = defaultPath;
    createPostgresToolRegistry(ctx.settingsRepo).register('18', { pgDumpPath: registryPath, pgRestorePath: 'unused' });

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.toolCompatibility).toBe('registered');
    expect(result.toolPath).toBe(registryPath);
  });

  it('fails with missing when nothing is registered and PG_DUMP_PATH is unset', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.ok).toBe(false);
    expect(result.toolCompatibility).toBe('missing');
  });

  it('fails with missing when the resolved tool path is configured but the file does not actually exist', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    process.env.PG_DUMP_PATH = join(tmpdir(), 'this-file-does-not-exist.exe');

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.ok).toBe(false);
    expect(result.toolCompatibility).toBe('missing');
  });

  it('works without a settingsRepo, falling back straight to the default env var', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    const pgDumpPath = await makeRealFile();
    process.env.PG_DUMP_PATH = pgDumpPath;

    const result = await testDirectDumpCompatibility(connection, ctx.secretStore, undefined, {
      testConnectionOverride: fakeOk('18.0'),
    });

    expect(result.ok).toBe(true);
    expect(result.toolCompatibility).toBe('default-unverified');
  });

  it('uses the real testDatabaseConnection (no override) by default and fails cleanly with no PSQL_PATH configured', async () => {
    const ctx = createTestContext();
    const connection = seedPostgresConnection(ctx);
    delete process.env.PSQL_PATH;

    const result = await testDirectDumpCompatibility(connection, createFakeSecretStore(), ctx.settingsRepo);

    expect(result.ok).toBe(false);
    expect(result.connection.message).toMatch(/PSQL_PATH/);
  });
});
