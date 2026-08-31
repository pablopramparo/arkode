import type { RcloneDriveConfig, ReplicationTarget } from './types.js';

/**
 * rclone.conf serialization for a replication target. Kept as a pure,
 * synchronous string builder (no I/O, no child_process) so it can be unit
 * tested directly — rcloneClient.ts is responsible for obtaining the
 * "obscured" crypt password and writing the temp file.
 */

/** The rclone remote section a sync/copy/about call should address for this target. */
export function rcloneRemoteSection(target: Pick<ReplicationTarget, 'encryptWithCrypt'>): string {
  return target.encryptWithCrypt ? CRYPT_SECTION : DRIVE_SECTION;
}

export const DRIVE_SECTION = 'drive';
export const CRYPT_SECTION = 'gdrive-crypt';

export interface BuildRcloneConfigParams {
  drive: RcloneDriveConfig;
  /**
   * The rclone-"obscured" crypt password (output of `rclone obscure`).
   * Required when the target uses crypt; ignored otherwise.
   */
  obscuredCryptPassword?: string;
  withCrypt: boolean;
}

/**
 * Builds a complete rclone.conf body: a `[drive]` section always, plus a
 * `[gdrive-crypt]` section wrapping it when `withCrypt`. The crypt section
 * points at `drive:` (bare) so the target's remote_path is supplied at call
 * time.
 *
 * Crypt is configured `filename_encryption = off`: folder and file NAMES in
 * Drive stay readable/identifiable (`arkode/dumps/<task>/<yyyy>/<mm>/…`) and
 * only the file *contents* are encrypted (rclone appends `.bin` to each).
 * Deliberate trade-off chosen by the user over fully-opaque names: the
 * filename reveals db name / date / size, but the backup bytes are still
 * unreadable without the crypt password. `restic_repo` targets aren't
 * crypt-wrapped at all (restic self-encrypts).
 */
export function buildRcloneConfigIni(params: BuildRcloneConfigParams): string {
  const { drive } = params;
  const lines: string[] = [];

  lines.push(`[${DRIVE_SECTION}]`);
  lines.push('type = drive');
  lines.push('scope = drive');
  // rclone wants the token blob as a single line of JSON.
  lines.push(`token = ${drive.token.trim()}`);
  if (drive.clientId) lines.push(`client_id = ${drive.clientId}`);
  if (drive.clientSecret) lines.push(`client_secret = ${drive.clientSecret}`);
  if (drive.teamDrive) lines.push(`team_drive = ${drive.teamDrive}`);
  if (drive.rootFolderId) lines.push(`root_folder_id = ${drive.rootFolderId}`);

  if (params.withCrypt) {
    if (!params.obscuredCryptPassword) {
      throw new Error('buildRcloneConfigIni: withCrypt is set but obscuredCryptPassword is missing.');
    }
    lines.push('');
    lines.push(`[${CRYPT_SECTION}]`);
    lines.push('type = crypt');
    lines.push(`remote = ${DRIVE_SECTION}:`);
    lines.push(`password = ${params.obscuredCryptPassword}`);
    lines.push('filename_encryption = off');
    lines.push('directory_name_encryption = false');
  }

  return lines.join('\n') + '\n';
}
