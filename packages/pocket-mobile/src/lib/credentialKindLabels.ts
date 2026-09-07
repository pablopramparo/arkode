import type { PocketCredentialKind } from 'pocket-shared';

/**
 * Human-readable labels + a representative icon glyph for each
 * `PocketCredentialKind` — Pocket must never show internal identifiers like
 * `generic_login` or `web_panel` directly to a user (see the app's own UX
 * pass notes). No equivalent mapping exists anywhere in the repo today (the
 * Desktop UI never needed one — it edits credentials via a form with a
 * dropdown, not a read-only list), so this is a new, small, presentation-only
 * table — it does not touch the shared `PocketCredentialKind` type/schema at
 * all, purely how Pocket's own UI renders an existing value.
 */
const LABELS: Record<PocketCredentialKind, string> = {
  ssh: 'SSH',
  sftp: 'SFTP',
  ftp: 'FTP',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  smtp: 'SMTP',
  http_basic: 'HTTP Basic',
  web_panel: 'Panel web',
  api: 'API',
  oauth_client: 'Cliente OAuth',
  generic_login: 'Login',
  generic_secret: 'Secreto',
  ssh_key: 'Clave SSH',
  custom: 'Personalizado',
};

const ICONS: Record<PocketCredentialKind, string> = {
  ssh: '🖥️',
  sftp: '🖥️',
  ftp: '🖥️',
  postgres: '🗄️',
  mysql: '🗄️',
  mariadb: '🗄️',
  smtp: '✉️',
  http_basic: '🔑',
  web_panel: '🌐',
  api: '🔌',
  oauth_client: '🔑',
  generic_login: '👤',
  generic_secret: '🔑',
  ssh_key: '🔑',
  custom: '🔑',
};

export function credentialKindLabel(kind: PocketCredentialKind): string {
  return LABELS[kind] ?? kind;
}

export function credentialKindIcon(kind: PocketCredentialKind): string {
  return ICONS[kind] ?? '🔑';
}
