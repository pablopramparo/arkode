-- Live per-run progress, written as JSON while a run executes and polled by
-- the UI (see RunProgress in types.ts). The DB is the only channel that
-- works for both a manual "Ejecutar ahora" (runs inside the serve process)
-- and a scheduled run (runs in the arkode-scheduler service process).
--
-- Plain ADD COLUMN on both run tables in one file (mirrors 0009's two-table
-- pattern) — nullable, no CHECK, nothing to backfill, no rebuild.
ALTER TABLE backup_runs ADD COLUMN progress TEXT;
ALTER TABLE file_backup_runs ADD COLUMN progress TEXT;
