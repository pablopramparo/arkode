import { describe, it, expect } from 'vitest';
import { createTestContext } from '../helpers/testContext.js';
import { createMariaDbToolRegistry, extractMariaDbMajorMinorVersion } from '../../src/databaseConnections/mariaDbToolRegistry.js';

describe('extractMariaDbMajorMinorVersion', () => {
  it('extracts major.minor and ignores the trailing "-MariaDB" suffix', () => {
    expect(extractMariaDbMajorMinorVersion('11.5.2-MariaDB')).toBe('11.5');
    expect(extractMariaDbMajorMinorVersion('10.11.6-MariaDB')).toBe('10.11');
  });

  it('falls back to the raw string when nothing matches', () => {
    expect(extractMariaDbMajorMinorVersion('not-a-version')).toBe('not-a-version');
  });
});

describe('createMariaDbToolRegistry', () => {
  it('starts empty', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);
    expect(registry.list()).toEqual({});
    expect(registry.resolve('11.5.2-MariaDB')).toBeNull();
  });

  it('registers and resolves an entry by detected server version', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);

    registry.register('11.5', { mariaDbDumpPath: 'C:\\maria115\\mariadb-dump.exe' });

    expect(registry.resolve('11.5.2-MariaDB')).toEqual({ mariaDbDumpPath: 'C:\\maria115\\mariadb-dump.exe' });
    expect(registry.resolve('10.11.6-MariaDB')).toBeNull();
  });

  it('replaces an existing entry when registering the same major.minor version again', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);

    registry.register('11.5', { mariaDbDumpPath: 'old\\mariadb-dump.exe' });
    registry.register('11.5', { mariaDbDumpPath: 'new\\mariadb-dump.exe' });

    expect(registry.resolve('11.5.9-MariaDB')).toEqual({ mariaDbDumpPath: 'new\\mariadb-dump.exe' });
  });

  it('unregisters an entry, after which it no longer resolves', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);

    registry.register('11.5', { mariaDbDumpPath: 'a' });
    registry.unregister('11.5');

    expect(registry.resolve('11.5.2-MariaDB')).toBeNull();
    expect(registry.list()).toEqual({});
  });

  it('unregistering a version that was never registered is a no-op', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);

    expect(() => registry.unregister('9.9')).not.toThrow();
    expect(registry.list()).toEqual({});
  });

  it('supports multiple registered versions at once', () => {
    const { settingsRepo } = createTestContext();
    const registry = createMariaDbToolRegistry(settingsRepo);

    registry.register('10.11', { mariaDbDumpPath: 'maria1011-dump' });
    registry.register('11.5', { mariaDbDumpPath: 'maria115-dump' });

    expect(registry.resolve('10.11.6-MariaDB')).toEqual({ mariaDbDumpPath: 'maria1011-dump' });
    expect(registry.resolve('11.5.2-MariaDB')).toEqual({ mariaDbDumpPath: 'maria115-dump' });
    expect(Object.keys(registry.list()).sort()).toEqual(['10.11', '11.5']);
  });

  it('persists across separate registry instances backed by the same settingsRepo', () => {
    const { settingsRepo } = createTestContext();
    createMariaDbToolRegistry(settingsRepo).register('11.5', { mariaDbDumpPath: 'a' });

    const secondInstance = createMariaDbToolRegistry(settingsRepo);
    expect(secondInstance.resolve('11.5.9-MariaDB')).toEqual({ mariaDbDumpPath: 'a' });
  });
});
