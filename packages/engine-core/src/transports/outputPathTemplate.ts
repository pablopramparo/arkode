import { shellQuote } from './shellQuote.js';

/**
 * Resolves the `{date:FORMAT}` token in a remote_output_path_template, e.g.
 * "/tmp/backups/winners_{date:YYYYMMDD_HHmm}.dump". Deliberately minimal —
 * every literal part of the path (database name, prefix, extension) is
 * typed by whoever configures the transport, not templated, since a single
 * transport corresponds to a single known task.
 *
 * Supported format tokens: YYYY, MM, DD, HH, mm, ss.
 */
export function resolveOutputPathTemplate(template: string, now: Date = new Date()): string {
  return template.replace(/\{date:([^}]+)\}/g, (_match, format: string) => formatDate(format, now));
}

/**
 * Substitutes the `{outputPath}` placeholder in a host-mode remote_dump
 * command with the exact remote path arkode already resolved from
 * `remoteOutputPathTemplate` (shell-quoted, so a path with spaces/metachars
 * is safe as one argument).
 *
 * This is the single-source-of-truth mechanism: with `{outputPath}` in the
 * command, arkode resolves the date token *once* and both writes to and
 * looks for that exact path. Without it, a command that re-derives the name
 * with its own `$(date ...)` can disagree with what arkode expects — clock
 * drift between the two machines, a dump that crosses a minute boundary
 * mid-run, or simply a different strftime spelling — and the download then
 * fails with a bare "No such file". A command with no placeholder is
 * returned unchanged, so pre-existing tasks are unaffected.
 */
export function applyRemoteCommandOutputPath(command: string, resolvedRemotePath: string): string {
  return command.replace(/\{outputPath\}/g, shellQuote(resolvedRemotePath));
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function formatDate(format: string, now: Date): string {
  return format
    .replace(/YYYY/g, String(now.getFullYear()))
    .replace(/MM/g, pad(now.getMonth() + 1))
    .replace(/DD/g, pad(now.getDate()))
    .replace(/HH/g, pad(now.getHours()))
    .replace(/mm/g, pad(now.getMinutes()))
    .replace(/ss/g, pad(now.getSeconds()));
}
