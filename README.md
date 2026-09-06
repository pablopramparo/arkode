# arkode

**arkode** is a local, internal Windows desktop app that centralizes database and file backups across multiple clients/servers: it connects to remote servers, fetches or generates DB dumps (or backs up whole folders), stores them locally, validates them, applies retention, and shows status clearly — a real deployment tool, not server administration or a general monitoring product.

Core pipeline: **connect → fetch/generate backup → store locally → validate → apply retention → show status.**

## Features

- Three DB-backup strategies: fetch an existing remote dump over SFTP/FTP, run a remote command over SSH and download the result, or connect directly to PostgreSQL/MySQL/MariaDB and dump locally.
- File backups (restic-backed, one repository per client): back up a local folder, or a remote folder over SFTP/FTP, with deduplicated snapshots — a parallel domain to the DB strategies, its own schedule and retention, managed from a client's "Repositorio" tab.
- Retention policies (by count, by age, or both) per client or per task — plus manual deletion of one specific backup/snapshot, overridable past retention's own guardrails with a confirmation prompt.
- Backup sets — an optional visual label grouping related tasks (e.g. a site's database + its uploads folder) across both backup domains, purely for reporting; no shared schedule or aggregate run.
- Unattended execution via a dedicated Windows service (`arkode-scheduler`, `LocalSystem`) — backups run with the app closed, with no per-task UAC; schedule edits are picked up on the next tick.
- Off-site replication (opt-in, per client and per content kind) to Google Drive, SFTP or FTP via a bundled `rclone`, running after a successful backup — never touching the backup engine itself.
- Encrypted credential vault + project knowledge: SSH keys / DB passwords / API tokens / logins, plus URLs, snippets, processes and notes per client, all encrypted behind one master password (scrypt + AES-256-GCM); metadata stays searchable while locked. A vault credential can own the connection a backup job uses, with a machine-bound operational copy kept in sync.
- Portable disaster-recovery backup (`.arkvault`): one encrypted file with every operational definition and secret needed to rebuild Arkode on a fresh machine — written to a local folder and/or uploaded to Google Drive. Fresh install + latest `.arkvault` + master password = Arkode operational, with no dependency on already having Drive access.
- Connection testing, and configuration export/import between machines (deliberately secret-free — distinct from `.arkvault`).
- A version-aware tool registry for `pg_dump`/`mysqldump`/`mariadb-dump` (with optional auto-download for Postgres/MariaDB), plus a pre-flight compatibility gate before enabling a schedule.
- Live run progress bars for both DB dumps and restic file backups.
- A native Windows desktop app (Tauri) wrapping the full UI (Dashboard · Clientes · Logs · Ayuda · Configuración, plus a per-client workspace), with an in-app "Ayuda" guide, auto-update and autostart.

## Project structure

This is a pnpm workspace:

- `packages/engine-core` — the backup engine: SQLite storage, transports (SFTP/SSH/FTP), database dump clients, file backups (restic-backed), validators, retention, scheduling, off-site replication (rclone), and the encrypted vault + `.arkvault` disaster-recovery backup. Pure TypeScript, no UI dependency.
- `packages/engine-cli` — a `commander` CLI wrapping `engine-core`, plus a dev-time local HTTP bridge for the UI.
- `packages/ui` — the React + TypeScript + Tailwind + HeroUI dashboard.
- `packages/desktop-shell` — the Tauri desktop shell wrapping `packages/ui` into a native Windows app, with the compiled `engine-cli` running as a sidecar in production.

## Development

```
pnpm install

# Build the backend
pnpm --filter engine-core build
pnpm --filter engine-cli build

# Run the backend test suite
pnpm --filter engine-core test

# Run the CLI
node packages/engine-cli/dist/index.js <command>

# UI dev server (needs the CLI's dev-time HTTP bridge running first)
pnpm --filter engine-cli exec node dist/index.js serve --port 4287
pnpm --filter ui dev

# Desktop app in dev mode
pnpm --filter desktop-shell dev

# Production installer (NSIS + MSI)
pnpm --filter desktop-shell build
```

See [CLAUDE.md](./CLAUDE.md) for the full architecture, command reference, and detailed history of every implemented feature.

## License

Internal tool, proprietary. Not for external distribution.
