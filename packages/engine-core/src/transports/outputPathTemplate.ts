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
