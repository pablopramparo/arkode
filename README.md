# Arkode

**Arkode** (by [Codebius](https://codebius.com)) is a local, internal Windows desktop app that centralizes database backups across multiple clients/servers: it connects to remote servers, fetches or generates DB dumps, stores them locally, validates them, applies retention, and shows status clearly — a real deployment tool, not server administration or a general monitoring product.

Core pipeline: **connect → fetch/generate backup → store locally → validate → apply retention → show status.**

## Features

- Three backup strategies: fetch an existing remote dump over SFTP, run a remote command over SSH and download the result, or connect directly to PostgreSQL/MySQL/MariaDB and dump locally.
- Retention policies (by count, by age, or both) per client or per task.
- Windows Task Scheduler integration — backups run unattended, as `SYSTEM`, even with the app closed.
- Connection testing, and configuration export/import between machines.
- A version-aware tool registry for `pg_dump`/`mysqldump`/`mariadb-dump`, plus a pre-flight compatibility gate before enabling a schedule.
- A native Windows desktop app (Tauri) wrapping the full dashboard/clients/tasks/history/logs UI.

## Project structure

This is a pnpm workspace:

- `packages/engine-core` — the backup engine: SQLite storage, transports (SFTP/SSH), database dump clients, validators, retention, scheduling. Pure TypeScript, no UI dependency.
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

Internal tool, proprietary to Codebius. Not for external distribution.
