import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { keysDir as defaultKeysDir } from '../paths.js';

/**
 * Copies a user-supplied SSH private key file into this app's own keys
 * directory, returning the new path to store on the transport instead of
 * the original. Called at transport create/update time (see engine-cli's
 * transport:create-sftp/-ssh/:update and serve's equivalent HTTP routes),
 * not inside transportsRepo itself — repos stay pure SQL, this is I/O.
 *
 * Why bother copying rather than referencing the original path directly:
 * the original could live anywhere the user happened to put it (their
 * Downloads folder, a USB drive, another user's profile) with no
 * guarantee it stays there, or that every account on this machine can
 * read it. A task's Windows Scheduled Task runs as SYSTEM (see
 * taskDefinitionXml.ts) — owning a copy in a location this app controls
 * sidesteps both problems instead of hoping the original is always
 * reachable and readable.
 */
export function copyPrivateKeyIntoAppStorage(sourcePath: string, keysDirOverride?: string): string {
  const dir = keysDirOverride ?? defaultKeysDir();
  mkdirSync(dir, { recursive: true });
  const destPath = join(dir, `${randomUUID()}.key`);
  copyFileSync(sourcePath, destPath);
  return destPath;
}
