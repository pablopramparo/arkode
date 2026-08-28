import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DetectedToolKind =
  | 'pg_dump'
  | 'pg_restore'
  | 'psql'
  | 'mysqldump'
  | 'mysql'
  | 'mariadb-dump'
  | 'mariadb';

export interface DetectedTool {
  kind: DetectedToolKind;
  /** Absolute path to the binary. */
  path: string;
  /** Raw first line of `--version` output, or null if it couldn't be run. */
  version: string | null;
  /** Parsed "major" (Postgres) or "major.minor" (MySQL/MariaDB), or null. */
  majorMinor: string | null;
}

const EXE_BY_KIND: Record<DetectedToolKind, string> = {
  pg_dump: 'pg_dump.exe',
  pg_restore: 'pg_restore.exe',
  psql: 'psql.exe',
  mysqldump: 'mysqldump.exe',
  mysql: 'mysql.exe',
  'mariadb-dump': 'mariadb-dump.exe',
  mariadb: 'mariadb.exe',
};

/** Fixed Windows drive letters worth probing for portable stacks (WAMP/XAMPP/Laragon). */
const DRIVE_LETTERS = ['C', 'D', 'E', 'F'];

/**
 * Directories to look in for `bin/` folders. A `*` segment means "every
 * immediate subdirectory" (for versioned install roots like
 * `PostgreSQL\17\bin` or `wamp64\bin\mysql\mysql9.1.0\bin`).
 */
function candidateBinDirs(): string[] {
  const dirs: string[] = [];
  const pf = process.env['ProgramFiles'];
  const pf86 = process.env['ProgramFiles(x86)'];

  for (const base of [pf, pf86].filter((x): x is string => Boolean(x))) {
    dirs.push(...expandGlob(join(base, 'PostgreSQL', '*', 'bin')));
    dirs.push(...expandGlob(join(base, 'MySQL', '*', 'bin')));
    dirs.push(...expandGlob(join(base, 'MariaDB *', 'bin')));
    dirs.push(...expandGlob(join(base, 'MariaDB', '*', 'bin')));
  }

  for (const drive of DRIVE_LETTERS) {
    const root = `${drive}:\\`;
    for (const wamp of ['wamp64', 'wamp']) {
      dirs.push(...expandGlob(join(root, wamp, 'bin', 'mysql', '*', 'bin')));
      dirs.push(...expandGlob(join(root, wamp, 'bin', 'mariadb', '*', 'bin')));
    }
    dirs.push(join(root, 'xampp', 'mysql', 'bin'));
    dirs.push(...expandGlob(join(root, 'laragon', 'bin', 'mysql', '*', 'bin')));
    dirs.push(...expandGlob(join(root, 'laragon', 'bin', 'mariadb', '*', 'bin')));
  }

  return [...new Set(dirs)].filter((d) => safeIsDir(d));
}

/** Expands a single trailing-or-mid `*` path segment against the real filesystem. */
function expandGlob(pattern: string): string[] {
  const star = pattern.indexOf('*');
  if (star === -1) return [pattern];
  // Split on the path separator around the * segment.
  const sepBefore = Math.max(pattern.lastIndexOf('\\', star), pattern.lastIndexOf('/', star));
  const sepAfter = (() => {
    const a = pattern.indexOf('\\', star);
    const b = pattern.indexOf('/', star);
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  })();
  const parent = pattern.slice(0, sepBefore);
  const segment = pattern.slice(sepBefore + 1, sepAfter === -1 ? undefined : sepAfter);
  const rest = sepAfter === -1 ? '' : pattern.slice(sepAfter + 1);
  if (!safeIsDir(parent)) return [];
  const re = new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries.filter((e) => re.test(e)).map((e) => (rest ? join(parent, e, rest) : join(parent, e)));
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseMajorMinor(kind: DetectedToolKind, versionLine: string | null): string | null {
  if (!versionLine) return null;
  if (kind === 'pg_dump' || kind === 'pg_restore' || kind === 'psql') {
    // "pg_dump (PostgreSQL) 17.2" | "... 9.6.24"
    const m = versionLine.match(/\)\s+(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]);
    return major >= 10 ? String(major) : `${m[1]}.${m[2] ?? '0'}`;
  }
  // mysqldump/mysql/mariadb: "... Ver 8.0.36 for Win64" | "... from 11.4.4-MariaDB, client 10.19 ..."
  const m = versionLine.match(/(?:Ver|from)\s+(\d+)\.(\d+)/i) ?? versionLine.match(/(\d+)\.(\d+)\.\d+/);
  return m ? `${m[1]}.${m[2]}` : null;
}

async function readVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ['--version'], { timeout: 4000 });
    const line = (stdout || stderr).split(/\r?\n/).find((l) => l.trim().length > 0);
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Scans the usual Windows install locations (Program Files PostgreSQL/MySQL/
 * MariaDB, plus WAMP/XAMPP/Laragon portable stacks) for `pg_dump`/`psql`/
 * `mysqldump`/`mysql`/`mariadb-dump`/`mariadb`, runs each with `--version`,
 * and returns what it found — so the Configuración screen can offer a
 * "detect installed tools" list instead of making someone type paths. Pure
 * filesystem + child-process, no side effects.
 *
 * `extraRoots` are additional `bin/` directories to probe (also used by the
 * tests to point at a fake tree).
 */
export async function detectInstalledDbTools(opts?: { extraRoots?: string[] }): Promise<DetectedTool[]> {
  const binDirs = [...candidateBinDirs(), ...(opts?.extraRoots ?? []).filter((d) => safeIsDir(d))];
  const seen = new Set<string>();
  const found: { kind: DetectedToolKind; path: string }[] = [];

  for (const dir of binDirs) {
    for (const [kind, exe] of Object.entries(EXE_BY_KIND) as [DetectedToolKind, string][]) {
      const full = join(dir, exe);
      if (!existsSync(full)) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, path: full });
    }
  }

  return Promise.all(
    found.map(async ({ kind, path }) => {
      const version = await readVersion(path);
      return { kind, path, version, majorMinor: parseMajorMinor(kind, version) };
    })
  );
}

/** Exported for unit testing the version parsing in isolation. */
export const __test = { parseMajorMinor, expandGlob };
