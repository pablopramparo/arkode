import type { ReplicationTarget, ResolvedRcloneRemote } from './types.js';

/**
 * rclone.conf serialization for a replication target. Kept as a pure,
 * synchronous string builder (no I/O, no child_process) so it can be unit
 * tested directly — rcloneClient.ts is responsible for obtaining the
 * "obscured" crypt password/key passphrase, writing the known_hosts temp
 * file (sftp only), and writing the rclone.conf temp file itself.
 */

/** The rclone remote section a sync/copy/about call should address for this target. */
export function rcloneRemoteSection(target: Pick<ReplicationTarget, 'encryptWithCrypt'>): string {
  return target.encryptWithCrypt ? CRYPT_SECTION : BASE_SECTION;
}

// Generic names, not provider-specific: each generated rclone.conf describes
// exactly one target for exactly one call, so there's no need for a
// per-provider section name (this used to be "drive"/"gdrive-crypt").
export const BASE_SECTION = 'base';
export const CRYPT_SECTION = 'crypt';

export interface BuildRcloneConfigParams {
  remote: ResolvedRcloneRemote;
  /**
   * The rclone-"obscured" crypt password (output of `rclone obscure`).
   * Required when the target uses crypt; ignored otherwise.
   */
  obscuredCryptPassword?: string;
  withCrypt: boolean;
  /** rclone_sftp only: the rclone-"obscured" private key passphrase, if the key has one. */
  obscuredKeyPassphrase?: string;
  /** rclone_ftp only: the rclone-"obscured" transport password. */
  obscuredFtpPassword?: string;
  /**
   * rclone_sftp only: absolute path to a temp OpenSSH known_hosts file
   * rcloneClient.ts wrote from the target's pinned SftpHostKeyCaptureResult.
   * This vendored rclone version has no inline "host_keys"/"pin_host_key"
   * option (confirmed against `rclone help backend sftp`) -- known_hosts_file
   * is the only real host-key-verification mechanism it supports.
   */
  knownHostsFilePath?: string;
}

/**
 * Builds a complete rclone.conf body: a `[base]` section always, plus a
 * `[crypt]` section wrapping it when `withCrypt`. The crypt section points
 * at `base:` (bare) so the target's remote_path is supplied at call time.
 *
 * Crypt is configured `filename_encryption = off`: destination file/folder
 * NAMES stay readable/identifiable (`arkode/dumps/<task>/<yyyy>/<mm>/…`) and
 * only the file *contents* are encrypted (rclone appends `.bin` to each).
 * Deliberate trade-off chosen by the user over fully-opaque names: the
 * filename reveals db name / date / size, but the backup bytes are still
 * unreadable without the crypt password. `restic_repo` targets aren't
 * crypt-wrapped at all (restic self-encrypts).
 */
export function buildRcloneConfigIni(params: BuildRcloneConfigParams): string {
  const lines: string[] = [`[${BASE_SECTION}]`];

  switch (params.remote.provider) {
    case 'rclone_drive': {
      const { drive } = params.remote;
      lines.push('type = drive');
      lines.push('scope = drive');
      // rclone wants the token blob as a single line of JSON.
      lines.push(`token = ${drive.token.trim()}`);
      if (drive.clientId) lines.push(`client_id = ${drive.clientId}`);
      if (drive.clientSecret) lines.push(`client_secret = ${drive.clientSecret}`);
      if (drive.teamDrive) lines.push(`team_drive = ${drive.teamDrive}`);
      if (drive.rootFolderId) lines.push(`root_folder_id = ${drive.rootFolderId}`);
      break;
    }
    case 'rclone_sftp': {
      const { sftp } = params.remote;
      lines.push('type = sftp');
      lines.push(`host = ${sftp.host}`);
      lines.push(`port = ${sftp.port}`);
      lines.push(`user = ${sftp.username}`);
      lines.push(`key_file = ${sftp.privateKeyPath}`);
      if (params.obscuredKeyPassphrase) lines.push(`key_file_pass = ${params.obscuredKeyPassphrase}`);
      if (params.knownHostsFilePath) lines.push(`known_hosts_file = ${params.knownHostsFilePath}`);
      break;
    }
    case 'rclone_ftp': {
      const { ftp } = params.remote;
      if (!params.obscuredFtpPassword) {
        throw new Error('buildRcloneConfigIni: rclone_ftp remote is missing obscuredFtpPassword.');
      }
      lines.push('type = ftp');
      lines.push(`host = ${ftp.host}`);
      lines.push(`port = ${ftp.port}`);
      lines.push(`user = ${ftp.username}`);
      lines.push(`pass = ${params.obscuredFtpPassword}`);
      break;
    }
  }

  if (params.withCrypt) {
    if (!params.obscuredCryptPassword) {
      throw new Error('buildRcloneConfigIni: withCrypt is set but obscuredCryptPassword is missing.');
    }
    lines.push('');
    lines.push(`[${CRYPT_SECTION}]`);
    lines.push('type = crypt');
    lines.push(`remote = ${BASE_SECTION}:`);
    lines.push(`password = ${params.obscuredCryptPassword}`);
    lines.push('filename_encryption = off');
    lines.push('directory_name_encryption = false');
  }

  return lines.join('\n') + '\n';
}
