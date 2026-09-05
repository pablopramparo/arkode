/**
 * Conservative, shape-based redaction for strings that are about to be
 * persisted to the logs (`log_events` rows and the daily `.log` file).
 *
 * This is DEFENSE IN DEPTH, not the security boundary. Credentials are
 * already kept out of process argv (env vars / stdin only) and never stored
 * in plaintext SQLite. The job here is narrow: catch a secret that slipped
 * into a tool's stderr, a connection string, an `Authorization:` header, or
 * a `password=` fragment inside an error message.
 *
 * Deliberately does NOT redact bare "long hex / base64 runs": SHA-256
 * checksums, `SHA256:` host-key fingerprints, UUIDs and restic snapshot ids
 * are all long and hex/base64 and must stay readable for diagnosis. Only
 * well-defined secret SHAPES are matched, plus any exact values the caller
 * passes in `knownSecrets` (structured redaction at the source, when Arkode
 * itself holds a value it knows is a secret).
 */

const REDACTED = '[redacted]';

// A secret value runs up to the next whitespace, quote, or closing
// bracket/list punctuation — so `(password=x)` redacts `x`, not `x)`.
const VALUE = "[^\\s\"'`)\\];,]+";

// scheme://user:PASSWORD@host  ->  keep everything but the password.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi;

// Known secret-bearing environment variables, by exact name. `\bpassword`
// deliberately does not match inside `PGPASSWORD`, so these are spelled out.
const ENV_SECRETS = new RegExp(
  `\\b(PGPASSWORD|MYSQL_PWD|MARIADB_PWD|RESTIC_PASSWORD|RESTIC_PASSWORD_FILE|RCLONE_[A-Z0-9_]*PASS(?:WORD)?)\\s*[=:]\\s*(${VALUE})`,
  'g'
);

// key=value / key: value for a small, explicit keyword set.
const ASSIGNMENTS = new RegExp(
  `\\b(password|passwd|passphrase|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|token)\\s*[=:]\\s*(${VALUE})`,
  'gi'
);

// Explicit password-bearing CLI flags. Never bare `-p` — that is the port
// flag for `pg_dump`/`psql`.
const PASSWORD_FLAGS = new RegExp(
  `(--(?:password|key-file-pass|crypt-password|ssl-key-pass))(?:\\s*=\\s*|\\s+)(${VALUE})`,
  'gi'
);

// Authorization: Bearer <token> / Basic <base64> / Digest ...
const AUTH_HEADER = new RegExp(
  `\\b((?:proxy-)?authorization)\\s*:\\s*(bearer|basic|digest)\\s+(${VALUE})`,
  'gi'
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts secret-shaped fragments (and any exact `knownSecrets`) from a log
 * message. Returns the input unchanged when nothing matches.
 */
export function redactSecrets(message: string, knownSecrets?: readonly string[]): string {
  if (!message) return message;
  let out = message;

  if (knownSecrets) {
    for (const secret of knownSecrets) {
      // Skip trivially short values: replacing "a"/"12" everywhere would
      // mangle unrelated text and leak nothing meaningful.
      if (typeof secret === 'string' && secret.trim().length >= 4) {
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
      }
    }
  }

  // Order matters: handle the `--flag value` shape before the bare
  // `key=value` one, so `--password=x` is rewritten once (to the space
  // form) rather than twice (which would leave a stray bracket from the
  // first pass's `[redacted]`).
  out = out.replace(URL_CREDENTIALS, (_m, prefix: string) => `${prefix}:${REDACTED}@`);
  out = out.replace(PASSWORD_FLAGS, (_m, flag: string) => `${flag} ${REDACTED}`);
  out = out.replace(ENV_SECRETS, (_m, name: string) => `${name}=${REDACTED}`);
  out = out.replace(ASSIGNMENTS, (_m, key: string) => `${key}=${REDACTED}`);
  out = out.replace(AUTH_HEADER, (_m, header: string, scheme: string) => `${header}: ${scheme} ${REDACTED}`);

  return out;
}
