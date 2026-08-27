#!/bin/bash
# arkode-dump — root-owned wrapper for dumping a database that runs inside a
# Docker container (e.g. Coolify-managed Postgres/MySQL/MariaDB).
#
# Deployed to /usr/local/sbin/arkode-dump, owned root:root, mode 0700 — the
# restricted arkode-backup SSH user cannot read or modify this file at all;
# it can only invoke it via the narrow sudoers rule in setup.md. This is the
# real security boundary of arkode's docker-mode remote_dump: NOT `docker`
# group membership (equivalent to root on the host) and NOT a raw sudoers
# rule wildcarding `docker exec <container> *` (still lets an arbitrary
# trailing argument vector through). Every argument is validated here —
# engine against a closed list, container against an explicit allowlist
# file only root can edit — before anything is ever passed to `docker`.
#
# See README.md in this same directory for the sudoers line and allowlist
# file this script depends on.
set -euo pipefail

ALLOWLIST="/etc/arkode-dump/allowed-containers.conf"

usage() {
  echo "Usage: arkode-dump --engine postgres|mysql|mariadb --container <name> --database <db> --user <user>" >&2
  exit 2
}

ENGINE=""
CONTAINER=""
DATABASE=""
DBUSER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --database) DATABASE="$2"; shift 2 ;;
    --user) DBUSER="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$ENGINE" && -n "$CONTAINER" && -n "$DATABASE" && -n "$DBUSER" ]] || usage

case "$ENGINE" in
  postgres|mysql|mariadb) ;;
  *) echo "arkode-dump: unsupported engine '$ENGINE'" >&2; exit 3 ;;
esac

# The real security boundary: even a fully compromised arkode-backup
# account can only ever target a container explicitly pre-approved here by
# whoever administers this server — never an arbitrary one.
if [[ ! -f "$ALLOWLIST" ]] || ! grep -qxF "$CONTAINER" "$ALLOWLIST"; then
  echo "arkode-dump: container '$CONTAINER' is not in the allowlist ($ALLOWLIST)" >&2
  exit 4
fi

# Defense-in-depth, not the primary control: database/user are passed as
# argv elements to docker/pg_dump/mysqldump, never shell-interpolated, so
# injection isn't possible even without this — but a tight character class
# rules out unexpected input outright rather than trusting that alone.
[[ "$DATABASE" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "arkode-dump: invalid database name" >&2; exit 5; }
[[ "$DBUSER" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "arkode-dump: invalid database user" >&2; exit 5; }

# Optional password, read from stdin only — never from argv, so it never
# appears in `ps aux` / `/proc/*/cmdline` on this host for any process
# involved, including this wrapper's own invocation. arkode's own SSH
# client writes it (or nothing) to this process's stdin before the command
# even starts; empty stdin (immediate EOF) means "no password configured".
PASSWORD="$(cat -)"

ENV_FILE=""
cleanup() { [[ -n "$ENV_FILE" ]] && rm -f "$ENV_FILE"; }
trap cleanup EXIT

DOCKER_ARGS=(exec)
if [[ -n "$PASSWORD" ]]; then
  # --env-file reads the file client-side and sends the resulting env vars
  # to the daemon over its API — unlike `-e VAR=value`, the *value* never
  # appears in this docker CLI invocation's own argv either. Requires
  # Docker Engine 20.10+ (docker itself errors clearly if unsupported).
  install -d -m 700 /run/arkode-dump
  ENV_FILE="$(mktemp /run/arkode-dump/XXXXXX.env)"
  chmod 600 "$ENV_FILE"
  case "$ENGINE" in
    mysql|mariadb) echo "MYSQL_PWD=${PASSWORD}" > "$ENV_FILE" ;;
    postgres)      echo "PGPASSWORD=${PASSWORD}" > "$ENV_FILE" ;;
  esac
  DOCKER_ARGS+=(--env-file "$ENV_FILE")
fi
DOCKER_ARGS+=("$CONTAINER")

case "$ENGINE" in
  postgres) DOCKER_ARGS+=(pg_dump -U "$DBUSER" -d "$DATABASE" -Fc) ;;
  mysql)    DOCKER_ARGS+=(mysqldump -u"$DBUSER" "$DATABASE") ;;
  mariadb)  DOCKER_ARGS+=(mariadb-dump -u"$DBUSER" "$DATABASE") ;;
esac

# exec, not a plain call: replaces this process with docker directly (no
# extra shell layer), so its stdout (the dump bytes) flows straight back
# through sudo to whatever redirected this wrapper's own stdout — the
# calling arkode-backup shell's own `> /path/to/output` redirect, set up
# *before* sudo ever ran, using arkode-backup's own file permissions. The
# wrapper never touches the output path at all.
exec /usr/bin/docker "${DOCKER_ARGS[@]}"
