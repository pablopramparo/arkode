# arkode

**arkode** is a local, internal Windows desktop app that centralizes database and file backups across multiple clients/servers: it connects to remote servers, fetches or generates DB dumps (or backs up whole folders), stores them locally, validates them, applies retention, and shows status clearly — a real deployment tool, not server administration or a general monitoring product.

Core pipeline: **connect → fetch/generate backup → store locally → validate → apply retention → show status.**

## Features

- Three DB-backup strategies: fetch an existing remote dump over SFTP/FTP, run a remote command over SSH and download the result, or connect directly to PostgreSQL/MySQL/MariaDB and dump locally.
- File backups (restic-backed, one repository per client): back up a local folder, or a remote folder over SFTP/FTP, with deduplicated snapshots — a parallel domain to the DB strategies, its own schedule and retention, managed from a client's "Archivos" tab.
- Retention policies (by count, by age, or both) per client or per task — plus manual deletion of one specific backup/snapshot, overridable past retention's own guardrails with a confirmation prompt.
- Backup sets — an optional visual label grouping related tasks (e.g. a site's database + its uploads folder) across both backup domains, purely for reporting; no shared schedule or aggregate run.
- Windows Task Scheduler integration — backups run unattended, as `SYSTEM`, even with the app closed.
- Connection testing, and configuration export/import between machines.
- A version-aware tool registry for `pg_dump`/`mysqldump`/`mariadb-dump`, plus a pre-flight compatibility gate before enabling a schedule.
- A native Windows desktop app (Tauri) wrapping the full dashboard/clients/tasks/history/logs UI, with auto-update and autostart.

## Project structure

This is a pnpm workspace:

- `packages/engine-core` — the backup engine: SQLite storage, transports (SFTP/SSH/FTP), database dump clients, file backups (restic-backed), validators, retention, scheduling. Pure TypeScript, no UI dependency.
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
