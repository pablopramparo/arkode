import { describe, it, expect } from 'vitest';
import { createTestContext } from '../helpers/testContext.js';
import { createMysqlToolRegistry, extractMysqlMajorMinorVersion } from '../../src/databaseConnections/mysqlToolRegistry.js';

describe('extractMysqlMajorMinorVersion', () => {
  it('extracts major.minor from a full server version string', () => {
    expect(extractMysqlMajorMinorVersion('9.1.0')).toBe('9.1');
    expect(extractMysqlMajorMinorVersion('8.0.35')).toBe('8.0');
  });

  it('falls back to the raw string when nothing matches', () => {
    expect(extractMysqlMajorMinorVersion('not-a-version')).toBe('not-a-version');
  });
});

describe('createMysqlToolRegistry', () => {
  it('starts empty', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);
    expect(registry.list()).toEqual({});
    expect(registry.resolve('9.1.0')).toBeNull();
  });

  it('registers and resolves an entry by detected server version', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);

    registry.register('9.1', { mysqldumpPath: 'C:\\mysql91\\mysqldump.exe' });

    expect(registry.resolve('9.1.0')).toEqual({ mysqldumpPath: 'C:\\mysql91\\mysqldump.exe' });
    expect(registry.resolve('8.0.35')).toBeNull();
  });

  it('replaces an existing entry when registering the same major.minor version again', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);

    registry.register('9.1', { mysqldumpPath: 'old\\mysqldump.exe' });
    registry.register('9.1', { mysqldumpPath: 'new\\mysqldump.exe' });

    expect(registry.resolve('9.1.5')).toEqual({ mysqldumpPath: 'new\\mysqldump.exe' });
  });

  it('unregisters an entry, after which it no longer resolves', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);

    registry.register('9.1', { mysqldumpPath: 'a' });
    registry.unregister('9.1');

    expect(registry.resolve('9.1.0')).toBeNull();
    expect(registry.list()).toEqual({});
  });

  it('unregistering a version that was never registered is a no-op', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);

    expect(() => registry.unregister('9.9')).not.toThrow();
    expect(registry.list()).toEqual({});
  });

  it('supports multiple registered versions at once', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMysqlToolRegistry(settingsRepo);

    registry.register('8.0', { mysqldumpPath: 'mysql80-dump' });
    registry.register('9.1', { mysqldumpPath: 'mysql91-dump' });

    expect(registry.resolve('8.0.35')).toEqual({ mysqldumpPath: 'mysql80-dump' });
    expect(registry.resolve('9.1.0')).toEqual({ mysqldumpPath: 'mysql91-dump' });
    expect(Object.keys(registry.list()).sort()).toEqual(['8.0', '9.1']);
  });

  it('persists across separate registry instances backed by the same settingsRepo', () => {
    const { settingsRepo } = createTestContext();
    createMysqlToolRegistry(settingsRepo).register('9.1', { mysqldumpPath: 'a' });

    const secondInstance = createMysqlToolRegistry(settingsRepo);
    expect(secondInstance.resolve('9.1.2')).toEqual({ mysqldumpPath: 'a' });
  });
});
