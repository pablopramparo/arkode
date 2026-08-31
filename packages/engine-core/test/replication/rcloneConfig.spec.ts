import { describe, expect, it } from 'vitest';
import { buildRcloneConfigIni, rcloneRemoteSection } from '../../src/replication/rcloneConfig.js';
import { extractTokenBlob } from '../../src/replication/rcloneClient.js';

const TOKEN = '{"access_token":"ya29.aaa","token_type":"Bearer","refresh_token":"1//rrr","expiry":"2026-01-01T00:00:00Z"}';

describe('buildRcloneConfigIni', () => {
  it('emits a bare [drive] section for a non-encrypted (restic_repo) target', () => {
    const ini = buildRcloneConfigIni({ drive: { token: TOKEN }, withCrypt: false });
    expect(ini).toContain('[drive]');
    expect(ini).toContain('type = drive');
    expect(ini).toContain(`token = ${TOKEN}`);
    expect(ini).not.toContain('[gdrive-crypt]');
  });

  it('includes optional client_id / client_secret / team_drive when supplied', () => {
    const ini = buildRcloneConfigIni({
      drive: { token: TOKEN, clientId: 'cid', clientSecret: 'csec', teamDrive: 'td1', rootFolderId: 'rf1' },
      withCrypt: false,
    });
    expect(ini).toContain('client_id = cid');
    expect(ini).toContain('client_secret = csec');
    expect(ini).toContain('team_drive = td1');
    expect(ini).toContain('root_folder_id = rf1');
  });

  it('adds a [gdrive-crypt] section wrapping drive: when withCrypt', () => {
    const ini = buildRcloneConfigIni({
      drive: { token: TOKEN },
      withCrypt: true,
      obscuredCryptPassword: 'OBSCURED123',
    });
    expect(ini).toContain('[gdrive-crypt]');
    expect(ini).toContain('type = crypt');
    expect(ini).toContain('remote = drive:');
    expect(ini).toContain('password = OBSCURED123');
    // Readable names in Drive, encrypted contents only (user's choice).
    expect(ini).toContain('filename_encryption = off');
    expect(ini).toContain('directory_name_encryption = false');
  });

  it('throws if withCrypt but no obscured password given', () => {
    expect(() => buildRcloneConfigIni({ drive: { token: TOKEN }, withCrypt: true })).toThrow(/obscuredCryptPassword/);
  });
});

describe('rcloneRemoteSection', () => {
  it('is "drive" without crypt and "gdrive-crypt" with it', () => {
    expect(rcloneRemoteSection({ encryptWithCrypt: false })).toBe('drive');
    expect(rcloneRemoteSection({ encryptWithCrypt: true })).toBe('gdrive-crypt');
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
