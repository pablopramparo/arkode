import { describe, expect, it } from 'vitest';
import { isPlatformSupported } from '@primno/dpapi';
import { MachineDpapiSecretStore } from '../../src/secrets/machineDpapiStore.js';
import { createTestContext } from '../helpers/testContext.js';

// Real DPAPI calls, not mocked — this suite only runs meaningfully on
// Windows (where this whole app runs); it self-skips elsewhere.
describe.skipIf(!isPlatformSupported)('MachineDpapiSecretStore', () => {
  it('round-trips a secret through real DPAPI encryption', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    store.set('transport:abc:passphrase', 'hunter2');

    expect(store.get('transport:abc:passphrase')).toBe('hunter2');
  });

  it('returns null for a ref that was never set', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    expect(store.get('nonexistent')).toBeNull();
  });

  it('overwrites an existing secret on a second set()', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    store.set('db:xyz:password', 'first');
    store.set('db:xyz:password', 'second');

    expect(store.get('db:xyz:password')).toBe('second');
  });

  it('delete() removes a secret so it reads back as null', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    store.set('to-delete', 'value');
    store.delete('to-delete');

    expect(store.get('to-delete')).toBeNull();
  });

  it('delete() on a never-set ref is a no-op, not an error', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    expect(() => store.delete('never-existed')).not.toThrow();
  });

  it('stores ciphertext, not the plaintext, in the underlying table', () => {
    const ctx = createTestContext();
    const store = new MachineDpapiSecretStore(ctx.db);

    store.set('check-ciphertext', 'my-secret-value');

    const row = ctx.db.prepare('SELECT ciphertext FROM secrets WHERE ref = ?').get('check-ciphertext') as
      | { ciphertext: Buffer }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.ciphertext.toString('utf8')).not.toContain('my-secret-value');
  });
});
