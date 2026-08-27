-- remote_dump can now target a database running inside a Docker container
-- (e.g. Coolify-managed Postgres/MySQL/MariaDB), not just a binary on the
-- host — see remoteDumpExecutor.ts's docker-mode dispatch. Defaulting
-- remote_dump_exec_mode to 'host' preserves every existing task's behavior
-- exactly (including remote_command, which stays host-mode-only and
-- untouched by this migration).
ALTER TABLE backup_tasks ADD COLUMN remote_dump_exec_mode TEXT NOT NULL DEFAULT 'host' CHECK (remote_dump_exec_mode IN ('host','docker'));

-- The following four are docker-mode only (NULL for every host-mode task,
-- validated at the app level in tasksRepo.ts — same "app-level invariant,
-- not a portable cross-table CHECK" precedent already used for
-- strategy/transport-type matching above).
ALTER TABLE backup_tasks ADD COLUMN docker_container TEXT;
ALTER TABLE backup_tasks ADD COLUMN remote_dump_database TEXT;
ALTER TABLE backup_tasks ADD COLUMN remote_dump_db_user TEXT;
-- Optional even in docker mode: a Postgres container's pg_dump commonly
-- needs no password at all (trust/peer auth over its own unix socket), so
-- this is genuinely nullable, not just "not yet set" — see
-- remoteDumpExecutor.ts's docker-mode command builder.
ALTER TABLE backup_tasks ADD COLUMN remote_dump_db_password_secret_ref TEXT;
