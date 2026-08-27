/** Wraps a value in single quotes for a POSIX shell, escaping any embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
