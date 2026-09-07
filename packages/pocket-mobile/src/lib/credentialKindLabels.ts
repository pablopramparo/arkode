import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { PocketCredentialKind } from 'pocket-shared';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

/**
 * Human-readable labels + a representative Ionicons glyph (outline family,
 * monochrome — rendered in a single neutral color by every caller, never a
 * distinct color per kind) for each `PocketCredentialKind` — Pocket must
 * never show internal identifiers like `generic_login` or `web_panel`
 * directly to a user (see the app's own UX pass notes). No equivalent
 * mapping exists anywhere in the repo today (the Desktop UI never needed
 * one — it edits credentials via a form with a dropdown, not a read-only
 * list), so this is a new, small, presentation-only table — it does not
 * touch the shared `PocketCredentialKind` type/schema at all, purely how
 * Pocket's own UI renders an existing value.
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

const ICONS: Record<PocketCredentialKind, IoniconName> = {
  ssh: 'terminal-outline',
  sftp: 'server-outline',
  ftp: 'server-outline',
  postgres: 'file-tray-stacked-outline',
  mysql: 'file-tray-stacked-outline',
  mariadb: 'file-tray-stacked-outline',
  smtp: 'mail-outline',
  http_basic: 'key-outline',
  web_panel: 'globe-outline',
  api: 'code-slash-outline',
  oauth_client: 'key-outline',
  generic_login: 'person-outline',
  generic_secret: 'key-outline',
  ssh_key: 'key-outline',
  custom: 'key-outline',
};

export function credentialKindLabel(kind: PocketCredentialKind): string {
  return LABELS[kind] ?? kind;
}

export function credentialKindIcon(kind: PocketCredentialKind): IoniconName {
  return ICONS[kind] ?? 'key-outline';
}
