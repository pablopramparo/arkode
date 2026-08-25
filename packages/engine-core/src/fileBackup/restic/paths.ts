/**
 * The one place in the whole codebase allowed to know restic's internal
 * Windows path syntax. Confirmed by hand against a real repository: restic
 * normalizes an absolute Windows path like `C:\Users\...\source` to
 * `/C/Users/.../source` (drive letter as a path segment, forward slashes) —
 * every `dump`/`restore --include`/`ls` call that references a path inside a
 * snapshot needs this exact form. Nothing outside resticClient.ts should ever
 * construct or parse a `/C/...`-style string directly.
 */
export function toResticPath(absoluteWindowsPath: string): string {
  const match = /^([A-Za-z]):\\(.*)$/.exec(absoluteWindowsPath);
  if (!match) {
    throw new Error(`Expected an absolute Windows path (e.g. "C:\\Users\\..."), got: "${absoluteWindowsPath}"`);
  }
  const [, drive, rest] = match;
  return `/${drive.toUpperCase()}/${rest.replace(/\\/g, '/')}`;
}

/** Inverse of toResticPath — not needed by the current increment's call sites, kept for completeness/testability of the encapsulation. */
export function fromResticPath(resticPath: string): string {
  const match = /^\/([A-Za-z])\/(.*)$/.exec(resticPath);
  if (!match) {
    throw new Error(`Expected a restic-internal path (e.g. "/C/Users/..."), got: "${resticPath}"`);
  }
  const [, drive, rest] = match;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}
