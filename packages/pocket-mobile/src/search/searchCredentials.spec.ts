import { SAMPLE_POCKET_SNAPSHOT } from 'pocket-shared/fixtures';
import { searchPocketSnapshot } from './searchCredentials';

describe('searchPocketSnapshot', () => {
  it('empty query returns everything, favorites first', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, '');
    expect(results.credentials).toHaveLength(3);
    expect(results.credentials[0].credential.favorite).toBe(true);
  });

  it('"acme" matches every credential/url belonging to that client, by client name', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'acme');
    expect(results.credentials.map((r) => r.credential.id).sort()).toEqual(['cred-mysql', 'cred-ssh']);
    expect(results.urls.map((r) => r.url.id)).toEqual(['url-admin']);
  });

  it('"acme mysql" (client + kind, the flagship example) narrows to exactly one credential', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'acme mysql');
    expect(results.credentials.map((r) => r.credential.id)).toEqual(['cred-mysql']);
  });

  it('"cardiomed postgres" finds the right credential for a different client', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'cardiomed postgres');
    expect(results.credentials.map((r) => r.credential.id)).toEqual(['cred-postgres']);
  });

  it('matches on tags and environment too', () => {
    expect(searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'staging').credentials.map((r) => r.credential.id)).toEqual(['cred-postgres']);
    expect(searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'ssh').credentials.map((r) => r.credential.id)).toEqual(['cred-ssh']);
  });

  it('matches URLs by name and by the URL itself', () => {
    expect(searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'admin').urls).toHaveLength(1);
    expect(searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'example.test/admin').urls).toHaveLength(1);
  });

  it('every token must match — "acme postgres" (wrong combination) matches nothing', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'acme postgres');
    expect(results.credentials).toHaveLength(0);
  });

  it('NEVER matches inside a secret value — searching the actual fixture password finds nothing', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'correct-horse-test-only');
    expect(results.credentials).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'MYSQL').credentials).toHaveLength(1);
  });

  it('an unmatched query returns empty arrays, not an error', () => {
    const results = searchPocketSnapshot(SAMPLE_POCKET_SNAPSHOT, 'nonexistent-client-xyz');
    expect(results.credentials).toHaveLength(0);
    expect(results.urls).toHaveLength(0);
  });
});
