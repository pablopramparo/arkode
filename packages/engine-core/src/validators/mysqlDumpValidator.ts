import { open } from 'node:fs/promises';
import type { DumpValidator, ValidationResult } from './types.js';

const HEAD_BYTES = 512;
const TAIL_BYTES = 512;

const HEADER_MARKERS = ['-- MySQL dump', '-- MariaDB dump'];
const COMPLETION_MARKER = '-- Dump completed on';

async function readHead(filePath: string, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(filePath: string, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const readLength = Math.min(length, size);
    const start = size - readLength;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, start);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Structural validation for mysqldump/mariadb-dump's plain-SQL output —
 * there's no binary format to parse the way `pg_restore --list` does for
 * Postgres, but both tools consistently write the same two textual markers
 * (confirmed by hand against this machine's real MySQL 9.1.0 and MariaDB
 * 11.5.2 instances, not assumed from docs): a `-- MySQL dump`/`-- MariaDB
 * dump` banner as the first real line, and a `-- Dump completed on <date>`
 * footer as the literal last line. That footer is the actually valuable
 * check here: it's only ever written after the tool has finished emitting
 * every table successfully, so its absence is a real, specific signal that
 * the generic exists/size>0 check can't catch — the process was killed
 * mid-dump, the disk filled up, or the connection dropped partway through,
 * all of which can still produce a large, non-empty, well-formed-looking
 * SQL prefix.
 *
 * Reads only the first/last ~512 bytes rather than the whole file, so this
 * stays cheap even for a multi-GB dump.
 */
export function createMysqlDumpValidator(): DumpValidator {
  return {
    engine: 'mysql',
    async validate(localFilePath: string): Promise<ValidationResult> {
      let head: string;
      let tail: string;
      try {
        [head, tail] = await Promise.all([readHead(localFilePath, HEAD_BYTES), readTail(localFilePath, TAIL_BYTES)]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const details = `Could not read the dump file to validate it: ${message}`;
        return { valid: false, warnings: [details], details };
      }

      if (!HEADER_MARKERS.some((marker) => head.includes(marker))) {
        const details = 'File does not start with a recognizable mysqldump/mariadb-dump header — this may not be a real dump.';
        return { valid: false, warnings: [details], details };
      }

      if (!tail.includes(COMPLETION_MARKER)) {
        const details = 'File is missing the "-- Dump completed on" footer — the dump likely didn\'t finish (killed mid-run, disk full, or connection dropped).';
        return { valid: false, warnings: [details], details };
      }

      return { valid: true, warnings: [], details: 'mysqldump/mariadb-dump header and completion footer both present.' };
    },
  };
}
