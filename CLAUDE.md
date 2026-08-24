# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

[project.md](project.md) is a Spanish-language product/technical spec for a Windows desktop app called **Codebius Backup Manager**. Treat it as the source of truth for requirements; this file summarizes and updates it so you don't have to re-read it in full each session, but re-check `project.md` directly for exact wording/edge cases before making product decisions.

A pnpm workspace now exists with two implemented packages — `packages/engine-core` (the backup engine, pure TypeScript, zero UI dependency) and `packages/engine-cli` (a commander CLI wrapping it). **All three backup strategies are implemented** and verified end-to-end against real local targets (Windows OpenSSH Server for the first two; real local PostgreSQL 18 and MySQL/WAMP 9.1 instances for the third, with a full dump→restore→data-matches round trip): **`fetch_existing`** (SFTP: detect an existing remote dump → download → validate → record), **`remote_dump`** (SSH: run a configured remote command to generate the dump → download → optionally delete the remote file → validate → record), and **`direct_dump`** (connect straight to Postgres/MySQL from this PC with SecretStore-held credentials, run `pg_dump`/`mysqldump` locally → validate → record). Verified behaviors include host-key confirmation, incremental checksumming, `.part`-then-rename handling, no redundant re-downloads (fetch_existing), correct nonzero-exit-code/auth-failure handling (all three), interrupted-run recovery, and the app-level concurrency lock. Retention enforcement is also implemented (see "Retention" below), `engine-core` has an automated vitest suite (see "Automated tests" below) covering the orchestrator and retention logic with fakes/real-temp-filesystem, every connection type (SFTP/SSH/Postgres/MySQL) can be tested without producing a download or dump (see "Connection testing" below), and client configuration can be exported/imported as portable JSON, secrets deliberately excluded (see "Configuration export/import" below). The manual end-to-end runs against real infrastructure remain the standard for the transport/dump-client adapters themselves. `packages/ui` and `packages/desktop-shell` (Tauri) do not exist yet — see "Not yet built" below.

## Commands

```
pnpm install                      # from repo root
pnpm --filter engine-core build   # tsc -b + copies migrations/*.sql into dist/
pnpm --filter engine-cli build    # tsc -b (depends on engine-core's build output)
pnpm -r build                     # build both

pnpm --filter engine-core test    # vitest run — the only package with tests today
pnpm test                         # from repo root: pnpm -r test

# Run the CLI (from repo root, after building both packages):
node packages/engine-cli/dist/index.js <command>
#   migrate | client:create | transport:create-sftp | transport:create-ssh
#   | database-connection:create | task:create [--strategy fetch_existing|remote_dump|direct_dump]
#   [--retention-count <n>] [--retention-days <n>]
#   | task:run <taskId> | task:test-connection <taskId>
#   | transport:test <transportId> | database-connection:test <databaseConnectionId>
#   | client:test-connections <clientId>
#   | config:export [--client <id> (repeatable) | --all] [--output <file>]
#   | config:import --file <path>
#   | retention:history <taskId> | status [--json]
```

`direct_dump` tasks also need `PG_DUMP_PATH` (for `dbEngine: postgres`) and/or `MYSQLDUMP_PATH` (for `dbEngine: mysql`) env vars pointing at local `pg_dump.exe`/`mysqldump.exe` — same dev-time pattern as `PG_RESTORE_PATH` for validation, no installer-vendoring yet. Connection testing (`transport:test`/`database-connection:test`/`client:test-connections`/`task:test-connection` on a direct_dump task) needs `PSQL_PATH`/`MYSQL_CLI_PATH` similarly — these are the interactive/batch client binaries (`psql.exe`/`mysql.exe`), bundled alongside `pg_dump`/`mysqldump` but distinct from them; a trivial `SELECT 1` verifies connectivity + auth without producing a dump.

