# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

[project.md](project.md) is a Spanish-language product/technical spec for a Windows desktop app called **Codebius Backup Manager**. Treat it as the source of truth for requirements; this file summarizes and updates it so you don't have to re-read it in full each session, but re-check `project.md` directly for exact wording/edge cases before making product decisions.

A pnpm workspace now exists with two implemented packages — `packages/engine-core` (the backup engine, pure TypeScript, zero UI dependency) and `packages/engine-cli` (a commander CLI wrapping it). **Only the minimal vertical slice is built**: one client → one SFTP (`fetch_existing`) connection → detect remote dump → download → validate → record → show status. It has been run end-to-end against a real local SFTP target (Windows OpenSSH Server) and verified: host-key confirmation, checksum computation, `.part`-then-rename handling, no redundant re-downloads, interrupted-run recovery, and the app-level concurrency lock all work as designed. `packages/ui` and `packages/desktop-shell` (Tauri) do not exist yet — see "Not yet built" below.

## Commands

```
pnpm install                      # from repo root
pnpm --filter engine-core build   # tsc -b + copies migrations/*.sql into dist/
pnpm --filter engine-cli build    # tsc -b (depends on engine-core's build output)
pnpm -r build                     # build both

# Run the CLI (from repo root, after building both packages):
node packages/engine-cli/dist/index.js <command>
#   migrate | client:create | transport:create | task:create
#   | task:run <taskId> | task:test-connection <taskId> | status [--json]
```

