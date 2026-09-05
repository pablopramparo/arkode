import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/logging/redact.js';

describe('redactSecrets — redacts well-defined secret shapes', () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    {
      name: 'password= assignment',
      input: 'mysqldump failed: Access denied (password=hunter2)',
      expected: 'mysqldump failed: Access denied (password=[redacted])',
    },
    {
      name: 'passwd: assignment',
      input: 'config line — passwd: s3cr3tValue trailing',
      expected: 'config line — passwd=[redacted] trailing',
    },
    {
      name: 'passphrase= assignment',
      input: 'ssh key passphrase=correct-horse-battery',
      expected: 'ssh key passphrase=[redacted]',
    },
    {
      name: 'token= assignment',
      input: 'GET https://api.example.com/x?token=abc123def& other',
      expected: 'GET https://api.example.com/x?token=[redacted] other',
    },
    {
      name: 'client_secret assignment',
      input: 'oauth client_secret=GOCSPX-abc_def-123',
      expected: 'oauth client_secret=[redacted]',
    },
    {
      name: 'api_key / api-key / apikey variants',
      input: 'api_key=AAA api-key=BBB apikey=CCC',
      expected: 'api_key=[redacted] api-key=[redacted] apikey=[redacted]',
    },
    {
      name: 'PGPASSWORD env var (not matched by a bare \\bpassword)',
      input: 'child env: PGPASSWORD=topsecret PGSSLMODE=require',
      expected: 'child env: PGPASSWORD=[redacted] PGSSLMODE=require',
    },
    {
      name: 'MYSQL_PWD env var',
      input: 'spawn with MYSQL_PWD=letmein and host=db',
      expected: 'spawn with MYSQL_PWD=[redacted] and host=db',
    },
    {
      name: 'RESTIC_PASSWORD env var',
      input: 'RESTIC_PASSWORD=abc/def+ghi restic backup',
      expected: 'RESTIC_PASSWORD=[redacted] restic backup',
    },
    {
      name: 'credentials embedded in a DSN / URL',
      input: 'connect string postgres://appuser:s3cr3t@db.host:5432/app failed',
      expected: 'connect string postgres://appuser:[redacted]@db.host:5432/app failed',
    },
    {
      name: 'credentials in an sftp URL',
      input: 'sftp://backup:p4ssw0rd@10.0.0.5/home',
      expected: 'sftp://backup:[redacted]@10.0.0.5/home',
    },
    {
      name: '--password CLI flag (space form)',
      input: 'mariadb-dump --host x --password superSecret --databases app',
      expected: 'mariadb-dump --host x --password [redacted] --databases app',
    },
    {
      name: '--password= CLI flag (equals form)',
      input: 'tool --password=superSecret --verbose',
      expected: 'tool --password [redacted] --verbose',
    },
    {
      name: '--crypt-password CLI flag',
      input: 'rclone --crypt-password=obscuredValue sync',
      expected: 'rclone --crypt-password [redacted] sync',
    },
    {
      name: 'Authorization: Bearer header',
      input: 'request headers Authorization: Bearer eyJhbGci.payload.sig done',
      expected: 'request headers Authorization: Bearer [redacted] done',
    },
    {
      name: 'Authorization: Basic header',
      input: 'Authorization: Basic dXNlcjpwYXNz',
      expected: 'Authorization: Basic [redacted]',
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(redactSecrets(input)).toBe(expected);
    });
  }

  it('redacts an exact known secret passed by the caller', () => {
    const input = 'the dump used the value MyL1teralPass while connecting';
    expect(redactSecrets(input, ['MyL1teralPass'])).toBe('the dump used the value [redacted] while connecting');
  });

  it('redacts a known secret even where no shape pattern would catch it', () => {
    // A bare token embedded in prose — only knownSecrets can catch this.
    const input = 'note: recovery key is aB3xK9mQ7pL2 keep it safe';
    expect(redactSecrets(input, ['aB3xK9mQ7pL2'])).toContain('[redacted]');
    expect(redactSecrets(input, ['aB3xK9mQ7pL2'])).not.toContain('aB3xK9mQ7pL2');
  });

  it('ignores trivially short knownSecrets', () => {
    const input = 'a a a status a ok';
    expect(redactSecrets(input, ['a', '12'])).toBe(input);
  });

  it('returns falsy/empty input unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });
});

describe('redactSecrets — leaves legitimate long/hex/id strings readable (no false positives)', () => {
  const survives: Array<{ name: string; input: string }> = [
    {
      name: 'a bare SHA-256 hex digest',
      input: 'Backup succeeded: D:\\Backups\\x.dump (sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)',
    },
    {
      name: 'an SHA256: SSH host-key fingerprint',
      input: 'host key SHA256:uRHfr8x2Q9m0Kk4t7bV1cZ2yN3pL5aE6dH8sW9jT0gU presented',
    },
    {
      name: 'a UUID (run id / row id)',
      input: 'run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 started',
    },
    {
      name: 'a restic snapshot id (short hex)',
      input: 'forgetting snapshot 1a2b3c4d and keeping 9f8e7d6c',
    },
    {
      name: 'a base64-looking data-added figure in restic output',
      input: 'restic summary: data_added 4823719 bytes, tree blobs YmxvYg==',
    },
    {
      name: 'a Windows file path with a keys directory',
      input: 'reading key C:\\ProgramData\\arkode\\keys\\a1b2c3d4-e5f6-7890-ab12-cd34ef56ab78.key',
    },
    {
      name: 'the word "password" with no assignment (prose)',
      input: 'the backup user does not need a password for key auth',
    },
    {
      name: 'a token count / numeric metric',
      input: 'processed 128374 files, total_bytes_processed 998877665',
    },
  ];

  for (const { name, input } of survives) {
    it(name, () => {
      expect(redactSecrets(input)).toBe(input);
    });
  }
});