`CODEBIUS_APP_DATA_DIR` overrides where the engine reads/writes its SQLite DB and logs (normally `%APPDATA%\CodebiusBackupManager\`) — set it to a throwaway directory for manual CLI testing so you never touch the real app-data location.

## Automated tests

`packages/engine-core/test/` (vitest, run via `pnpm --filter engine-core test`). Real SQLite (in-memory, via `test/helpers/testContext.ts`, which mirrors `engine-cli`'s `buildContext()`) and real temp directories (`test/helpers/tempDir.ts`) throughout — no mocking of the DB or filesystem. What's covered:

- **`retention/applyRetention.spec.ts`** — the highest-value suite: count-based, days-based, and combined-policy pruning; the two hard invariants (never delete without a later real backup, never go to zero); and dedicated regression tests for the two real bugs found while building retention (duplicate deletion records on repeated passes; no-op Success runs defeating the survivor floor — see the "Retention" section above).
- **`orchestrator/runBackupTask.spec.ts`** — the core pipeline (success, checksum fallback, `NoNewDumpAvailableError` handling, validation/empty-file failure, the app-level concurrency lock, stale-run recovery, orphaned `.part` cleanup, retention wiring) using a fake `BackupStrategyExecutor` injected via `RunBackupTaskDeps.resolveExecutorOverride` — a seam that exists **only** for this purpose; production code never sets it. Real transports/SSH/SFTP/DB connections are deliberately not exercised here (that's what the manual end-to-end testing against real local targets, described throughout this file, is for) — this suite is about the orchestrator's own logic, strategy-agnostic.
- **`transports/hostKeyVerification.spec.ts`**, **`transports/outputPathTemplate.spec.ts`**, **`validators/genericValidator.spec.ts`**, **`db/repositories/tasksRepo.spec.ts`** — smaller focused suites for host-key trust logic, the date-token template resolver, minimum-bar file validation, and the strategy/transport/database-connection type invariants.
- **`config/exportImportConfig.spec.ts`** — export/import round-tripping, the name-collision failure path, and a hand-built malformed export (a task referencing a transport name that doesn't exist) to confirm per-item errors don't abort the rest of the client's import.

Not covered by automated tests, and not planned to be without a real (or realistically faked) SFTP/SSH/Postgres/MySQL server: the transport/dump-client adapters themselves (`sftpAdapter.ts`, `sshAdapter.ts`, `postgresDumpClient.ts`, `mysqlDumpClient.ts`) and the strategy executors that wire them up (`fetchExistingExecutor.ts`, `remoteDumpExecutor.ts`, `directDumpExecutor.ts`) — those are validated by the manual end-to-end runs against real infrastructure documented in this file's history, which remains the standard for verifying any change to them. `engine-cli` has no tests of its own yet.

Building this test suite found one more real (minor) bug, now fixed: `postgresCustomValidator`'s "PG_RESTORE_PATH not configured" branch populated only `warnings`, not `details` — so a `Failed` run's `error_message` showed a generic "Validation failed." instead of the actual reason. Every other failure branch in that validator already set `details`; this one was just missed.

## What this app does

A local, internal, "extremely reliable" tool that centralizes database backups across multiple clients/servers. Core pipeline:

**connect to servers → fetch DB backups → store locally → validate → apply retention → show status clearly.**

It is explicitly **not** responsible for server administration or deploys. Scope is deliberately narrow — do not add these until asked (they're called out in the spec as out of scope for v1): file/upload backups, S3, FTP, Google Drive, full automatic restore, VPS administration, general server monitoring, external notifications, multi-user support, cloud sync, mobile app. Adapters should still be designed so these can be added later without rewriting the engine — but don't pre-build them.

## Mandated development approach (per project.md "Primera etapa")

The spec explicitly says: **do not build the whole app at once**, and the user wants to be **contradicted** when a technical decision in the spec doesn't hold up, not just agreed with. This governed the architecture phase (already done — see "Architecture" below) and still governs what comes next: **no feature beyond the currently-agreed increment without explicitly checking in first.** All three backup strategies, retention, an automated test suite for `engine-core`, connection testing, and config export/import are done; don't start on Task Scheduler registration or the GUI without asking which is next — each is a deliberate, separately-agreed increment, not a natural continuation to pick up unprompted. (This has held in practice across every increment so far — architecture, `fetch_existing`, `remote_dump`, `direct_dump`, retention, automated tests, connection testing + config export/import — each chosen via an explicit question or explicit request from the user before starting.)

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
- Avoid unnecessary dependencies. Current engine-core runtime deps: `ssh2-sftp-client` + `ssh2` (SFTP/SSH transports), `@napi-rs/keyring` (Windows Credential Manager — the maintained keytar replacement), `pino` (file logging). No new npm dependency was needed for `direct_dump` — it shells out to local `pg_dump`/`mysqldump` binaries via `node:child_process`, not a DB client library. `engine-cli` adds `commander`. Eventual packaging is expected to use `@yao-pkg/pkg` to compile `engine-cli` to a standalone exe — not done yet.

## Architecture: three separate concepts, not two

The spec originally framed this as just "connections" (SFTP/SSH), but the implemented model deliberately separates three concerns so a third strategy can be added later without reshaping the schema or the orchestrator:

- **Backup strategy** (`backup_tasks.strategy`, `BackupStrategyKind` in `engine-core/src/types.ts`): `fetch_existing` | `remote_dump` | `direct_dump`. Decides the overall pipeline shape. The orchestrator (`engine-core/src/orchestrator/runBackupTask.ts`) depends only on the `BackupStrategyExecutor` interface (`engine-core/src/strategies/types.ts`), never on a transport or DB-connection type directly.
- **Transport** (`transports` table, `engine-core/src/transports/`): `sftp` | `ssh`. How bytes move between a remote host and this PC. Used only by `fetch_existing` (sftp) and `remote_dump` (ssh).
- **Database connection** (`database_connections` table, `engine-core/src/databaseConnections/types.ts`): real DB credentials (engine, host, port, database, username, `password_secret_ref`). Used only by `direct_dump`. `fetch_existing`/`remote_dump` deliberately never need DB credentials.

Status of each strategy:

- **`fetch_existing` — implemented** (`strategies/fetchExistingExecutor.ts`, uses `transports/sftpAdapter.ts`): SFTP-only. Connect → list remote files → diff against `Success` runs by filename+size (not remote mtime — see below) → download newest candidate, hashing incrementally while streaming → return a `ProducedDump`. When nothing new is found it throws `NoNewDumpAvailableError`, which the orchestrator treats as a successful no-op run, not a `Failed` one — never surface "already up to date" as an error. Every invocation of the *next* strategy legitimately produces a fresh file, so this "already downloaded" concept is specific to `fetch_existing`.
- **`remote_dump` — implemented** (`strategies/remoteDumpExecutor.ts`, uses `transports/sshAdapter.ts` via raw `ssh2` — not `ssh2-sftp-client`, because it needs both `.exec()` and `.sftp()` on one connection): connect → run `transports.remote_command` → non-zero exit code fails the run → resolve the expected file path via `transports.remote_output_path_template` (supports a `{date:YYYYMMDD_HHmm}`-style token, resolved in `transports/outputPathTemplate.ts` — deliberately minimal, no heuristic "find the newest file" detection per the architecture plan's risk list) → download, hashing incrementally → if `transports.remote_cleanup` is set, delete the remote file **only after** a non-empty download succeeds (matches the spec's own step ordering: verify transfer, then optionally clean up). Gotcha already hit and fixed: `ssh2`'s raw `Client` is a plain `EventEmitter` — an unhandled `'error'` event (e.g. `ECONNRESET` after a rejected host key) crashes the whole process unless a permanent no-op listener is attached (see the comment in `sshAdapter.ts`); `ssh2-sftp-client` avoids this itself via a constructor `error` callback, which `sftpAdapter.ts` also sets.
- **`direct_dump` — implemented** (`strategies/directDumpExecutor.ts`, uses `databaseConnections/postgresDumpClient.ts` / `mysqlDumpClient.ts`): resolves the DB password from `SecretStore` via `database_connections.password_secret_ref`, shells out to `pg_dump --format custom` (postgres) or `mysqldump` (mysql) via `node:child_process.execFile`, writing straight to the local temp path — no transport, no download step. The DB password is passed via the `PGPASSWORD`/`MYSQL_PWD` environment variable to the child process, never as a CLI argument (argv is visible to other processes; env vars of a child process aren't). Filename is `{databaseName}_{YYYYMMDD_HHmmss}.{dump|sql}` (`.dump` for postgres, `.sql` for mysql) since there's no remote filename to reuse. **Licensing note, deliberately decided**: `mysqldump` is GPLv2 (unlike PostgreSQL's permissive license) — implemented dev-time-only via a `MYSQLDUMP_PATH` env var, same as `PG_DUMP_PATH`/`PG_RESTORE_PATH`; whether to bundle either binary into a future installer is a separate, still-open packaging decision.

**Checksum responsibility split**: `ProducedDump.checksumSha256` is optional. A strategy populates it only if it can compute SHA-256 during `produce()` at no extra read cost (`fetch_existing`/`remote_dump` do, while streaming the download). If left `undefined`, the orchestrator hashes the temp file once itself as a fallback — `direct_dump` is the real case that exercises this path, since `pg_dump`/`mysqldump` write straight to disk via subprocess redirection with no stream available to hash incrementally. Either path hashes exactly once — never twice, never on a re-run of an already-`Success` file.

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

**Implemented** (`engine-core/src/retention/applyRetention.ts`), applied by the orchestrator after every completed attempt of every strategy — regardless of that run's own outcome (an old backup can be past policy even if today's run failed), including the `fetch_existing` no-op "already up to date" case. Configurable per client (`clients.retention_count`/`retention_days`, set via `client:create --retention-count`/`--retention-days`) with an optional per-task override (`task:create --retention-count`/`--retention-days`); neither set means no retention for that task.

Two hard invariants, enforced regardless of how aggressive the configured policy is: a run is only ever a delete candidate if a **later `Success` run with an actual file** exists (the newest is never touched), and **at least one real backup always survives**. If both `count` and `days` are configured, a run must violate *both* to be deleted (the more conservative merge, not more aggressive). Every deletion is recorded in `retention_deletions` (`retention:history <taskId>` to inspect) and is skipped on all future passes via `RetentionDeletionsRepo.listDeletedRunIds` — without that exclusion, an already-pruned run gets silently re-evaluated (and re-recorded as newly "deleted," since unlinking an already-gone file just throws ENOENT) on every subsequent run forever, which is a bug that was actually hit and fixed while building this.

**Gotcha already hit and fixed, worth knowing if you touch this code**: `RunsRepo.listSuccessfulRuns` filters to `status = 'Success' AND local_path IS NOT NULL` specifically to exclude `fetch_existing`'s no-op "no new backup needed" runs (which are legitimately `Success` but have no file). Without that filter, a no-op run — which is always the *newest* row — occupies the "never touch rank 0" protection slot while having nothing to protect, which pushed the one real backup down into "older, prunable" territory and defeated the survivor-floor invariant in testing: a single real backup got deleted, leaving zero, with several no-op Success runs sitting on top of it. If `listSuccessfulRuns` or the retention algorithm's rank/day logic changes, re-verify this exact scenario (one real Success backup, several subsequent no-op Success runs, an aggressive policy) before considering it safe.

Retention only ever considers `Success` runs "valid" — `Warning`-status backups (which do have real files) are deliberately left alone entirely, not counted and never deleted, erring conservative for files a human may not have reviewed yet. The "age" used for `retention_days` is `downloaded_at` (or the equivalent local produce time for `direct_dump`), never `remote_modified_at` — see the remote-mtime trust caveat elsewhere in this file.

## Connection testing

**Implemented** — spec's "Probar conexión" requirement, extended to cover all three strategies without ever producing a dump/download:

- **SFTP/SSH transports**: `TransportAdapter.testConnection()` (already existed) — connect, list/`echo`, disconnect. Exposed directly via `transport:test <transportId>`, or per-task via `task:test-connection <taskId>`.
- **Database connections** (`direct_dump`, new): `databaseConnections/testDatabaseConnection.ts` resolves the password from `SecretStore` and dispatches to `postgresConnectionTester.ts` (`psql --command "SELECT 1"`) or `mysqlConnectionTester.ts` (`mysql --execute "SELECT 1"`) — a trivial query that proves connectivity + auth without invoking `pg_dump`/`mysqldump` at all. Dev-time binary paths via `PSQL_PATH`/`MYSQL_CLI_PATH` env vars (distinct from `PG_DUMP_PATH`/`MYSQLDUMP_PATH` — different binaries, same bin directory). Exposed via `database-connection:test <id>`, and `task:test-connection` now dispatches to this automatically for `direct_dump` tasks (closing the gap this file used to note here).
- **Client-level aggregate**: `client:test-connections <clientId>` runs every transport's and every database connection's test for that client in one shot and reports each result — this is the direct answer to "test a client's connection without downloading backups/dumps."

Both transport and database-connection testers return the same `ConnectionTestResult` shape (`{ ok, message, latencyMs? }`), reused rather than duplicated.

## Configuration export/import

**Implemented** (`engine-core/src/config/`) — `config:export [--client <id>... | --all] [--output <file>]` and `config:import --file <path>`.

**Secrets are never exported**, by design: SSH key passphrases and DB passwords live only in Windows Credential Manager on the machine that created them, and a `secret_ref` exported to a portable file would be meaningless (or a real risk) elsewhere. Exported transports/database connections carry `hasPassphrase`/`hasPassword` booleans instead of any secret value or ref. After import, `ImportConfigResult.secretsNeedingReentry` lists (in plain language) every transport/database connection that needs its secret set again via the normal `--passphrase`/`--password` flags — this is a real, expected step in the import workflow, not an oversight.

Import **always creates new rows** — it never overwrites or merges into an existing client. A client whose name already exists fails with a clear per-client error (surfaced in that client's `errors` array) without aborting the rest of the batch; rename or remove the conflicting client first to re-import it. Within one client, transports/database connections/tasks are matched up by **name**, not by raw database id (ids are meaningless across a different SQLite file) — a task's `transportName`/`databaseConnectionName` is resolved against what was just (re-)created for that same client during the same import call.

## Scheduler

Prefer Windows Task Scheduler integration over keeping a persistent background process of our own. The UI configures a daily run time. If the PC was off during the scheduled time, consider running the missed task on next availability.

## Error handling

- A failure for one client must never stop backups for other clients — tasks are independent.
- Never silently delete partial downloads: write to a temp extension (e.g. `.part`) and rename only after transfer *and* validation succeed.
- The app must be able to recover cleanly from an interrupted run.

## Logging

Every run logs: start, connection, remote generation (if applicable), download, validation, retention application, result, duration, and the full error message on failure. Logs must exist as files in addition to SQLite records, so diagnosis is possible even if the app/DB itself is having problems.

## Not yet built

Everything below is real product scope from `project.md` but has no implementation yet — don't assume it exists, and don't build it without confirming the increment first: real Windows Task Scheduler registration (`scheduler:install`-style command doesn't exist), a GUI of any kind (`packages/ui`, `packages/desktop-shell` don't exist — Tauri hasn't been scaffolded), and packaging/distribution (no installer, no vendored `pg_dump.exe`/`pg_restore.exe`/`mysqldump.exe`, no compiled `engine-cli.exe` via `@yao-pkg/pkg`, no resolved decision on bundling GPL-licensed `mysqldump`). The CLI's `status --json` command is a primitive for a future dashboard to consume, not the dashboard itself — note it currently reports the single *latest* run per task, so a no-op "already up to date" run can show `sizeBytes`/`checksumSha256` as `null` even though a prior run has real data; a real dashboard will need to look further back for that.

## UX direction

Desktop-first only (no mobile/responsive requirement), dark mode, dense/information-first layout. The dashboard's single job is answering, in about five seconds: **do all clients have a recent, valid backup?** Problems must stand out far more visually than healthy backups.

Avoid: giant cards, decorative gradients, charts without real utility, unnecessary animation, excessive modal usage. This is an internal technical tool, not a marketing surface.

V1 screens: Dashboard, Clientes, Detalle de cliente, Conexiones, Tareas de backup, Historial, Logs, Configuración. Per-client actions: run backup now, test connection, view backups, open local folder, view last error.
