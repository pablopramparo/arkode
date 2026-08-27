import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keysDir } from '../paths.js';

const execFileAsync = promisify(execFile);

/** Well-known SIDs, locale-independent — the same reasoning taskDefinitionXml.ts already
 * documents for SYSTEM (a literal "SYSTEM"/"Administrators" name is a *display* name that
 * only resolves under an English-language Windows install; this machine's own Spanish
 * install shows local Administrators as "BUILTIN\Administradores", confirmed by hand). */
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINISTRATORS = '*S-1-5-32-544';

/** Shared by the async and sync variants below — resolves the icacls argv, or throws if the current user can't be determined. */
function buildIcaclsArgs(filePath: string): string[] {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  if (!domain || !user) {
    throw new Error(
      `Could not resolve the current Windows user (USERDOMAIN/USERNAME env vars) to set permissions on "${filePath}".`
    );
  }
  return [filePath, '/inheritance:r', '/grant:r', `${domain}\\${user}:M`, `${SID_SYSTEM}:F`, `${SID_ADMINISTRATORS}:F`];
}

/**
 * Restricts an SSH private key file's Windows ACL to only the principals
 * that actually need it, breaking inheritance from the parent folder first.
 *
 * Root cause this exists for: every key file this app writes under
 * `%PROGRAMDATA%\arkode\keys\` previously just inherited ProgramData's own
 * default ACL (BUILTIN\Users get Read there), which OpenSSH's client
 * refuses outright ("Permissions ... are too open ... This private key
 * will be ignored"). `fs.writeFileSync(path, data, { mode: 0o600 })` —
 * already tried in importConfig.ts's key-restore path — does NOT fix this:
 * Node's `mode` option on Windows only toggles the read-only file
 * attribute, it has no effect on the real NTFS DACL that OpenSSH checks.
 *
 * The three grants below were modeled directly on a real, already
 * OpenSSH-accepted key on this dev machine (`ssh-keygen`'s own output),
 * confirmed by hand via `icacls`: Administrators (Full), SYSTEM (Full),
 * and the owning user (Modify) — nothing else:
 * - The current user: whoever is running arkode's UI/CLI process at the
 *   moment a transport is created/imported — always a real interactive
 *   Windows account, never SYSTEM (transport creation is a human-driven
 *   action, unlike a scheduled `run-due`).
 * - SYSTEM: every Windows Scheduled Task this app registers runs as
 *   SYSTEM (`taskDefinitionXml.ts`'s well-known SID `S-1-5-18`), so an
 *   unattended scheduled run needs to read the key too.
 * - Administrators: so whoever manages this machine can still inspect or
 *   replace the file without first having to take ownership of it.
 *
 * Windows-only by nature (NTFS ACLs, OpenSSH's Windows-specific
 * permission check) — a no-op everywhere else, including this repo's own
 * Linux CI runner, so it's safe to call unconditionally from anywhere.
 */
export async function hardenKeyFileAcl(filePath: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await execFileAsync('icacls.exe', buildIcaclsArgs(filePath));
}

/**
 * Synchronous sibling of hardenKeyFileAcl, same behavior — for the one call
 * site (config/importConfig.ts's key-restore path) where propagating async
 * through the whole import call chain (and every existing test that already
 * calls it synchronously) would be a much larger, unrelated ripple than
 * fixing the actual bug requires. `icacls` on one small key file is
 * near-instant, so blocking briefly here is a non-issue.
 */
export function hardenKeyFileAclSync(filePath: string): void {
  if (process.platform !== 'win32') return;
  execFileSync('icacls.exe', buildIcaclsArgs(filePath));
}

export interface HardenAllKeyFilesResult {
  hardened: string[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Sweeps every `*.key` file already sitting in the key store and re-applies
 * hardenKeyFileAcl — for keys copied/restored before this fix existed,
 * which are still sitting with ProgramData's overly-broad inherited ACL.
 * Meant to be called once at app startup (see engine-cli's context.ts),
 * not as a one-off migration command: idempotent (re-running it on an
 * already-hardened key is a harmless no-op) and cheap (icacls on a
 * handful of small key files is near-instant), so there's no real cost to
 * just always re-checking on every startup rather than tracking "have I
 * already migrated" state anywhere.
 *
 * One file's failure never aborts the sweep — same "one failure can't
 * block everything else" principle used throughout this app (e.g.
 * runDueTasks) — the caller decides what to do with `errors` (engine-cli
 * logs a warning, doesn't crash startup over it).
 */
export async function hardenAllKeyFilesIn(dir: string): Promise<HardenAllKeyFilesResult> {
  const result: HardenAllKeyFilesResult = { hardened: [], errors: [] };
  if (process.platform !== 'win32') return result;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result; // keys dir doesn't exist yet — nothing to migrate.
  }

  for (const entry of entries.filter((name) => name.endsWith('.key'))) {
    const filePath = join(dir, entry);
    try {
      await hardenKeyFileAcl(filePath);
      result.hardened.push(filePath);
    } catch (err) {
      result.errors.push({ file: filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * Convenience wrapper over hardenAllKeyFilesIn(keysDir()) — keeps the real
 * app-data key store's path resolution inside engine-core, matching how
 * engine-cli never constructs paths.ts paths directly itself elsewhere.
 * Meant to be called once at engine-cli startup, before any command runs.
 */
export async function hardenExistingKeyStore(): Promise<HardenAllKeyFilesResult> {
  return hardenAllKeyFilesIn(keysDir());
}