`CODEBIUS_APP_DATA_DIR` overrides where the engine reads/writes its SQLite DB and logs (normally `%APPDATA%\CodebiusBackupManager\`) — set it to a throwaway directory for manual testing so you never touch the real app-data location. There is no automated test suite yet (`vitest` is installed at the workspace root but no `*.spec.ts` files exist) — verification so far has been manual, end-to-end CLI runs against a real local SFTP target.

## What this app does

A local, internal, "extremely reliable" tool that centralizes database backups across multiple clients/servers. Core pipeline:

**connect to servers → fetch DB backups → store locally → validate → apply retention → show status clearly.**

It is explicitly **not** responsible for server administration or deploys. Scope is deliberately narrow — do not add these until asked (they're called out in the spec as out of scope for v1): file/upload backups, S3, FTP, Google Drive, full automatic restore, VPS administration, general server monitoring, external notifications, multi-user support, cloud sync, mobile app. Adapters should still be designed so these can be added later without rewriting the engine — but don't pre-build them.

## Mandated development approach (per project.md "Primera etapa")

The spec explicitly says: **do not build the whole app at once**, and the user wants to be **contradicted** when a technical decision in the spec doesn't hold up, not just agreed with. This governed the architecture phase (already done — see "Architecture" below) and still governs what comes next: **no feature beyond the current vertical slice until that slice's own scope is exhausted and a new increment is explicitly agreed.** Concretely, don't start on retention, the `remote_dump` strategy, `direct_dump`, Task Scheduler registration, or the GUI without checking that in — each is a deliberate next increment, not a natural continuation to pick up unprompted.

## Distribution constraints (non-negotiable, shape the architecture)

The end product must be a distributable Windows executable/installer for non-technical daily use:

- Produces a `.exe` and preferably a Windows installer.
- Must **not** require Node.js, npm, Rust, or any dev tooling on the target machine.
- Launches from Start Menu / shortcut like a normal app.
- Config, SQLite DB, and logs persist under AppData or a configurable directory — **never inside the install folder** (so updates don't wipe them).
- Must support future app updates without losing configuration or history.
- The backup engine must be able to run **unattended via Windows Task Scheduler even when the GUI is closed** — avoid designing this as "always keep our own background process running" if Task Scheduler integration can do it.
- Packaging must bundle or correctly resolve whatever is needed to validate dumps (e.g. `pg_restore`) — do not assume PostgreSQL is installed globally on the target machine.

## Preferred stack (propose deviations, don't silently swap)

- React + TypeScript for the UI, Tailwind CSS, HeroUI. **Not built yet.**
- Tauri as the desktop shell, if it proves adequate for the constraints above — as a "thin shell": Rust limited to boilerplate + OS-integration plugins (single-instance, shell/sidecar, dialog, opener, later autostart/updater), never business logic or direct SQLite access. **Not built yet.**
- SQLite for configuration, history, and logs — implemented via `better-sqlite3` in `engine-core` (WAL journal mode, `busy_timeout=5000`, `foreign_keys=ON`; see `db/connection.ts`).
- Backup engine logic kept separate from the UI, and runnable headless — implemented: `engine-core` has zero UI/Tauri dependency, and `engine-cli` runs it from a plain terminal.
- Avoid unnecessary dependencies. Current engine-core runtime deps: `ssh2-sftp-client` + `ssh2` (SFTP/SSH transports), `@napi-rs/keyring` (Windows Credential Manager — the maintained keytar replacement), `pino` (file logging). `engine-cli` adds `commander`. Eventual packaging is expected to use `@yao-pkg/pkg` to compile `engine-cli` to a standalone exe — not done yet.

## Architecture: three separate concepts, not two

The spec originally framed this as just "connections" (SFTP/SSH), but the implemented model deliberately separates three concerns so a third strategy can be added later without reshaping the schema or the orchestrator:

- **Backup strategy** (`backup_tasks.strategy`, `BackupStrategyKind` in `engine-core/src/types.ts`): `fetch_existing` | `remote_dump` | `direct_dump`. Decides the overall pipeline shape. The orchestrator (`engine-core/src/orchestrator/runBackupTask.ts`) depends only on the `BackupStrategyExecutor` interface (`engine-core/src/strategies/types.ts`), never on a transport or DB-connection type directly.
- **Transport** (`transports` table, `engine-core/src/transports/`): `sftp` | `ssh`. How bytes move between a remote host and this PC. Used only by `fetch_existing` (sftp) and `remote_dump` (ssh).
- **Database connection** (`database_connections` table, `engine-core/src/databaseConnections/types.ts`): real DB credentials (engine, host, port, database, username, `password_secret_ref`). Used only by `direct_dump`. `fetch_existing`/`remote_dump` deliberately never need DB credentials.

Status of each strategy:

- **`fetch_existing` — implemented** (`strategies/fetchExistingExecutor.ts`): SFTP-only. Connect → list remote files → diff against `Success` runs by filename+size (not remote mtime — see below) → download newest candidate, hashing incrementally while streaming → return a `ProducedDump`. When nothing new is found it throws `NoNewDumpAvailableError`, which the orchestrator treats as a successful no-op run, not a `Failed` one — never surface "already up to date" as an error.
- **`remote_dump` and `direct_dump` — stubs only** (`strategies/remoteDumpExecutor.ts`, `strategies/directDumpExecutor.ts`): each `produce()` throws "not implemented." They exist so the orchestrator's dispatch is real and fully typed today. Do not implement either without an explicit go-ahead — `remote_dump` needs an `SshAdapter` (interface already defined in `transports/types.ts`, no implementation); `direct_dump` needs a `DatabaseDumpClient` (interface already defined, no implementation) and will require bundling `pg_dump` locally (fine, permissive license) and, for MySQL, `mysqldump` (GPLv2 — the same bundling decision already deferred for validation resurfaces here for dump *generation*).

**Checksum responsibility split**: `ProducedDump.checksumSha256` is optional. A strategy populates it only if it can compute SHA-256 during `produce()` at no extra read cost (fetch_existing does, while streaming the SFTP download). If left `undefined`, the orchestrator hashes the temp file once itself as a fallback. Either path hashes exactly once — never twice, never on a re-run of an already-`Success` file.

**Database engine validators** (`engine-core/src/validators/`): PostgreSQL (`postgresCustomValidator.ts`, shells to `pg_restore --list` via a dev-time `PG_RESTORE_PATH` env var — proper installer-vendoring not done yet) and a generic exists/size>0 check (`genericValidator.ts`) used for everything else. No MySQL-specific validator exists yet — `dbEngine: 'mysql'` tasks currently only get the generic check.

## Security requirements

- Never store SSH private keys inside SQLite — store paths/references only.
- Never store passwords in plaintext; evaluate Windows Credential Manager for secrets.
- Never log credentials.
- Validate SSH host fingerprints; don't silently accept unknown hosts — support registering/confirming known hosts.
- Principle of least privilege: a backup user should not need root/admin on the remote server.

## Local storage layout

Conceptual path: `Backups/{cliente}/{database}/{YYYY}/{MM}/`, e.g. `D:\CodebiusBackups\Winners\postgres\2026\08\winners_2026-08-23_0300.dump`.

The filename is never the source of truth for metadata — SQLite is (`backup_runs` table). Track per backup: client, database, server, remote timestamp, download timestamp, size, hash/checksum, status, local path, method used, duration, errors.

Implementation note: the `{database}` path segment isn't a separate schema field for `fetch_existing`/`remote_dump` tasks (only `direct_dump` has a real database name, via `database_connections`), so `resolveTargetDir()` in `orchestrator/runBackupTask.ts` uses a slugified version of the task's own name instead. Revisit if that ever reads confusingly in the UI.

## Validation

A downloaded file is never automatically considered a valid backup. Minimum checks: file exists, size > 0, transfer fully completed, checksum where possible. For PostgreSQL custom-format dumps, validate with `pg_restore --list`. (Automated test-restores are a later goal, not a v1 requirement.)

Status values: `Pending`, `Running`, `Producing`, `Validating`, `Success`, `Warning`, `Failed`. (The spec originally said `Downloading` — renamed to `Producing` since it must read correctly for all three strategies, not just ones that transfer a file.)

## Retention

Configurable per client/task (e.g. keep last 30 daily backups, or keep X days). Never delete a backup before confirming valid backups exist after it. Every deletion must be recorded in history.

## Scheduler

Prefer Windows Task Scheduler integration over keeping a persistent background process of our own. The UI configures a daily run time. If the PC was off during the scheduled time, consider running the missed task on next availability.

## Error handling

- A failure for one client must never stop backups for other clients — tasks are independent.
- Never silently delete partial downloads: write to a temp extension (e.g. `.part`) and rename only after transfer *and* validation succeed.
- The app must be able to recover cleanly from an interrupted run.

## Logging

Every run logs: start, connection, remote generation (if applicable), download, validation, retention application, result, duration, and the full error message on failure. Logs must exist as files in addition to SQLite records, so diagnosis is possible even if the app/DB itself is having problems.

## Not yet built

Everything below is real product scope from `project.md` but has no implementation yet — don't assume it exists, and don't build it without confirming the increment first: retention enforcement (`retention_deletions` table exists in the schema, no code reads/writes it), the `remote_dump` and `direct_dump` strategies, real Windows Task Scheduler registration (`scheduler:install`-style command doesn't exist), a GUI of any kind (`packages/ui`, `packages/desktop-shell` don't exist — Tauri hasn't been scaffolded), and packaging/distribution (no installer, no vendored `pg_restore.exe`, no compiled `engine-cli.exe` via `@yao-pkg/pkg`). The CLI's `status --json` command is a primitive for a future dashboard to consume, not the dashboard itself — note it currently reports the single *latest* run per task, so a no-op "already up to date" run can show `sizeBytes`/`checksumSha256` as `null` even though a prior run has real data; a real dashboard will need to look further back for that.

## UX direction

Desktop-first only (no mobile/responsive requirement), dark mode, dense/information-first layout. The dashboard's single job is answering, in about five seconds: **do all clients have a recent, valid backup?** Problems must stand out far more visually than healthy backups.

Avoid: giant cards, decorative gradients, charts without real utility, unnecessary animation, excessive modal usage. This is an internal technical tool, not a marketing surface.

V1 screens: Dashboard, Clientes, Detalle de cliente, Conexiones, Tareas de backup, Historial, Logs, Configuración. Per-client actions: run backup now, test connection, view backups, open local folder, view last error.
