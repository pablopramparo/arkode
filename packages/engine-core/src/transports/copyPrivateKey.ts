import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { keysDir as defaultKeysDir } from '../paths.js';
import { hardenKeyFileAcl } from './keyFilePermissions.js';

/** Prefixes of an OpenSSH *public* key line — a very common wrong-file mistake ("arkode_key.pub" sits right next to "arkode_key"). */
const PUBLIC_KEY_PREFIXES = ['ssh-rsa ', 'ssh-ed25519 ', 'ssh-dss ', 'ecdsa-sha2-', 'sk-ssh-ed25519@', 'sk-ecdsa-sha2-'];

/** Throws a clear, actionable error if `sourcePath` is a public key (.pub) rather than a private key. */
function assertLooksLikePrivateKey(sourcePath: string): void {
  let head: string;
  try {
    head = readFileSync(sourcePath, 'utf8').trimStart().slice(0, 200);
  } catch (err) {
    throw new Error(`Could not read the private key file "${sourcePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (PUBLIC_KEY_PREFIXES.some((p) => head.startsWith(p))) {
    throw new Error(
      `"${sourcePath}" looks like a public key (.pub) — point at the private key file instead (the one without the .pub extension).`
    );
  }
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(head) && !head.startsWith('PuTTY-User-Key-File-')) {
    throw new Error(
      `"${sourcePath}" doesn't look like an SSH private key (expected a "-----BEGIN … PRIVATE KEY-----" header). Check you selected the right file.`
    );
  }
}

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
export async function copyPrivateKeyIntoAppStorage(sourcePath: string, keysDirOverride?: string): Promise<string> {
  assertLooksLikePrivateKey(sourcePath);
  const dir = keysDirOverride ?? defaultKeysDir();
  mkdirSync(dir, { recursive: true });
  const destPath = join(dir, `${randomUUID()}.key`);
  copyFileSync(sourcePath, destPath);
  // Hardens only this app-owned copy, never sourcePath — see hardenKeyFileAcl's
  // own doc comment for why ProgramData's default inherited ACL is too broad
  // for OpenSSH's taste and why fs's `mode` option can't fix it on Windows.
  await hardenKeyFileAcl(destPath);
  return destPath;
}
