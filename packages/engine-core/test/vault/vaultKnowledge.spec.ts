import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

describe('vaultUrlsRepo', () => {
  let ctx: TestContext;
  let clientId: string;
  beforeEach(() => {
    ctx = createTestContext();
    clientId = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B' }).id;
  });

  it('CRUD + tags round trip', () => {
    const u = ctx.vaultUrlsRepo.create({
      clientId,
      name: 'CloudPanel',
      url: 'https://panel.rivera.com',
      environment: 'production',
      tags: ['panel'],
    });
    expect(u.tags).toEqual(['panel']);
    const upd = ctx.vaultUrlsRepo.update(u.id, { favorite: true, url: 'https://panel2.rivera.com' });
    expect(upd.favorite).toBe(true);
    expect(upd.url).toBe('https://panel2.rivera.com');
    ctx.vaultUrlsRepo.delete(u.id);
    expect(ctx.vaultUrlsRepo.getById(u.id)).toBeNull();
  });

  it('search across name/url/environment/tags', () => {
    ctx.vaultUrlsRepo.create({ clientId, name: 'CloudPanel', url: 'https://panel.rivera.com', environment: 'production' });
    ctx.vaultUrlsRepo.create({ clientId, name: 'ERP', url: 'https://erp.rivera.com', tags: ['erp', 'integration'] });
    expect(ctx.vaultUrlsRepo.search(['panel']).map((u) => u.name)).toEqual(['CloudPanel']);
    expect(ctx.vaultUrlsRepo.search(['rivera', 'erp']).map((u) => u.name)).toEqual(['ERP']);
    expect(ctx.vaultUrlsRepo.search(['integration']).map((u) => u.name)).toEqual(['ERP']);
  });

  it('linked_credential_id is SET NULL when the credential is deleted', () => {
    const cred = ctx.vaultCredentialsRepo.create({ clientId, name: 'panel-login', kind: 'web_panel' });
    const u = ctx.vaultUrlsRepo.create({ clientId, name: 'CloudPanel', url: 'https://p', linkedCredentialId: cred.id });
    expect(ctx.vaultUrlsRepo.getById(u.id)!.linkedCredentialId).toBe(cred.id);
    ctx.vaultCredentialsRepo.delete(cred.id);
    expect(ctx.vaultUrlsRepo.getById(u.id)!.linkedCredentialId).toBeNull();
  });
});

describe('vaultItemsRepo', () => {
  let ctx: TestContext;
  let clientId: string;
  beforeEach(() => {
    ctx = createTestContext();
    clientId = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B' }).id;
  });

  it('creates a snippet with plaintext body + metadata', () => {
    const s = ctx.vaultItemsRepo.create({
      clientId,
      type: 'snippet',
      title: 'Restart integration',
      bodyPlaintext: 'sudo systemctl restart rivera-integration',
      metadata: { language: 'bash' },
      tags: ['ops'],
    });
    expect(s.isSensitive).toBe(false);
    expect(s.metadata.language).toBe('bash');
    expect(ctx.vaultItemsRepo.getById(s.id)!.bodyPlaintext).toContain('systemctl');
  });

  it('creates a process with ordered steps + linked ids in metadata', () => {
    const p = ctx.vaultItemsRepo.create({
      clientId,
      type: 'process',
      title: 'Restore database',
      metadata: {
        steps: [{ text: 'Stop the app' }, { text: 'Run restore', command: 'mysql < dump.sql' }],
        linkedCredentialIds: ['cred-1'],
        warnings: 'Prod!',
      },
    });
    const read = ctx.vaultItemsRepo.getById(p.id)!;
    expect(read.metadata.steps).toHaveLength(2);
    expect(read.metadata.steps![1].command).toBe('mysql < dump.sql');
    expect(read.metadata.warnings).toBe('Prod!');
  });

  it('listByClient filters by type', () => {
    ctx.vaultItemsRepo.create({ clientId, type: 'snippet', title: 'a' });
    ctx.vaultItemsRepo.create({ clientId, type: 'note', title: 'b' });
    ctx.vaultItemsRepo.create({ clientId, type: 'note', title: 'c' });
    expect(ctx.vaultItemsRepo.listByClient(clientId, 'note').map((i) => i.title).sort()).toEqual(['b', 'c']);
    expect(ctx.vaultItemsRepo.listByClient(clientId).length).toBe(3);
  });

  it('search matches a non-sensitive body but NOT a sensitive one', () => {
    ctx.vaultItemsRepo.create({
      clientId,
      type: 'snippet',
      title: 'public cmd',
      bodyPlaintext: 'docker compose restart app',
    });
    ctx.vaultItemsRepo.create({
      clientId,
      type: 'note',
      title: 'sensitive note',
      isSensitive: true,
      bodyBlobRef: 'vault:item:xyz',
      bodyPlaintext: null,
    });
    expect(ctx.vaultItemsRepo.search(['docker']).map((i) => i.title)).toEqual(['public cmd']);
    // a token that would only appear in a sensitive body's plaintext (which is null) returns nothing
    expect(ctx.vaultItemsRepo.search(['xyz'])).toHaveLength(0);
    // but the sensitive item is still findable by its title/metadata
    expect(ctx.vaultItemsRepo.search(['sensitive']).map((i) => i.title)).toEqual(['sensitive note']);
  });

  it('delete returns bodyBlobRef so the caller can drop the ciphertext', () => {
    const s = ctx.vaultItemsRepo.create({ clientId, type: 'note', title: 'x', isSensitive: true, bodyBlobRef: 'vault:item:zzz' });
    expect(ctx.vaultItemsRepo.delete(s.id)).toEqual({ bodyBlobRef: 'vault:item:zzz' });
  });
});
