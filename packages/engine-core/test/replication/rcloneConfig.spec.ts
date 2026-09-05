import { describe, expect, it } from 'vitest';
import { buildRcloneConfigIni, rcloneRemoteSection } from '../../src/replication/rcloneConfig.js';
import { extractTokenBlob } from '../../src/replication/rcloneClient.js';

const TOKEN = '{"access_token":"ya29.aaa","token_type":"Bearer","refresh_token":"1//rrr","expiry":"2026-01-01T00:00:00Z"}';

describe('buildRcloneConfigIni', () => {
  it('emits a bare [base] section for a non-encrypted rclone_drive (restic_repo) target', () => {
    const ini = buildRcloneConfigIni({ remote: { provider: 'rclone_drive', drive: { token: TOKEN } }, withCrypt: false });
    expect(ini).toContain('[base]');
    expect(ini).toContain('type = drive');
    expect(ini).toContain(`token = ${TOKEN}`);
    expect(ini).not.toContain('[crypt]');
  });

  it('includes optional client_id / client_secret / team_drive when supplied', () => {
    const ini = buildRcloneConfigIni({
      remote: {
        provider: 'rclone_drive',
        drive: { token: TOKEN, clientId: 'cid', clientSecret: 'csec', teamDrive: 'td1', rootFolderId: 'rf1' },
      },
      withCrypt: false,
    });
    expect(ini).toContain('client_id = cid');
    expect(ini).toContain('client_secret = csec');
    expect(ini).toContain('team_drive = td1');
    expect(ini).toContain('root_folder_id = rf1');
  });

  it('adds a [crypt] section wrapping base: when withCrypt', () => {
    const ini = buildRcloneConfigIni({
      remote: { provider: 'rclone_drive', drive: { token: TOKEN } },
      withCrypt: true,
      obscuredCryptPassword: 'OBSCURED123',
    });
    expect(ini).toContain('[crypt]');
    expect(ini).toContain('type = crypt');
    expect(ini).toContain('remote = base:');
    expect(ini).toContain('password = OBSCURED123');
    // Readable names in Drive, encrypted contents only (user's choice).
    expect(ini).toContain('filename_encryption = off');
    expect(ini).toContain('directory_name_encryption = false');
  });

  it('throws if withCrypt but no obscured password given', () => {
    expect(() =>
      buildRcloneConfigIni({ remote: { provider: 'rclone_drive', drive: { token: TOKEN } }, withCrypt: true })
    ).toThrow(/obscuredCryptPassword/);
  });

  it('emits an sftp section with key_file, key_file_pass, and known_hosts_file', () => {
    const ini = buildRcloneConfigIni({
      remote: {
        provider: 'rclone_sftp',
        sftp: { host: 'h', port: 22, username: 'u', privateKeyPath: 'C:/keys/x.key' },
      },
      withCrypt: false,
      obscuredKeyPassphrase: 'OBSCUREDPASS',
      knownHostsFilePath: 'C:/tmp/known_hosts',
    });
    expect(ini).toContain('[base]');
    expect(ini).toContain('type = sftp');
    expect(ini).toContain('host = h');
    expect(ini).toContain('port = 22');
    expect(ini).toContain('user = u');
    expect(ini).toContain('key_file = C:/keys/x.key');
    expect(ini).toContain('key_file_pass = OBSCUREDPASS');
    expect(ini).toContain('known_hosts_file = C:/tmp/known_hosts');
  });

  it('omits key_file_pass/known_hosts_file when not supplied', () => {
    const ini = buildRcloneConfigIni({
      remote: {
        provider: 'rclone_sftp',
        sftp: { host: 'h', port: 22, username: 'u', privateKeyPath: 'C:/keys/x.key' },
      },
      withCrypt: false,
    });
    expect(ini).not.toContain('key_file_pass');
    expect(ini).not.toContain('known_hosts_file');
  });

  it('emits an ftp section with an obscured pass', () => {
    const ini = buildRcloneConfigIni({
      remote: { provider: 'rclone_ftp', ftp: { host: 'h', port: 21, username: 'u', password: 'ignored-here' } },
      withCrypt: false,
      obscuredFtpPassword: 'OBSCUREDFTP',
    });
    expect(ini).toContain('[base]');
    expect(ini).toContain('type = ftp');
    expect(ini).toContain('host = h');
    expect(ini).toContain('port = 21');
    expect(ini).toContain('user = u');
    expect(ini).toContain('pass = OBSCUREDFTP');
  });

  it('throws if an ftp remote has no obscuredFtpPassword', () => {
    expect(() =>
      buildRcloneConfigIni({
        remote: { provider: 'rclone_ftp', ftp: { host: 'h', port: 21, username: 'u', password: 'x' } },
        withCrypt: false,
      })
    ).toThrow(/obscuredFtpPassword/);
  });
});

describe('rcloneRemoteSection', () => {
  it('is "base" without crypt and "crypt" with it', () => {
    expect(rcloneRemoteSection({ encryptWithCrypt: false })).toBe('base');
    expect(rcloneRemoteSection({ encryptWithCrypt: true })).toBe('crypt');
  });
});

describe('extractTokenBlob', () => {
  it('pulls the JSON out of rclone authorize output with paste markers', () => {
    const output = `Paste the following into your remote machine --->\n${TOKEN}\n<---End paste`;
    expect(extractTokenBlob(output)).toBe(TOKEN);
  });

  it('accepts a bare token line', () => {
    expect(extractTokenBlob(`\n${TOKEN}\n`)).toBe(TOKEN);
  });

  it('returns null when there is no token', () => {
    expect(extractTokenBlob('nothing useful here')).toBeNull();
  });
});
