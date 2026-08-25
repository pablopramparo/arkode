import { describe, it, expect } from 'vitest';
import { createTestContext } from '../helpers/testContext.js';
import { createPostgresToolRegistry, extractMajorVersion } from '../../src/databaseConnections/postgresToolRegistry.js';

describe('extractMajorVersion', () => {
  it('returns the bare number for versions from 10 onward', () => {
    expect(extractMajorVersion('18.0')).toBe('18');
    expect(extractMajorVersion('15.4')).toBe('15');
    expect(extractMajorVersion('10')).toBe('10');
  });

  it('keeps the X.Y form for pre-10 versions', () => {
    expect(extractMajorVersion('9.6.3')).toBe('9.6');
    expect(extractMajorVersion('9.4')).toBe('9.4');
  });

  it('falls back to the raw string when nothing matches', () => {
    expect(extractMajorVersion('not-a-version')).toBe('not-a-version');
  });
});

describe('createPostgresToolRegistry', () => {
  it('starts empty', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);
    expect(registry.list()).toEqual({});
    expect(registry.resolve('18.0')).toBeNull();
  });

  it('registers and resolves an entry by detected server version', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);

    registry.register('18', { pgDumpPath: 'C:\\pg18\\pg_dump.exe', pgRestorePath: 'C:\\pg18\\pg_restore.exe' });

    expect(registry.resolve('18.0')).toEqual({
      pgDumpPath: 'C:\\pg18\\pg_dump.exe',
      pgRestorePath: 'C:\\pg18\\pg_restore.exe',
    });
    expect(registry.resolve('15.4')).toBeNull();
  });

  it('replaces an existing entry when registering the same major version again', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);

    registry.register('18', { pgDumpPath: 'old\\pg_dump.exe', pgRestorePath: 'old\\pg_restore.exe' });
    registry.register('18', { pgDumpPath: 'new\\pg_dump.exe', pgRestorePath: 'new\\pg_restore.exe' });

    expect(registry.resolve('18.2')).toEqual({ pgDumpPath: 'new\\pg_dump.exe', pgRestorePath: 'new\\pg_restore.exe' });
  });

  it('unregisters an entry, after which it no longer resolves', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);

    registry.register('18', { pgDumpPath: 'a', pgRestorePath: 'b' });
    registry.unregister('18');

    expect(registry.resolve('18.0')).toBeNull();
    expect(registry.list()).toEqual({});
  });

  it('unregistering a version that was never registered is a no-op', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);

    expect(() => registry.unregister('99')).not.toThrow();
    expect(registry.list()).toEqual({});
  });

  it('supports multiple registered versions at once', () => {
    const { settingsRepo } = createTestContext();
    const registry = createPostgresToolRegistry(settingsRepo);

    registry.register('15', { pgDumpPath: 'pg15-dump', pgRestorePath: 'pg15-restore' });
    registry.register('18', { pgDumpPath: 'pg18-dump', pgRestorePath: 'pg18-restore' });
    registry.register('9.6', { pgDumpPath: 'pg96-dump', pgRestorePath: 'pg96-restore' });

    expect(registry.resolve('15.4')).toEqual({ pgDumpPath: 'pg15-dump', pgRestorePath: 'pg15-restore' });
    expect(registry.resolve('18.0')).toEqual({ pgDumpPath: 'pg18-dump', pgRestorePath: 'pg18-restore' });
    expect(registry.resolve('9.6.24')).toEqual({ pgDumpPath: 'pg96-dump', pgRestorePath: 'pg96-restore' });
    expect(Object.keys(registry.list()).sort()).toEqual(['15', '18', '9.6']);
  });

  it('persists across separate registry instances backed by the same settingsRepo', () => {
    const { settingsRepo } = createTestContext();
    createPostgresToolRegistry(settingsRepo).register('18', { pgDumpPath: 'a', pgRestorePath: 'b' });

    const secondInstance = createPostgresToolRegistry(settingsRepo);
    expect(secondInstance.resolve('18.1')).toEqual({ pgDumpPath: 'a', pgRestorePath: 'b' });
  });
});
